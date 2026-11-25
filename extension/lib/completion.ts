import { isTorrentComplete } from "@remagnet/ui/lib/torrents";
import type { TorrentSummary } from "./torrents";

/** Per-hash memory of whether the monitor last saw a torrent in progress. */
export type WatchState = Record<string, "incomplete" | "complete">;

/**
 * Compare the previous watch state with the current torrent list.
 *
 * A torrent is announced only when the monitor saw it downloading earlier, so
 * torrents that were already complete when Remagnet started stay silent.
 */
export function completionTransitions(
  previous: WatchState,
  torrents: TorrentSummary[],
): { next: WatchState; completed: TorrentSummary[] } {
  const next: WatchState = {};
  const completed: TorrentSummary[] = [];

  for (const torrent of torrents) {
    const isComplete = isTorrentComplete(torrent);
    next[torrent.hash] = isComplete ? "complete" : "incomplete";

    if (isComplete && previous[torrent.hash] === "incomplete") {
      completed.push(torrent);
    }
  }

  return { next, completed };
}
