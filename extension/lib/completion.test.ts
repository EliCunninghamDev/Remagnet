import { describe, expect, test } from "bun:test";
import { completionTransitions, type WatchState } from "./completion";
import type { TorrentSummary } from "./torrents";

function torrent(hash: string, progress: number): TorrentSummary {
  return {
    hash,
    name: `Torrent ${hash}`,
    state: progress >= 1 ? "seeding" : "downloading",
    progress,
    size: 1024,
    downloadSpeed: 0,
    uploadSpeed: 0,
    eta: 0,
    ratio: 0,
    category: "remagnet",
    tags: [],
    seeds: 1,
    peers: 1,
  };
}

describe("completionTransitions", () => {
  test("notifies only torrents seen downloading before", () => {
    const previous: WatchState = { a: "incomplete", b: "complete" };
    const { next, completed } = completionTransitions(previous, [torrent("a", 1), torrent("b", 1)]);

    expect(completed.map((entry) => entry.hash)).toEqual(["a"]);
    expect(next).toEqual({ a: "complete", b: "complete" });
  });

  test("is silent for torrents that are already complete on first sight", () => {
    const { next, completed } = completionTransitions({}, [torrent("new", 1)]);
    expect(completed).toEqual([]);
    expect(next).toEqual({ new: "complete" });
  });

  test("remembers in-progress torrents and drops missing ones", () => {
    const previous: WatchState = { gone: "incomplete", active: "incomplete" };
    const { next, completed } = completionTransitions(previous, [torrent("active", 0.4)]);

    expect(completed).toEqual([]);
    expect(next).toEqual({ active: "incomplete" });
  });

  test("keeps notifying once and then stops", () => {
    const first = completionTransitions({ a: "incomplete" }, [torrent("a", 1)]);
    expect(first.completed).toHaveLength(1);

    const second = completionTransitions(first.next, [torrent("a", 1)]);
    expect(second.completed).toEqual([]);
  });

  test("treats rounding-level progress as complete", () => {
    const { completed } = completionTransitions({ a: "incomplete" }, [torrent("a", 0.999_999_4)]);
    expect(completed).toHaveLength(1);
  });
});
