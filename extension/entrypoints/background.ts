import {
  archiveDownloadUrl,
  createProxyClient,
  fileArchiveDownloadUrl,
  proxyError,
  toProxyError,
} from "@remagnet/proxy-client";
import { isTorrentComplete } from "@remagnet/ui/lib/torrents";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { archiveFilename } from "../lib/archive";
import {
  checkCompletions,
  forgetHashes,
  startCompletionWatch,
  syncToolbarBadge,
  trackAddedHashes,
} from "../lib/completion-watch";
import { startContextMenu } from "../lib/context-menu";
import {
  type AddTorrentsResult,
  type ArchiveDownloadResult,
  type BackgroundRequest,
  type BackgroundResponse,
  type BulkTorrentActionResult,
  type ConnectionTestResult,
  isBackgroundRequest,
  isTrustedExtensionSender,
  type PauseTorrentsResult,
  type RemoveTorrentsResult,
  type ResumeTorrentsResult,
  type TorrentFilesResult,
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
  listTorrentFiles,
  listTorrents,
  pauseAllTorrents,
  pauseTorrents,
  removeTorrents,
  resumeAllTorrents,
  resumeTorrents,
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
  const extensionOrigin = browser.runtime.getURL("");

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedExtensionSender(sender, browser.runtime.id, extensionOrigin)) return false;
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
        void checkCompletions();
        return { ok: true, data: result };
      }
      case "torrents:list": {
        const torrents = await listTorrents();
        void syncToolbarBadge(torrents);
        const result: TorrentListResult = {
          torrents,
          fetchedAt: Date.now(),
        };
        return { ok: true, data: result };
      }
      case "torrents:get": {
        const result: TorrentLookupResult = { torrent: await getTorrent(request.hash) };
        return { ok: true, data: result };
      }
      case "torrents:files": {
        const result: TorrentFilesResult = { files: await listTorrentFiles(request.hash) };
        return { ok: true, data: result };
      }
      case "torrents:remove": {
        await removeTorrents({ hashes: request.hashes, deleteFiles: request.deleteFiles });
        await forgetHashes(request.hashes);
        void checkCompletions();
        const result: RemoveTorrentsResult = { removed: request.hashes };
        return { ok: true, data: result };
      }
      case "torrents:pause": {
        await pauseTorrents(request.hashes);
        void checkCompletions();
        const result: PauseTorrentsResult = { paused: request.hashes };
        return { ok: true, data: result };
      }
      case "torrents:resume": {
        await resumeTorrents(request.hashes);
        void checkCompletions();
        const result: ResumeTorrentsResult = { resumed: request.hashes };
        return { ok: true, data: result };
      }
      case "torrents:pauseAll": {
        await pauseAllTorrents();
        void checkCompletions();
        const result: BulkTorrentActionResult = { action: "pause" };
        return { ok: true, data: result };
      }
      case "torrents:resumeAll": {
        await resumeAllTorrents();
        void checkCompletions();
        const result: BulkTorrentActionResult = { action: "resume" };
        return { ok: true, data: result };
      }
      case "archive:download": {
        const result: ArchiveDownloadResult = await downloadArchive(request.hash, request.name);
        return { ok: true, data: result };
      }
      case "archive:downloadFile": {
        const result: ArchiveDownloadResult = await downloadArchiveFile(
          request.hash,
          request.index,
          request.name,
        );
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
 *
 * No `filename` is passed to `downloads.download`: that lets Chrome and Firefox
 * use the proxy's `Content-Disposition` header, so a single-file torrent keeps
 * its raw name and extension while a multi-file torrent saves as `<name>.zip`.
 */
async function downloadArchive(hash: string, name?: string): Promise<ArchiveDownloadResult> {
  const proxy = requireProxySettings(await getSettings());

  const torrent = await getTorrent(hash);
  if (!torrent) throw new Error("That torrent is no longer in the client.");
  if (!isTorrentComplete(torrent)) {
    throw new Error("Only completed torrents can be downloaded as a ZIP.");
  }

  const filename = archiveFilename(name?.trim() || torrent.name);
  const startDownload = (url: string, headers?: { name: string; value: string }[]) =>
    browser.downloads.download({
      url,
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

/**
 * Ask the browser to download one completed file from a torrent.
 *
 * The same authentication split as the ZIP download applies: Firefox can send
 * the device token as an Authorization header, while Chrome and the Firefox
 * fallback use a single-use ticket bound to this hash and file index.
 */
async function downloadArchiveFile(
  hash: string,
  index: number,
  name?: string,
): Promise<ArchiveDownloadResult> {
  const proxy = requireProxySettings(await getSettings());
  const filename = name?.trim() || `file-${index + 1}`;

  if (import.meta.env.FIREFOX) {
    try {
      const downloadId = await browser.downloads.download({
        url: fileArchiveDownloadUrl(proxy.baseUrl, hash, index),
        conflictAction: "uniquify",
        saveAs: false,
        headers: [{ name: "Authorization", value: `Bearer ${proxy.token}` }],
      });
      return { downloadId, filename };
    } catch {
      // Some Firefox builds reject custom download headers. Fall through to a
      // single-use ticket rather than putting the device token in the URL.
    }
  }

  const ticket = await mintFileArchiveTicket(proxy, hash, index);
  const downloadId = await browser.downloads.download({
    url: fileArchiveDownloadUrl(proxy.baseUrl, hash, index, ticket),
    conflictAction: "uniquify",
    saveAs: false,
  });
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

/** Mint a ticket scoped to one file inside an archive. */
async function mintFileArchiveTicket(
  proxy: ProxySettings,
  hash: string,
  index: number,
): Promise<string> {
  try {
    const { data, error, response } = await createProxyClient(proxy).POST(
      "/api/archive/{hash}/files/{index}/ticket",
      { params: { path: { hash, index } } },
    );
    if (error || !data?.ticket) throw proxyError(response, error);
    return data.ticket;
  } catch (error) {
    throw toProxyError(error, proxy.baseUrl);
  }
}
