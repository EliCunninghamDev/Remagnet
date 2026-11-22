import type { Settings } from "../settings";
import { createQBittorrentAdapter } from "./qbittorrent";
import type { ClientKind, TorrentClientFactory } from "./types";

/**
 * Adapter registry.
 *
 * This module is imported by the background service only: it pulls each
 * client implementation (and its SDK) into the background bundle. UI code
 * imports `./catalog` for metadata so those dependencies stay out of page
 * bundles.
 */
const FACTORIES: Record<ClientKind, TorrentClientFactory> = {
  qbittorrent: createQBittorrentAdapter,
};

export function createTorrentClient(settings: Settings) {
  return FACTORIES[settings.client](settings);
}

export { getTorrentClientDefinition, TORRENT_CLIENT_LIST, TORRENT_CLIENTS } from "./catalog";
export type * from "./types";
