import {
  archiveDownloadUrl,
  createProxyClient,
  proxyError,
  toProxyError,
} from "@remagnet/proxy-client";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { archiveFilename } from "../lib/archive";
import { forgetHashes, startCompletionWatch, trackAddedHashes } from "../lib/completion-watch";
import { startContextMenu } from "../lib/context-menu";
import {
  type AddTorrentsResult,
  type ArchiveDownloadResult,
  type BackgroundRequest,
  type BackgroundResponse,
  COMPLETE_PROGRESS,
  type ConnectionTestResult,
  isBackgroundRequest,
  type RemoveTorrentsResult,
  type TorrentListResult,
  type TorrentLookupResult,
} from "../lib/messages";
import {
  getSettings,
  type ProxySettings,
  requireProxySettings,
  restrictSettingsStorageAccess,
} from "../lib/settings";
import {
  addTorrents,
  getTorrent,
  listTorrents,
  removeTorrents,
  testConnection,
} from "../lib/torrent-service";

/**
 * Background context: the single communicator with the configured torrent
 * client.
 *
 * The popup, add window and options page never talk to a client directly; they
 * send typed messages here, and this worker owns credentials, sessions, host
 * access and adapter selection.
 */
export default defineBackground(() => {
  restrictSettingsStorageAccess();

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isBackgroundRequest(message)) return false;

    void handleRequest(message).then(sendResponse);
    return true;
  });

  startCompletionWatch();
  startContextMenu();
});

async function handleRequest(request: BackgroundRequest): Promise<BackgroundResponse<unknown>> {
  try {
    switch (request.type) {
      case "connection:test": {
        const result: ConnectionTestResult = await testConnection();
        return { ok: true, data: result };
      }
      case "torrents:add": {
        const result: AddTorrentsResult = await addTorrents({
          urls: request.urls,
          files: request.files,
          paused: request.paused,
        });
        await trackAddedHashes(result.hashes);
        return { ok: true, data: result };
      }
      case "torrents:list": {
        const result: TorrentListResult = {
          torrents: await listTorrents(),
          fetchedAt: Date.now(),
        };
        return { ok: true, data: result };
      }
      case "torrents:get": {
        const result: TorrentLookupResult = { torrent: await getTorrent(request.hash) };
        return { ok: true, data: result };
      }
      case "torrents:remove": {
        await removeTorrents({ hashes: request.hashes, deleteFiles: request.deleteFiles });
        await forgetHashes(request.hashes);
        const result: RemoveTorrentsResult = { removed: request.hashes };
        return { ok: true, data: result };
      }
      case "archive:download": {
        const result: ArchiveDownloadResult = await downloadArchive(request.hash, request.name);
        return { ok: true, data: result };
      }
    }
  } catch (error) {
    const err = toProxyError(error);
    return {
      ok: false,
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.status ? { status: err.status } : {}),
    };
  }
}

/**
 * Ask the browser to download a completed torrent's ZIP.
 *
 * The device token never goes in a URL. Firefox can attach it as an
 * Authorization header; Chrome cannot pass headers through `downloads.download`,
 * so it mints a single-use, short-lived ticket instead. If a Firefox build
 * rejects the custom header, the same ticket path is the fallback. The proxy
 * enforces completion, and this checks it first so the popup can report a
 * useful error immediately.
 */
async function downloadArchive(hash: string, name?: string): Promise<ArchiveDownloadResult> {
  const proxy = requireProxySettings(await getSettings());

  const torrent = await getTorrent(hash);
  if (!torrent) throw new Error("That torrent is no longer in the client.");
  if (torrent.progress < COMPLETE_PROGRESS) {
    throw new Error("Only completed torrents can be downloaded as a ZIP.");
  }

  const filename = archiveFilename(name?.trim() || torrent.name);
  const startDownload = (url: string, headers?: { name: string; value: string }[]) =>
    browser.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
      ...(headers ? { headers } : {}),
    });

  if (import.meta.env.FIREFOX) {
    try {
      const downloadId = await startDownload(archiveDownloadUrl(proxy.baseUrl, hash), [
        { name: "Authorization", value: `Bearer ${proxy.token}` },
      ]);
      return { downloadId, filename };
    } catch {
      // Some Firefox builds reject custom download headers. Fall through to a
      // single-use ticket rather than putting the device token in the URL.
    }
  }

  const ticket = await mintArchiveTicket(proxy, hash);
  const downloadId = await startDownload(archiveDownloadUrl(proxy.baseUrl, hash, ticket));
  return { downloadId, filename };
}

/** Exchange the device token for an archive URL that is safe to log. */
async function mintArchiveTicket(proxy: ProxySettings, hash: string): Promise<string> {
  try {
    const { data, error, response } = await createProxyClient(proxy).POST(
      "/api/archive/{hash}/ticket",
      { params: { path: { hash } } },
    );
    if (error || !data?.ticket) throw proxyError(response, error);
    return data.ticket;
  } catch (error) {
    throw toProxyError(error, proxy.baseUrl);
  }
}
