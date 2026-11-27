import { isTorrentComplete, isTorrentPaused } from "@remagnet/ui/lib/torrents";
import { browser } from "wxt/browser";
import type { TorrentSummary } from "./torrents";

/** What the toolbar icon should show for the current torrent list. */
export interface ToolbarBadgeState {
  text: string;
  color: string;
  title: string;
}

interface BadgeActionApi {
  setBadgeText?: (details: { text: string }) => Promise<void>;
  setBadgeBackgroundColor?: (details: { color: string }) => Promise<void>;
  setBadgeTextColor?: (details: { color: string }) => Promise<void>;
  setTitle?: (details: { title: string }) => Promise<void>;
}

const STEEL_BLUE = "#4f7595";
const ERROR_RED = "#8d3838";
const SAGE_GREEN = "#4e735d";

/**
 * Summarize the torrent list as a compact toolbar badge.
 *
 * Active work wins so the badge keeps moving while downloads happen. Errors
 * come next because they need attention, and finished torrents only get the
 * badge when nothing else is happening.
 */
export function computeToolbarBadge(torrents: readonly TorrentSummary[]): ToolbarBadgeState {
  let errored = 0;
  let active = 0;
  let ready = 0;

  for (const torrent of torrents) {
    if (torrent.state === "error" || torrent.state === "missingFiles") {
      errored += 1;
    } else if (!isTorrentComplete(torrent) && !isTorrentPaused(torrent)) {
      active += 1;
    } else if (isTorrentComplete(torrent)) {
      ready += 1;
    }
  }

  if (active > 0) {
    return {
      text: active > 99 ? "99+" : String(active),
      color: STEEL_BLUE,
      title:
        ready > 0 ? `Remagnet · ${active} active, ${ready} ready` : `Remagnet · ${active} active`,
    };
  }

  if (errored > 0) {
    return {
      text: "!",
      color: ERROR_RED,
      title:
        errored === 1 ? "Remagnet · 1 torrent errored" : `Remagnet · ${errored} torrents errored`,
    };
  }

  if (ready > 0) {
    return {
      text: ready > 99 ? "99+" : String(ready),
      color: SAGE_GREEN,
      title:
        ready === 1
          ? "Remagnet · 1 torrent ready to download"
          : `Remagnet · ${ready} torrents ready to download`,
    };
  }

  return {
    text: "",
    color: STEEL_BLUE,
    title: "Remagnet",
  };
}

/** Apply a badge state to the toolbar button, or clear it when `state` is null. */
export async function applyToolbarBadge(state: ToolbarBadgeState | null): Promise<void> {
  const action =
    (browser as unknown as { action?: BadgeActionApi; browserAction?: BadgeActionApi }).action ??
    (browser as unknown as { browserAction?: BadgeActionApi }).browserAction;
  if (!action) return;

  try {
    if (state === null || state.text === "") {
      await action.setBadgeText?.({ text: "" });
      await action.setTitle?.({ title: state?.title ?? "Remagnet" });
      return;
    }

    await action.setBadgeText?.({ text: state.text });
    await action.setBadgeBackgroundColor?.({ color: state.color });
    await action.setBadgeTextColor?.({ color: "#ffffff" });
    await action.setTitle?.({ title: state.title });
  } catch (error) {
    console.warn("[remagnet] could not update the toolbar badge", error);
  }
}
