import { describe, expect, test } from "bun:test";
import { computeToolbarBadge } from "./badge";
import type { TorrentState, TorrentSummary } from "./torrents";

function torrent(hash: string, state: TorrentState, progress = 0.4): TorrentSummary {
  return {
    hash,
    name: `Torrent ${hash}`,
    state,
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

describe("computeToolbarBadge", () => {
  test("counts active torrents with the steel-blue badge", () => {
    const badge = computeToolbarBadge([
      torrent("a", "downloading"),
      torrent("b", "checking"),
      torrent("c", "metadata"),
    ]);

    expect(badge).toEqual({
      text: "3",
      color: "#4f7595",
      title: "Remagnet · 3 active",
    });
  });

  test("mentions ready torrents alongside the active count", () => {
    const badge = computeToolbarBadge([
      torrent("a", "downloading"),
      torrent("b", "stalled"),
      torrent("c", "seeding", 1),
    ]);

    expect(badge.text).toBe("2");
    expect(badge.color).toBe("#4f7595");
    expect(badge.title).toBe("Remagnet · 2 active, 1 ready");
  });

  test("caps active counts at 99+", () => {
    const torrents = Array.from({ length: 100 }, (_, index) =>
      torrent(`active-${index}`, "downloading"),
    );

    const badge = computeToolbarBadge(torrents);

    expect(badge.text).toBe("99+");
    expect(badge.color).toBe("#4f7595");
    expect(badge.title).toBe("Remagnet · 100 active");
  });

  test("prioritizes active torrents over errored and ready ones", () => {
    const badge = computeToolbarBadge([
      torrent("a", "downloading"),
      torrent("b", "error"),
      torrent("c", "seeding", 1),
    ]);

    expect(badge.text).toBe("1");
    expect(badge.title).toBe("Remagnet · 1 active, 1 ready");
  });

  test("shows an exclamation badge for a single errored torrent", () => {
    const badge = computeToolbarBadge([torrent("a", "error")]);

    expect(badge).toEqual({
      text: "!",
      color: "#8d3838",
      title: "Remagnet · 1 torrent errored",
    });
  });

  test("pluralizes multiple errored torrents", () => {
    const badge = computeToolbarBadge([torrent("a", "error"), torrent("b", "missingFiles", 1)]);

    expect(badge.text).toBe("!");
    expect(badge.color).toBe("#8d3838");
    expect(badge.title).toBe("Remagnet · 2 torrents errored");
  });

  test("treats missing files as errored", () => {
    const badge = computeToolbarBadge([torrent("a", "missingFiles", 1)]);

    expect(badge.text).toBe("!");
    expect(badge.title).toBe("Remagnet · 1 torrent errored");
  });

  test("shows a green count for a single ready torrent", () => {
    const badge = computeToolbarBadge([torrent("a", "seeding", 1)]);

    expect(badge).toEqual({
      text: "1",
      color: "#4e735d",
      title: "Remagnet · 1 torrent ready to download",
    });
  });

  test("pluralizes multiple ready torrents", () => {
    const badge = computeToolbarBadge([torrent("a", "seeding", 1), torrent("b", "stopped", 1)]);

    expect(badge.text).toBe("2");
    expect(badge.color).toBe("#4e735d");
    expect(badge.title).toBe("Remagnet · 2 torrents ready to download");
  });

  test("caps ready counts at 99+", () => {
    const torrents = Array.from({ length: 120 }, (_, index) =>
      torrent(`ready-${index}`, "seeding", 1),
    );

    const badge = computeToolbarBadge(torrents);

    expect(badge.text).toBe("99+");
    expect(badge.color).toBe("#4e735d");
    expect(badge.title).toBe("Remagnet · 120 torrents ready to download");
  });

  test("leaves the badge blank when only paused incomplete torrents exist", () => {
    const badge = computeToolbarBadge([torrent("a", "stopped"), torrent("b", "stopped")]);

    expect(badge).toEqual({
      text: "",
      color: "#4f7595",
      title: "Remagnet",
    });
  });

  test("leaves the badge blank for an empty list", () => {
    expect(computeToolbarBadge([])).toEqual({
      text: "",
      color: "#4f7595",
      title: "Remagnet",
    });
  });
});
