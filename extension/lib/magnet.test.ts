import { describe, expect, test } from "bun:test";
import { isMagnetLink, magnetFromText, magnetLabel, parseMagnet, trackerHosts } from "./magnet";

const HEX = "d540fc48eb12f2833163eed6421d449dd8f1ce1f";
const BASE32 = "2VAPYSHLCLZIGMLD53LEEHKETXMPDTQ7";

describe("parseMagnet", () => {
  test("parses a hex info hash, name, size and trackers", () => {
    const magnet = parseMagnet(
      `magnet:?xt=urn:btih:${HEX}&dn=Ubuntu+desktop+24.04&xl=123456&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce&tr=https%3A%2F%2Fbackup.example%2Fa`,
    );

    expect(magnet).not.toBeNull();
    expect(magnet?.infoHash).toBe(HEX);
    expect(magnet?.displayName).toBe("Ubuntu desktop 24.04");
    expect(magnet?.size).toBe(123456);
    expect(magnet?.trackers).toEqual([
      "udp://tracker.example:1337/announce",
      "https://backup.example/a",
    ]);
  });

  test("normalizes a base32 info hash", () => {
    const magnet = parseMagnet(`magnet:?xt=urn:btih:${BASE32}&dn=Base32`);
    expect(magnet?.infoHash).toBe("d540fc48eb12f2833163eed6421d449dd8f1ce1f");
  });

  test("prefers the first usable xt parameter", () => {
    const magnet = parseMagnet(
      `magnet:?xt=urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&xt=urn:btih:${HEX}`,
    );
    expect(magnet?.infoHash).toBe(HEX);
  });

  test("ignores missing and malformed optional fields", () => {
    const magnet = parseMagnet("magnet:?xt=urn:btih:not-a-hash&xl=abc");
    expect(magnet?.infoHash).toBeNull();
    expect(magnet?.size).toBeNull();
    expect(magnet?.displayName).toBeNull();
  });

  test("rejects non-magnet and malformed URIs", () => {
    expect(parseMagnet("https://example.com/file.torrent")).toBeNull();
    expect(parseMagnet("magnet:")).toBeNull();
    expect(parseMagnet("")).toBeNull();
  });
});

describe("magnet helpers", () => {
  test("checks the scheme", () => {
    expect(isMagnetLink(`magnet:?xt=urn:btih:${HEX}`)).toBe(true);
    expect(isMagnetLink("  MAGNET:?xt=urn:btih:ABC  ")).toBe(true);
    expect(isMagnetLink("https://example.com")).toBe(false);
  });

  test("finds a magnet in a link URL or selection text", () => {
    const magnet = `magnet:?xt=urn:btih:${HEX}&dn=Example`;

    expect(magnetFromText(magnet)).toBe(magnet);
    expect(magnetFromText(`  ${magnet}  `)).toBe(magnet);
    expect(magnetFromText(`Download: <${magnet}>.`)).toBe(magnet);
    expect(magnetFromText(`("${magnet}")`)).toBe(magnet);
  });

  test("ignores text without a usable magnet", () => {
    expect(magnetFromText(undefined)).toBeNull();
    expect(magnetFromText("")).toBeNull();
    expect(magnetFromText("https://example.com/file.torrent")).toBeNull();
    expect(magnetFromText("magnet:")).toBeNull();
  });

  test("labels a magnet by name, hash or a generic fallback", () => {
    expect(magnetLabel({ displayName: "Name" } as never)).toBe("Name");
    expect(magnetLabel({ displayName: null, infoHash: HEX } as never)).toBe(HEX.slice(0, 12));
    expect(magnetLabel({ displayName: null, infoHash: null } as never)).toBe("Magnet link");
  });

  test("reduces trackers to unique, valid hosts", () => {
    const magnet = parseMagnet(
      `magnet:?xt=urn:btih:${HEX}&tr=https%3A%2F%2Fa.example%2Fannounce&tr=https%3A%2F%2Fa.example%2Fother&tr=not-a-url`,
    );
    expect(trackerHosts(magnet as never)).toEqual(["a.example"]);
  });
});
