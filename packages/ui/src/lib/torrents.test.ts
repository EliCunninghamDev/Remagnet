import { describe, expect, test } from "bun:test";
import {
  countTorrentFilters,
  fileBasename,
  filterAndSortTorrents,
  isFileComplete,
  matchesTorrentFilter,
  type TorrentFilter,
  type TorrentSummary,
} from "./torrents";

function torrent(overrides: Partial<TorrentSummary> = {}): TorrentSummary {
  return {
    hash: "0000000000000000000000000000000000000000",
    name: "Torrent",
    state: "downloading",
    progress: 0.5,
    size: 100,
    downloadSpeed: 0,
    uploadSpeed: 0,
    eta: 60,
    ratio: 0,
    category: "",
    tags: [],
    seeds: 0,
    peers: 0,
    ...overrides,
  };
}

describe("isFileComplete", () => {
  test("treats full progress as complete", () => {
    expect(isFileComplete({ progress: 1 })).toBe(true);
  });

  test("uses the same completion threshold as torrents", () => {
    expect(isFileComplete({ progress: 0.999_999 })).toBe(true);
    expect(isFileComplete({ progress: 0.999 })).toBe(false);
  });

  test("treats partially downloaded files as incomplete", () => {
    expect(isFileComplete({ progress: 0.5 })).toBe(false);
    expect(isFileComplete({ progress: 0 })).toBe(false);
  });
});

describe("fileBasename", () => {
  test("returns the last segment of a POSIX path", () => {
    expect(fileBasename("season 1/episode 2.mkv")).toBe("episode 2.mkv");
  });

  test("handles Windows separators", () => {
    expect(fileBasename("season 1\\episode 2.mkv")).toBe("episode 2.mkv");
  });

  test("ignores leading, trailing and repeated separators", () => {
    expect(fileBasename("/downloads//file.txt/")).toBe("file.txt");
    expect(fileBasename("  folder\\file.txt  ")).toBe("file.txt");
  });

  test("returns a bare name unchanged", () => {
    expect(fileBasename("file.txt")).toBe("file.txt");
    expect(fileBasename("")).toBe("");
  });
});

describe("matchesTorrentFilter", () => {
  test("all matches every torrent", () => {
    expect(matchesTorrentFilter(torrent(), "all")).toBe(true);
    expect(matchesTorrentFilter(torrent({ progress: 1, state: "seeding" }), "all")).toBe(true);
    expect(matchesTorrentFilter(torrent({ state: "stopped" }), "all")).toBe(true);
  });

  test("active matches incomplete torrents that are not paused", () => {
    expect(matchesTorrentFilter(torrent({ state: "downloading", progress: 0.4 }), "active")).toBe(
      true,
    );
    expect(matchesTorrentFilter(torrent({ state: "stalled", progress: 0 }), "active")).toBe(true);
    expect(matchesTorrentFilter(torrent({ state: "seeding", progress: 1 }), "active")).toBe(false);
    expect(matchesTorrentFilter(torrent({ state: "stopped", progress: 0.4 }), "active")).toBe(
      false,
    );
  });

  test("ready matches complete torrents, including paused ones", () => {
    expect(matchesTorrentFilter(torrent({ state: "seeding", progress: 1 }), "ready")).toBe(true);
    expect(matchesTorrentFilter(torrent({ state: "stopped", progress: 1 }), "ready")).toBe(true);
    expect(matchesTorrentFilter(torrent({ state: "downloading", progress: 0.9 }), "ready")).toBe(
      false,
    );
  });

  test("ready rejects completed torrents that cannot be used", () => {
    expect(matchesTorrentFilter(torrent({ state: "error", progress: 1 }), "ready")).toBe(false);
    expect(matchesTorrentFilter(torrent({ state: "missingFiles", progress: 1 }), "ready")).toBe(
      false,
    );
  });

  test("paused matches stopped torrents", () => {
    expect(matchesTorrentFilter(torrent({ state: "stopped", progress: 0.2 }), "paused")).toBe(true);
    expect(matchesTorrentFilter(torrent({ state: "downloading" }), "paused")).toBe(false);
  });
});

describe("countTorrentFilters", () => {
  test("counts each bucket, letting a paused complete torrent land in both", () => {
    const list = [
      torrent({ state: "downloading", progress: 0.3 }),
      torrent({ state: "seeding", progress: 1 }),
      torrent({ state: "stopped", progress: 1 }),
      torrent({ state: "stopped", progress: 0.2 }),
    ];

    expect(countTorrentFilters(list)).toEqual({
      all: 4,
      active: 1,
      ready: 2,
      paused: 2,
    });
  });

  test("returns zeroed buckets for an empty list", () => {
    expect(countTorrentFilters([])).toEqual({ all: 0, active: 0, ready: 0, paused: 0 });
  });
});

