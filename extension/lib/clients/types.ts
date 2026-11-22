import type { Settings } from "../settings";
import type { TorrentSummary, TorrentTaxonomy } from "../torrents";

/**
 * Torrent client adapter contract.
 *
 * Everything outside `lib/clients` (the background service and the UI) works
 * with these neutral types. Adding a client means adding a catalog entry, an
 * adapter, and a factory registration; no UI or message code needs to change.
 */

/** Supported backend implementations. Extend this union with new clients. */
export type ClientKind = "qbittorrent";

/** Authentication styles an adapter can offer. */
export type AuthMode = "apiKey" | "password";

export interface TorrentClientCapabilities {
  categories: boolean;
  tags: boolean;
  /** Can add a torrent in a stopped/paused state. */
  pauseOnAdd: boolean;
  /** Can stream finished files through the client API (single-file downloads). */
  completedFileDownload: boolean;
}

/** Static, serializable metadata used by settings and other UI. */
export interface TorrentClientDefinition {
  kind: ClientKind;
  label: string;
  description: string;
  authModes: readonly AuthMode[];
  defaultBaseUrl: string;
  /** Placeholder for the API key field, when `apiKey` auth is offered. */
  apiKeyPlaceholder?: string;
  /** Help text under the API key field. */
  apiKeyHelp?: string;
  capabilities: TorrentClientCapabilities;
  /** Validate adapter-relevant settings. Returns a message to show, or null. */
  validate(settings: Settings): string | null;
}

export interface ConnectionDetails {
  kind: ClientKind;
  clientLabel: string;
  version: string;
  apiVersion?: string;
  authMode: AuthMode;
}

export interface AddTorrentRequest {
  urls: string[];
  category?: string;
  tags?: string[];
  paused?: boolean;
}

export interface AddTorrentResult {
  added: number;
  /** Info hashes parsed from the submitted magnet links. */
  hashes: string[];
}

export interface RemoveTorrentRequest {
  hashes: string[];
  /** Also delete the torrent's data. Defaults to false (keep files). */
  deleteFiles?: boolean;
}

/** The operations the background service needs from any torrent client. */
export interface TorrentClientAdapter {
  readonly kind: ClientKind;
  readonly definition: TorrentClientDefinition;
  testConnection(): Promise<ConnectionDetails>;
  listTorrents(): Promise<TorrentSummary[]>;
  getTorrent(hash: string): Promise<TorrentSummary | null>;
  getTaxonomy(): Promise<TorrentTaxonomy>;
  addTorrent(input: AddTorrentRequest): Promise<AddTorrentResult>;
  removeTorrent(input: RemoveTorrentRequest): Promise<void>;
}

/** Factory registered per client kind (implementations live in the adapter). */
export type TorrentClientFactory = (settings: Settings) => TorrentClientAdapter;
