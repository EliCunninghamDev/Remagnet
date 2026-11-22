import { describe, expect, test } from "bun:test";
import type { Settings } from "../settings";
import { getTorrentClientDefinition, TORRENT_CLIENT_LIST, TORRENT_CLIENTS } from "./catalog";

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

describe("client catalog", () => {
  test("lists qBittorrent and resolves it by kind", () => {
    expect(TORRENT_CLIENTS.qbittorrent.label).toBe("qBittorrent");
    expect(getTorrentClientDefinition("qbittorrent")).toBe(TORRENT_CLIENTS.qbittorrent);
    expect(TORRENT_CLIENT_LIST.map((client) => client.kind)).toContain("qbittorrent");
  });

  test("advertises the capabilities the add flow uses", () => {
    expect(TORRENT_CLIENTS.qbittorrent.capabilities).toEqual({
      categories: true,
      tags: true,
      pauseOnAdd: true,
      completedFileDownload: true,
    });
  });
});

describe("qBittorrent settings validation", () => {
  const validate = (overrides: Partial<Settings> = {}) =>
    getTorrentClientDefinition("qbittorrent").validate(settings(overrides));

  test("accepts API key and password modes", () => {
    expect(validate()).toBeNull();
    expect(validate({ authMode: "password", username: "admin" })).toBeNull();
  });

  test("rejects non-http URLs and empty hosts", () => {
    expect(validate({ baseUrl: "ftp://example.com" })).toContain("http://");
    expect(validate({ baseUrl: "not a url" })).toContain("http://");
    expect(validate({ baseUrl: "http://" })).toContain("http://");
  });

  test("requires the credentials for the selected mode", () => {
    expect(validate({ apiKey: "  " })).toContain("API key");
    expect(validate({ authMode: "password", username: " " })).toContain("username");
  });
});