describe("filterAndSortTorrents", () => {
  const list = [
    torrent({
      hash: "aaa111",
      name: "Ubuntu ISO",
      state: "downloading",
      progress: 0.4,
      size: 400,
      downloadSpeed: 10,
      uploadSpeed: 1,
    }),
    torrent({
      hash: "bbb222",
      name: "debian image",
      state: "seeding",
      progress: 1,
      size: 200,
      downloadSpeed: 0,
      uploadSpeed: 5,
    }),
    torrent({
      hash: "ccc333",
      name: "Arch image",
      state: "stopped",
      progress: 1,
      size: 300,
      downloadSpeed: 0,
      uploadSpeed: 2,
    }),
    torrent({
      hash: "ddd444",
      name: "Fedora image",
      state: "stopped",
      progress: 0.25,
      size: 100,
      downloadSpeed: 0,
      uploadSpeed: 0,
    }),
  ];

  test("defaults to all torrents in input order", () => {
    expect(filterAndSortTorrents(list).map((item) => item.hash)).toEqual([
      "aaa111",
      "bbb222",
      "ccc333",
      "ddd444",
    ]);
  });

  test("filters into every bucket", () => {
    const hashes = (filter: TorrentFilter) =>
      filterAndSortTorrents(list, { filter }).map((item) => item.hash);

    expect(hashes("all")).toEqual(["aaa111", "bbb222", "ccc333", "ddd444"]);
    expect(hashes("active")).toEqual(["aaa111"]);
    expect(hashes("ready")).toEqual(["bbb222", "ccc333"]);
    expect(hashes("paused")).toEqual(["ccc333", "ddd444"]);
  });

  test("searches names case-insensitively and trims the query", () => {
    expect(filterAndSortTorrents(list, { query: "  IMAGE " }).map((item) => item.hash)).toEqual([
      "bbb222",
      "ccc333",
      "ddd444",
    ]);
    expect(filterAndSortTorrents(list, { query: "ubuntu" }).map((item) => item.hash)).toEqual([
      "aaa111",
    ]);
  });

  test("searches hashes case-insensitively", () => {
    expect(filterAndSortTorrents(list, { query: "CCC" }).map((item) => item.hash)).toEqual([
      "ccc333",
    ]);
  });

  test("returns an empty list when nothing matches", () => {
    expect(filterAndSortTorrents(list, { query: "nothing here" })).toEqual([]);
  });

  test("combines search and filter", () => {
    expect(
      filterAndSortTorrents(list, { query: "image", filter: "paused" }).map((item) => item.hash),
    ).toEqual(["ccc333", "ddd444"]);
  });

  test("sorts by name with base sensitivity and numeric order", () => {
    const numbered = [
      torrent({ hash: "1", name: "item 10" }),
      torrent({ hash: "2", name: "Item 2" }),
      torrent({ hash: "3", name: "apple" }),
    ];

    expect(filterAndSortTorrents(numbered, { sort: "name" }).map((item) => item.name)).toEqual([
      "apple",
      "Item 2",
      "item 10",
    ]);
  });

  test("sorts progress descending", () => {
    expect(filterAndSortTorrents(list, { sort: "progress" }).map((item) => item.hash)).toEqual([
      "bbb222",
      "ccc333",
      "aaa111",
      "ddd444",
    ]);
  });

  test("sorts size descending", () => {
    expect(filterAndSortTorrents(list, { sort: "size" }).map((item) => item.hash)).toEqual([
      "aaa111",
      "ccc333",
      "bbb222",
      "ddd444",
    ]);
  });

  test("sorts speed descending, breaking ties on upload speed", () => {
    const speeds = [
      torrent({ hash: "slow", downloadSpeed: 1, uploadSpeed: 100 }),
      torrent({ hash: "tie-low-up", downloadSpeed: 5, uploadSpeed: 1 }),
      torrent({ hash: "fast", downloadSpeed: 9, uploadSpeed: 0 }),
      torrent({ hash: "tie-high-up", downloadSpeed: 5, uploadSpeed: 8 }),
    ];

    expect(filterAndSortTorrents(speeds, { sort: "speed" }).map((item) => item.hash)).toEqual([
      "fast",
      "tie-high-up",
      "tie-low-up",
      "slow",
    ]);
  });

  test("preserves original order for ties across every sort", () => {
    const ties = [
      torrent({
        hash: "first",
        name: "Same",
        progress: 0.5,
        size: 10,
        downloadSpeed: 2,
        uploadSpeed: 2,
      }),
      torrent({
        hash: "second",
        name: "Same",
        progress: 0.5,
        size: 10,
        downloadSpeed: 2,
        uploadSpeed: 2,
      }),
      torrent({
        hash: "third",
        name: "Same",
        progress: 0.5,
        size: 10,
        downloadSpeed: 2,
        uploadSpeed: 2,
      }),
    ];

    for (const sort of ["added", "name", "progress", "size", "speed"] as const) {
      expect(filterAndSortTorrents(ties, { sort }).map((item) => item.hash)).toEqual([
        "first",
        "second",
        "third",
      ]);
    }
  });

  test("does not mutate the input array", () => {
    const snapshot = [...list];
    filterAndSortTorrents(list, { sort: "name", filter: "ready", query: "image" });
    expect(list).toEqual(snapshot);
  });
});
