import { describe, expect, test } from "bun:test";
import type { TorrentInfo } from "@remagnet/qbittorrent";
import { normalizeQBittorrentState, toTorrentSummary } from "./qbittorrent";

describe("normalizeQBittorrentState", () => {
  const cases: Array<[string, string]> = [
    ["allocating", "checking"],
    ["checkingDL", "checking"],
    ["checkingResumeData", "checking"],
    ["checkingUP", "checking"],
    ["metaDL", "metadata"],
    ["downloading", "downloading"],
    ["forcedDL", "downloading"],
    ["stalledDL", "stalled"],
    ["queuedDL", "queued"],
    ["queuedUP", "queued"],
    ["moving", "moving"],
    ["uploading", "seeding"],
    ["forcedUP", "seeding"],
    ["stalledUP", "seeding"],
    ["pausedDL", "stopped"],
    ["pausedUP", "stopped"],
    ["stoppedDL", "stopped"],
    ["stoppedUP", "stopped"],
    ["error", "error"],
    ["missingFiles", "missingFiles"],
    ["unknown", "unknown"],
  ];

  for (const [raw, expected] of cases) {
    test(`${raw} -> ${expected}`, () => {
      expect(normalizeQBittorrentState(raw)).toBe(expected);
    });
  }

  test("passes future states through", () => {
    expect(normalizeQBittorrentState("someNewState")).toBe("someNewState");
  });
});

describe("toTorrentSummary", () => {
  test("maps Web API fields into the neutral summary", () => {
    const raw = {
      hash: "abc",
      name: "Example",
      state: "stalledUP",
      progress: 1,
      size: 1024,
      dlspeed: 0,
      upspeed: 2048,
      eta: 8_640_000,
      ratio: 1.5,
      category: "tv",
      tags: "remagnet, linux",
      num_seeds: 3,
      num_leechs: 4,
    } as TorrentInfo;

    expect(toTorrentSummary(raw)).toEqual({
      hash: "abc",
      name: "Example",
      state: "seeding",
      progress: 1,
      size: 1024,
      downloadSpeed: 0,
      uploadSpeed: 2048,
      eta: 8_640_000,
      ratio: 1.5,
      category: "tv",
      tags: ["remagnet", "linux"],
      seeds: 3,
      peers: 4,
    });
  });

  test("treats blank tags as an empty list", () => {
    const raw = { tags: "  " } as TorrentInfo;
    expect(toTorrentSummary(raw).tags).toEqual([]);
  });
});
