/**
 * Client-neutral torrent shapes.
 *
 * UI and messaging code only sees these types. Adapters translate their
 * client's native state names and fields into them.
 */

/** Progress at or above this is treated as complete everywhere. */
export const COMPLETE_PROGRESS = 0.999_999;

/** Smallest torrent count that earns a count badge instead of a plain number. */
export const COUNT_BADGE_MIN = 2;

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

/**
 * Whether a torrent can be treated as finished.
 *
 * A torrent at full progress can still be unusable: the client may have lost
 * its files, or the torrent may have failed. Those states stay incomplete so
 * the Download action never offers a broken archive.
 */
export function isTorrentComplete(torrent: Pick<TorrentSummary, "progress" | "state">): boolean {
  return (
    torrent.progress >= COMPLETE_PROGRESS &&
    torrent.state !== "error" &&
    torrent.state !== "missingFiles"
  );
}

/** Whether a torrent is stopped, so the UI offers Resume instead of Pause. */
export function isTorrentPaused(torrent: Pick<TorrentSummary, "state">): boolean {
  return torrent.state === "stopped";
}

/** One file inside a torrent, as shown in the expandable file browser. */
export interface TorrentFile {
  index: number;
  name: string;
  size: number;
  /** Fraction complete, 0..1. */
  progress: number;
}

/** Whether a single file is fully downloaded and ready to serve. */
export function isFileComplete(file: Pick<TorrentFile, "progress">): boolean {
  return file.progress >= COMPLETE_PROGRESS;
}

/** The last path segment of a torrent file name, for compact labels. */
export function fileBasename(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  const parts = trimmed.split("/").filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

/** The list buckets a user can filter torrents into. */
export type TorrentFilter = "all" | "active" | "ready" | "paused";

/** The orders a user can sort the torrent list by. */
export type TorrentSort = "added" | "name" | "progress" | "size" | "speed";

/** The search, filter and sort state for a torrent list. */
export interface TorrentListQuery {
  query?: string;
  filter?: TorrentFilter;
  sort?: TorrentSort;
}

/** Every filter in display order, so counts and tabs stay in sync. */
const TORRENT_FILTERS = ["all", "active", "ready", "paused"] as const;

/**
 * Whether a torrent belongs in a filter bucket.
 *
 * A paused torrent can also be complete, so `ready` and `paused` overlap on
 * purpose: the user can find a finished torrent either way.
 */
export function matchesTorrentFilter(torrent: TorrentSummary, filter: TorrentFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return !isTorrentComplete(torrent) && !isTorrentPaused(torrent);
    case "ready":
      return isTorrentComplete(torrent);
    case "paused":
      return isTorrentPaused(torrent);
  }
}

/** Count the torrents in each filter bucket. */
export function countTorrentFilters(
  torrents: readonly TorrentSummary[],
): Record<TorrentFilter, number> {
  const counts: Record<TorrentFilter, number> = { all: 0, active: 0, ready: 0, paused: 0 };
  for (const torrent of torrents) {
    for (const filter of TORRENT_FILTERS) {
      if (matchesTorrentFilter(torrent, filter)) counts[filter] += 1;
    }
  }
  return counts;
}

/**
 * Filter and sort a torrent list without touching the input array.
 *
 * Ties keep their original order, which keeps polling refreshes from making
 * equally ranked rows jump around.
 */
export function filterAndSortTorrents(
  torrents: readonly TorrentSummary[],
  options: TorrentListQuery = {},
): TorrentSummary[] {
  const filter = options.filter ?? "all";
  const needle = options.query?.trim().toLowerCase();

  const filtered = torrents.filter((torrent) => {
    if (!matchesTorrentFilter(torrent, filter)) return false;
    if (!needle) return true;
    return (
      torrent.name.toLowerCase().includes(needle) || torrent.hash.toLowerCase().includes(needle)
    );
  });

  const sort = options.sort ?? "added";
  if (sort === "added") return filtered;

  const compare = (a: TorrentSummary, b: TorrentSummary): number => {
    switch (sort) {
      case "name":
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      case "progress":
        return b.progress - a.progress;
      case "size":
        return b.size - a.size;
      case "speed":
        return b.downloadSpeed - a.downloadSpeed || b.uploadSpeed - a.uploadSpeed;
    }
  };

  return filtered
    .map((torrent, index) => ({ torrent, index }))
    .sort((a, b) => compare(a.torrent, b.torrent) || a.index - b.index)
    .map((entry) => entry.torrent);
}
