import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { openToolbarPopup } from "./action-popup";
import { completionTransitions, type WatchState } from "./completion";
import { COMPLETE_PROGRESS } from "./messages";
import { getSettings, isProxyConfigured } from "./settings";
import { getTorrent, listTorrents } from "./torrent-service";
import type { TorrentSummary } from "./torrents";

/**
 * Background completion monitor.
 *
 * qBittorrent has no push channel a WebExtension can subscribe to, so an alarm
 * polls the same filtered list the popup shows and raises a browser
 * notification when a torrent crosses from incomplete to complete. State is
 * persisted so a browser restart does not re-announce finished torrents.
 */
const watchItem = storage.defineItem<WatchState>("local:completion-watch", {
  fallback: {},
});

const ALARM_NAME = "remagnet-completion-watch";
const POLL_MINUTES = 1;
const NOTIFICATION_PREFIX = "remagnet-complete-";

let checking = false;

/** Poll now, then every minute. Safe to call once from the background script. */
export function startCompletionWatch(): void {
  browser.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void checkCompletions();
  });

  browser.notifications.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
    void openRemagnetPopup();
    void browser.notifications.clear(notificationId);
  });

  void checkCompletions();
}

export async function checkCompletions(): Promise<void> {
  if (checking) return;
  checking = true;

  try {
    // Polling without a configured proxy is expected; stay quiet until setup.
    const settings = await getSettings();
    if (!isProxyConfigured(settings) || !settings.downloadNotifications) return;

    const torrents = await listTorrents();
    const previous = await watchItem.getValue();
    const { next, completed } = completionTransitions(previous, torrents);
    await watchItem.setValue(next);

    for (const torrent of completed) {
      await notifyComplete(torrent);
    }
  } catch (error) {
    // Missing host access or a stopped client is normal; try again next alarm.
    console.warn("[remagnet] completion check failed", error);
  } finally {
    checking = false;
  }
}

/**
 * Remember freshly added torrents so a fast download still produces a
 * notification even if it finishes before the first poll.
 */
export async function trackAddedHashes(hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  if (!(await getSettings()).downloadNotifications) return;

  const state = await watchItem.getValue();
  let changed = false;

  for (const hash of hashes) {
    if (hash in state) continue;
    try {
      const torrent = await getTorrent(hash);
      state[hash] = torrent && torrent.progress >= COMPLETE_PROGRESS ? "complete" : "incomplete";
      changed = true;
    } catch (error) {
      console.warn("[remagnet] could not track added torrent", hash, error);
    }
  }

  if (changed) await watchItem.setValue(state);
}

/** Forget hashes removed through the popup so they are not watched again. */
export async function forgetHashes(hashes: string[]): Promise<void> {
  const state = await watchItem.getValue();
  let changed = false;

  for (const hash of hashes) {
    if (hash in state) {
      delete state[hash];
      changed = true;
    }
  }

  if (changed) await watchItem.setValue(state);
}

async function notifyComplete(torrent: TorrentSummary): Promise<void> {
  const suffix = " Open Remagnet to download it as a ZIP.";

  try {
    await browser.notifications.create(`${NOTIFICATION_PREFIX}${torrent.hash}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("/icon/128.png"),
      title: "Torrent complete",
      message: `${torrent.name}.${suffix}`,
      contextMessage: "Remagnet",
    });
    console.info(`[remagnet] notified completion of ${torrent.name}`);
  } catch (error) {
    console.warn("[remagnet] could not show a completion notification", error);
  }
}

/**
 * Open the toolbar popover, the same panel the browser shows when its icon is
 * clicked. Opening a separate window here would steal focus from the page the
 * person is reading, so the popover is the only surface.
 */
async function openRemagnetPopup(): Promise<void> {
  try {
    await openToolbarPopup();
  } catch (error) {
    console.warn("[remagnet] could not open the toolbar popover", error);
  }
}
