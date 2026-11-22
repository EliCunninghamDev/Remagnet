import { describe, expect, test } from "bun:test";
import { filterTorrents, getTorrentFilter, matchesTorrentFilter } from "./relevance";
import type { Settings } from "./settings";
import type { TorrentSummary } from "./torrents";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    client: "qbittorrent",
    baseUrl: "https://qbit.example",
    authMode: "apiKey",
    apiKey: "qbt_example",
    username: "admin",
    password: "",
    defaultCategory: "remagnet",
    defaultTags: "remagnet",
    archiveBaseUrl: "",
    archiveToken: "",
    ...overrides,
  };
}

function torrent(overrides: Partial<TorrentSummary> = {}): TorrentSummary {
  return {
    hash: "abc",
    name: "Example",
    state: "seeding",
    progress: 1,
    size: 1024,
    downloadSpeed: 0,
    uploadSpeed: 0,
    eta: 0,
    ratio: 1,
    category: "",
    tags: [],
    seeds: 0,
    peers: 0,
    ...overrides,
  };
}

describe("getTorrentFilter", () => {
  test("uses the configured category and tags", () => {
    expect(getTorrentFilter(settings())).toEqual({
      active: true,
      category: "remagnet",
      tags: ["remagnet"],
    });
  });

  test("splits and trims tags", () => {
    expect(getTorrentFilter(settings({ defaultTags: " remagnet, linux ,, " })).tags).toEqual([
      "remagnet",
      "linux",
    ]);
  });

  test("is inactive when both defaults are blank", () => {
    expect(getTorrentFilter(settings({ defaultCategory: "", defaultTags: " " })).active).toBe(
      false,
    );
  });
});

describe("matchesTorrentFilter", () => {
  test("matches the category or any configured tag", () => {
    const filter = getTorrentFilter(settings({ defaultTags: "remagnet, linux" }));

    expect(matchesTorrentFilter(torrent({ category: "remagnet" }), filter)).toBe(true);
    expect(matchesTorrentFilter(torrent({ tags: ["linux"] }), filter)).toBe(true);
    expect(matchesTorrentFilter(torrent({ tags: ["Remagnet"] }), filter)).toBe(true);
    expect(matchesTorrentFilter(torrent({ category: "tv", tags: ["cross-seed"] }), filter)).toBe(
      false,
    );
  });

  test("keeps everything when the filter is inactive", () => {
    const filter = getTorrentFilter(settings({ defaultCategory: "", defaultTags: "" }));
    expect(matchesTorrentFilter(torrent({ category: "movies" }), filter)).toBe(true);
  });
});

describe("filterTorrents", () => {
  test("drops unrelated torrents and keeps the order", () => {
    const filter = getTorrentFilter(settings());
    const torrents = [
      torrent({ hash: "a", name: "Tagged", tags: ["remagnet"] }),
      torrent({ hash: "b", name: "Movie", category: "movies" }),
      torrent({ hash: "c", name: "Categorized", category: "remagnet" }),
    ];

    expect(filterTorrents(torrents, filter).map((entry) => entry.hash)).toEqual(["a", "c"]);
  });
});
