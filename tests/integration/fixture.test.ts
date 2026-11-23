import { describe, expect, test } from "bun:test";
import { bencode, buildTorrentFixture, sha256, toHex } from "./fixture";

describe("bencode", () => {
  test("encodes integers, strings, lists and sorted dictionaries", () => {
    const encoded = new TextDecoder().decode(
      bencode({
        z: 42,
        a: ["hi", new Uint8Array([65, 66])],
      }),
    );
    expect(encoded).toBe("d1:al2:hi2:ABe1:zi42ee");
  });
});

describe("buildTorrentFixture", () => {
  test("produces deterministic info hashes and payload checksums", async () => {
    const first = await buildTorrentFixture("remagnet-test.bin", "seed-a", 32_768);
    const second = await buildTorrentFixture("remagnet-test.bin", "seed-a", 32_768);
    const other = await buildTorrentFixture("other.bin", "seed-b", 32_768);

    expect(first.infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect(first.infoHash).toBe(second.infoHash);
    expect(first.infoHash).not.toBe(other.infoHash);
    expect(first.magnetUri).toBe(`magnet:?xt=urn:btih:${first.infoHash}&dn=remagnet-test.bin`);
    expect(toHex(await sha256(first.payloadBytes))).toBe(first.payloadSha256);
    expect(first.torrentBytes.length).toBeGreaterThan(80);
  });
});
