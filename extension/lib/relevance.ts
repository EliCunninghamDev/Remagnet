import type { Settings } from "./settings";
import type { TorrentSummary } from "./torrents";

/**
 * Which torrents the popup treats as Remagnet's own.
 *
 * Remagnet adds magnets with the configured default category and tags, so the
 * popup uses the same values to hide unrelated torrents in a shared client
 * (films, music, cross-seeds, …). When both defaults are blank there is no
 * way to tell the two apart, so everything is shown.
 */
export interface TorrentFilter {
  active: boolean;
  category: string;
  tags: string[];
}

export function getTorrentFilter(settings: Settings): TorrentFilter {
  const category = settings.defaultCategory.trim();
  const tags = splitList(settings.defaultTags);
  return { active: category.length > 0 || tags.length > 0, category, tags };
}

/** A torrent is relevant when its category or any of its tags match. */
export function matchesTorrentFilter(torrent: TorrentSummary, filter: TorrentFilter): boolean {
  if (!filter.active) return true;

  if (filter.category && sameName(torrent.category, filter.category)) return true;

  const torrentTags = new Set(torrent.tags.map(fold));
  return filter.tags.some((tag) => torrentTags.has(fold(tag)));
}

export function filterTorrents(
  torrents: TorrentSummary[],
  filter: TorrentFilter,
): TorrentSummary[] {
  if (!filter.active) return torrents;
  return torrents.filter((torrent) => matchesTorrentFilter(torrent, filter));
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** qBittorrent category and tag matching is case-insensitive in practice. */
function fold(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function sameName(left: string, right: string): boolean {
  return fold(left) === fold(right);
}
