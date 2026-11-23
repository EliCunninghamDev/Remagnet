import { browser } from "wxt/browser";
import type { TorrentSummary } from "./torrents";

export { COMPLETE_PROGRESS } from "./torrents";

export type BackgroundRequest =
  | { type: "connection:test" }
  | { type: "torrents:add"; urls: string[]; paused?: boolean }
  | { type: "torrents:list" }
  | { type: "torrents:get"; hash: string }
  | { type: "torrents:remove"; hashes: string[]; deleteFiles?: boolean }
  | { type: "archive:download"; hash: string; name?: string };

export interface ConnectionTestResult {
  clientLabel: string;
  appVersion: string;
  webApiVersion: string;
  capabilities: {
    pauseOnAdd: boolean;
  };
  defaultCategory: string;
  defaultTags: string[];
}

export interface TorrentListResult {
  torrents: TorrentSummary[];
  /** Epoch milliseconds when the list was fetched. */
  fetchedAt: number;
}

export interface AddTorrentsResult {
  added: number;
  hashes: string[];
  category: string;
  tags: string[];
}

export interface TorrentLookupResult {
  torrent: TorrentSummary | null;
}

export interface ArchiveDownloadResult {
  downloadId: number;
  filename: string;
}

export interface RemoveTorrentsResult {
  removed: string[];
}

export type BackgroundResponse<T> = { ok: true; data: T } | { ok: false; error: string };

export async function sendBackgroundMessage<T>(request: BackgroundRequest): Promise<T> {
  const response = (await browser.runtime.sendMessage(request)) as
    | BackgroundResponse<T>
    | undefined;

  if (!response) throw new Error("The extension background worker did not respond.");
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as {
    type?: unknown;
    urls?: unknown;
    paused?: unknown;
    hash?: unknown;
    name?: unknown;
    hashes?: unknown;
    deleteFiles?: unknown;
  };

  switch (candidate.type) {
    case "connection:test":
    case "torrents:list":
      return true;
    case "torrents:get":
      return typeof candidate.hash === "string" && candidate.hash.length > 0;
    case "torrents:remove":
      return (
        Array.isArray(candidate.hashes) &&
        candidate.hashes.length > 0 &&
        candidate.hashes.every((hash) => typeof hash === "string" && hash.length > 0) &&
        (candidate.deleteFiles === undefined || typeof candidate.deleteFiles === "boolean")
      );
    case "archive:download":
      return (
        typeof candidate.hash === "string" &&
        candidate.hash.length > 0 &&
        (candidate.name === undefined || typeof candidate.name === "string")
      );
    case "torrents:add":
      return (
        Array.isArray(candidate.urls) &&
        candidate.urls.every((url) => typeof url === "string") &&
        (candidate.paused === undefined || typeof candidate.paused === "boolean")
      );
    default:
      return false;
  }
}
