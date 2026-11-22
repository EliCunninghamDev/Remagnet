/** A known qBittorrent torrent state, while still allowing future states. */
export type TorrentState =
  | "allocating"
  | "checkingDL"
  | "checkingResumeData"
  | "checkingUP"
  | "downloading"
  | "error"
  | "forcedDL"
  | "forcedUP"
  | "missingFiles"
  | "metaDL"
  | "moving"
  | "pausedDL"
  | "pausedUP"
  | "queuedDL"
  | "queuedUP"
  | "stalledDL"
  | "stalledUP"
  | "stoppedDL"
  | "stoppedUP"
  | "unknown"
  | "uploading"
  | (string & {});

export interface TorrentInfo {
  hash: string;
  name: string;
  size: number;
  progress: number;
  dlspeed: number;
  upspeed: number;
  state: TorrentState;
  category: string;
  tags: string;
  ratio: number;
  eta: number;
  num_seeds: number;
  num_leechs: number;
  added_on: number;
  completion_on: number;
  last_activity: number;
  save_path: string;
  content_path: string;
  magnet_uri: string;
  tracker: string;
  [key: string]: unknown;
}

export type TorrentFilter =
  | "all"
  | "completed"
  | "downloading"
  | "errored"
  | "paused"
  | "resumed"
  | "running"
  | "stalled"
  | "stopped"
  | "uploading";

export interface TorrentListParams {
  filter?: TorrentFilter;
  category?: string;
  tag?: string;
  sort?: string;
  reverse?: boolean;
  limit?: number;
  offset?: number;
  hashes?: string | string[];
}

export interface AddTorrentOptions {
  /** Magnet links or HTTP(S) URLs to .torrent files, separated or as an array. */
  urls?: string | string[];
  /** Raw .torrent files to upload instead of (or in addition to) URLs. */
  files?: File[];
  savePath?: string;
  category?: string;
  tags?: string | string[];
  /** Start the torrent paused/stopped. Sent as both `paused` and `stopped` for qBittorrent 4.x/5.x. */
  paused?: boolean;
  skipChecking?: boolean;
  sequentialDownload?: boolean;
  firstLastPiecePrio?: boolean;
  autoTMM?: boolean;
  rename?: string;
  upLimit?: number;
  dlLimit?: number;
  ratioLimit?: number;
  seedingTimeLimit?: number;
}

export interface TorrentFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
  is_seed: boolean;
  piece_range: [number, number];
  availability: number;
}

export interface TorrentTracker {
  url: string;
  status: number;
  tier: number;
  num_peers: number;
  num_seeds: number;
  num_leeches: number;
  num_downloaded: number;
  msg: string;
}

export interface TransferInfo {
  connection_status: "connected" | "firewalled" | "disconnected" | (string & {});
  dht_nodes: number;
  dl_info_data: number;
  dl_info_speed: number;
  dl_rate_limit: number;
  up_info_data: number;
  up_info_speed: number;
  up_rate_limit: number;
  [key: string]: unknown;
}

export interface Category {
  name: string;
  savePath: string;
}

export interface AppPreferences {
  save_path: string;
  temp_path: string;
  web_ui_port: number;
  web_ui_username: string;
  [key: string]: unknown;
}

export interface BuildInfo {
  qt: string;
  libtorrent: string;
  boost: string;
  openssl: string;
  bitness: number;
  [key: string]: unknown;
}

/** A partial or full response from `/api/v2/sync/maindata`. */
export interface MainData {
  rid: number;
  full_update?: boolean;
  torrents?: Record<string, TorrentInfo>;
  categories?: Record<string, Category>;
  tags?: string[];
  server_state?: Record<string, unknown>;
  [key: string]: unknown;
}
