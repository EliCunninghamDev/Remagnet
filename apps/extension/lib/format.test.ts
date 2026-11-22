import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  stateLabel,
  stateTone,
} from "./format";

describe("formatBytes", () => {
  test("handles zero, negatives and non-finite values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  test("scales by powers of 1024", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(250 * 1024 * 1024 * 1024)).toBe("250 GB");
  });
});

describe("formatSpeed", () => {
  test("appends per-second suffix", () => {
    expect(formatSpeed(0)).toBe("0 B/s");
    expect(formatSpeed(1024 ** 2)).toBe("1 MB/s");
  });
});

describe("formatPercent", () => {
  test("rounds and clamps", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.426)).toBe("43%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(1.4)).toBe("100%");
    expect(formatPercent(-1)).toBe("0%");
  });
});

describe("formatEta", () => {
  test("formats durations and hides unknown values", () => {
    expect(formatEta(0)).toBe("—");
    expect(formatEta(30)).toBe("30s");
    expect(formatEta(90)).toBe("1m");
    expect(formatEta(3 * 3600 + 5 * 60)).toBe("3h 5m");
    expect(formatEta(2 * 86_400 + 3600)).toBe("2d 1h");
    expect(formatEta(8_640_000)).toBe("—");
  });
});

describe("state helpers", () => {
  test("maps normalized states", () => {
    expect(stateLabel("seeding")).toBe("Seeding");
    expect(stateLabel("stopped")).toBe("Stopped");
    expect(stateLabel("downloading")).toBe("Downloading");
    expect(stateLabel("metadata")).toBe("Fetching metadata");
  });

  test("humanizes unknown states", () => {
    expect(stateLabel("someNewState")).toBe("Some New State");
  });

  test("groups states into tones", () => {
    expect(stateTone("downloading")).toBe("active");
    expect(stateTone("seeding")).toBe("good");
    expect(stateTone("stalled")).toBe("warn");
    expect(stateTone("missingFiles")).toBe("bad");
    expect(stateTone("stopped")).toBe("idle");
  });
});
