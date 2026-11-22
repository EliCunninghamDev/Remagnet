import { describe, expect, test } from "bun:test";
import {
  archiveFilename,
  getArchiveSettings,
  requireArchiveSettings,
  validateArchiveSettings,
} from "./archive";
import type { Settings } from "./settings";

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

describe("archive settings", () => {
  test("blank settings disable the feature", () => {
    expect(getArchiveSettings(settings())).toBeNull();
    expect(validateArchiveSettings(settings())).toBeNull();
    expect(() => requireArchiveSettings(settings())).toThrow(/not configured/);
  });

  test("requires both halves of the configuration", () => {
    expect(validateArchiveSettings(settings({ archiveBaseUrl: "https://bridge.example" }))).toMatch(
      /token/,
    );
    expect(validateArchiveSettings(settings({ archiveToken: "a".repeat(32) }))).toMatch(/URL/);
  });

  test("validates the URL and token length", () => {
    expect(
      validateArchiveSettings(
        settings({ archiveBaseUrl: "ftp://bridge.example", archiveToken: "a".repeat(32) }),
      ),
    ).toMatch(/http/);
    expect(
      validateArchiveSettings(
        settings({ archiveBaseUrl: "https://bridge.example", archiveToken: "short" }),
      ),
    ).toMatch(/16/);
    expect(
      validateArchiveSettings(
        settings({
          archiveBaseUrl: "https://bridge.example/",
          archiveToken: "a".repeat(32),
        }),
      ),
    ).toBeNull();
  });
});

describe("archiveFilename", () => {
  test("keeps readable names and strips unsafe characters", () => {
    expect(archiveFilename("Trailer Park Boys")).toBe("Trailer Park Boys.zip");
    expect(archiveFilename("Show/Season: 1")).toBe("Show_Season_ 1.zip");
    expect(archiveFilename("../../")).toBe("torrent.zip");
    expect(archiveFilename("")).toBe("torrent.zip");
  });

  test("limits very long names", () => {
    expect(archiveFilename("x".repeat(300))).toBe(`${"x".repeat(140)}.zip`);
  });
});
