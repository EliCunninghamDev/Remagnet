import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { archiveDownloadUrl, archiveFilename, requireArchiveSettings } from "../lib/archive";
import { forgetHashes, startCompletionWatch, trackAddedHashes } from "../lib/completion-watch";
import { startContextMenu } from "../lib/context-menu";
import {
  type AddTorrentsResult,
  type ArchiveDownloadResult,
  type ArchiveTestResult,
  type BackgroundRequest,
  type BackgroundResponse,
  COMPLETE_PROGRESS,
  type ConnectionTestResult,
  isBackgroundRequest,
  type RemoveTorrentsResult,
  type TorrentListResult,
  type TorrentLookupResult,
  type TorrentTaxonomyResult,
} from "../lib/messages";
import { getSettings } from "../lib/settings";
import {
  addTorrents,
  getTaxonomy,
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
          category: request.category,
          tags: request.tags,
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
      case "torrents:taxonomy": {
        const result: TorrentTaxonomyResult = await getTaxonomy();
        return { ok: true, data: result };
      }
      case "archive:test": {
        const result: ArchiveTestResult = await testArchive();
        return { ok: true, data: result };
      }
      case "archive:download": {
        const result: ArchiveDownloadResult = await downloadArchive(request.hash, request.name);
        return { ok: true, data: result };
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Check the archive bridge and its saved qBittorrent credentials. */
async function testArchive(): Promise<ArchiveTestResult> {
  const archive = requireArchiveSettings(await getSettings());
  const response = await fetch(`${archive.baseUrl}/api/health`, {
    headers: { Authorization: `Bearer ${archive.token}` },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await bridgeError(response));
  }

  const body = (await response.json()) as { appVersion?: unknown; webApiVersion?: unknown };
  return {
    appVersion: typeof body.appVersion === "string" ? body.appVersion : "unknown",
    webApiVersion: typeof body.webApiVersion === "string" ? body.webApiVersion : "unknown",
  };
}

/**
 * Ask the browser to download a completed torrent's ZIP.
 *
 * Firefox supports an Authorization header on downloads; other browsers get
 * the token as a query parameter instead. The bridge enforces completion, and
 * this checks it first so the popup can report a useful error immediately.
 */
async function downloadArchive(hash: string, name?: string): Promise<ArchiveDownloadResult> {
  const settings = await getSettings();
  const archive = requireArchiveSettings(settings);

  const torrent = await getTorrent(hash);
  if (!torrent) throw new Error("That torrent is no longer in the client.");
  if (torrent.progress < COMPLETE_PROGRESS) {
    throw new Error("Only completed torrents can be downloaded as a ZIP.");
  }

  const filename = archiveFilename(name?.trim() || torrent.name);
  const firefox = Boolean(import.meta.env.FIREFOX);

  const startDownload = (useHeader: boolean) =>
    browser.downloads.download({
      url: archiveDownloadUrl(archive.baseUrl, hash, archive.token, useHeader),
      filename,
      conflictAction: "uniquify",
      saveAs: false,
      ...(useHeader
        ? { headers: [{ name: "Authorization", value: `Bearer ${archive.token}` }] }
        : {}),
    });

  let downloadId: number;
  try {
    downloadId = await startDownload(firefox);
  } catch (error) {
    if (!firefox) throw error;
    // If this Firefox build rejects custom headers, retry with the query-token
    // fallback the bridge also accepts.
    downloadId = await startDownload(false);
  }

  return { downloadId, filename };
}

/** Turn an error response from the bridge into a readable message. */
async function bridgeError(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") detail = `: ${body.error}`;
  } catch {
    // Not JSON; a status line is still useful.
  }
  return `The archive bridge returned ${response.status} ${response.statusText}${detail}`;
}
