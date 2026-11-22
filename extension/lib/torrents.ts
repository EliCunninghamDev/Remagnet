/**
 * Client-neutral torrent shapes.
 *
 * UI and messaging code only sees these types. Adapters translate their
 * client's native state names and fields into them.
 */

/** Progress at or above this is treated as complete everywhere. */
export const COMPLETE_PROGRESS = 0.999_999;

/**
 * A normalized lifecycle state.
 *
 * Clients report different names for the same phase (qBittorrent, for example,
 * has six separate checking/queued/paused variants). Adapters collapse those
 * into this set so labels and tones stay client-agnostic. The open string
 * branch keeps unknown future states renderable.
 */
export type TorrentState =
  | "checking"
  | "metadata"
  | "downloading"
  | "stalled"
  | "queued"
  | "moving"
  | "seeding"
  | "stopped"
  | "error"
  | "missingFiles"
  | "unknown"
  | (string & {});

/** The subset of a torrent the popup needs to render its list. */
export interface TorrentSummary {
  hash: string;
  name: string;
  state: TorrentState;
  /** Fraction complete, 0..1. */
  progress: number;
  /** Total size in bytes. */
  size: number;
  /** Current download speed in bytes/second. */
  downloadSpeed: number;
  /** Current upload speed in bytes/second. */
  uploadSpeed: number;
  /** Seconds remaining, or a very large number when unknown. */
  eta: number;
  ratio: number;
  category: string;
  tags: string[];
  seeds: number;
  peers: number;
}

/** Categories and tags available on the configured client. */
export interface TorrentTaxonomy {
  categories: string[];
  tags: string[];
}
