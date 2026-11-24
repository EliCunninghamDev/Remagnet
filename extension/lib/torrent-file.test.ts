import { describe, expect, test } from "bun:test";
import {
  MAX_TORRENT_FILE_BYTES,
  parseTorrentBytes,
  parseTorrentFile,
  torrentFileLabel,
  trackerHostsFromList,
} from "./torrent-file";

type BencodeInput = string | number | Uint8Array | BencodeInput[] | { [key: string]: BencodeInput };

const text = new TextEncoder();

describe("parseTorrentBytes", () => {
  test("parses a single-file v1 torrent", async () => {
    const info: BencodeInput = {
      length: 4096,
      name: "Ubuntu desktop",
      "piece length": 16384,
      pieces: new Uint8Array(20).fill(0xab),
    };
    const bytes = bencode({
      announce: "udp://tracker.example:1337/announce",
      "url-list": "https://seed.example/ubuntu.iso",
      info,
    });

    const parsed = await parseTorrentBytes(bytes, "ubuntu.torrent");

    expect(parsed.filename).toBe("ubuntu.torrent");
    expect(parsed.infoHash).toBe(await digestHex("SHA-1", bencode(info)));
    expect(parsed.infoHash).toHaveLength(40);
    expect(parsed.displayName).toBe("Ubuntu desktop");
    expect(parsed.size).toBe(4096);
    expect(parsed.fileCount).toBe(1);
    expect(parsed.trackers).toEqual(["udp://tracker.example:1337/announce"]);
    expect(parsed.webSeeds).toEqual(["https://seed.example/ubuntu.iso"]);
    expect(parsed.isPrivate).toBe(false);
    expect(base64Bytes(parsed.dataBase64)).toEqual(bytes);
  });

  test("parses a multi-file v1 torrent with announce-list and private flag", async () => {
    const info: BencodeInput = {
      files: [
        { length: 1024, path: ["part-one.bin"] },
        { length: 2048, path: ["part-two.bin"] },
      ],
      name: "Multi",
      private: 1,
      "piece length": 16384,
      pieces: new Uint8Array(20).fill(0x11),
    };
    const bytes = bencode({
      announce: "udp://tracker.example/announce",
      "announce-list": [
        ["udp://tracker.example/announce", "https://backup.example/announce"],
        ["udp://other.example/announce"],
      ],
      info,
    });

    const parsed = await parseTorrentBytes(bytes, "multi.torrent");

    expect(parsed.infoHash).toBe(await digestHex("SHA-1", bencode(info)));
    expect(parsed.displayName).toBe("Multi");
    expect(parsed.size).toBe(3072);
    expect(parsed.fileCount).toBe(2);
    expect(parsed.trackers).toEqual([
      "udp://tracker.example/announce",
      "https://backup.example/announce",
      "udp://other.example/announce",
    ]);
    expect(parsed.isPrivate).toBe(true);
  });

  test("parses a v2-only torrent with a SHA-256 info hash", async () => {
    const info: BencodeInput = {
      "file tree": {
        "disc-one": { "": { length: 1024 } },
        "disc-two": { nested: { "": { length: 2048 } } },
      },
      "meta version": 2,
      name: "v2-only",
      "piece length": 16384,
    };
    const bytes = bencode({ info });

    const parsed = await parseTorrentBytes(bytes, "v2.torrent");

    expect(parsed.infoHash).toBe(await digestHex("SHA-256", bencode(info)));
    expect(parsed.infoHash).toHaveLength(64);
    expect(parsed.displayName).toBe("v2-only");
    expect(parsed.size).toBe(3072);
    expect(parsed.fileCount).toBe(2);
  });

  test("uses the v1 SHA-1 hash for hybrid torrents", async () => {
    const info: BencodeInput = {
      files: [{ length: 4096, path: ["hybrid.bin"] }],
      "file tree": { "hybrid.bin": { "": { length: 4096 } } },
      "meta version": 2,
      name: "Hybrid",
      "piece length": 16384,
      pieces: new Uint8Array(20).fill(0x22),
    };
    const bytes = bencode({ info });

    const parsed = await parseTorrentBytes(bytes);

    expect(parsed.infoHash).toBe(await digestHex("SHA-1", bencode(info)));
    expect(parsed.infoHash).toHaveLength(40);
    expect(parsed.size).toBe(4096);
    expect(parsed.fileCount).toBe(1);
  });

  test("rejects empty and oversized files", async () => {
    await expect(parseTorrentBytes(new Uint8Array())).rejects.toThrow(/empty/i);
    await expect(parseTorrentBytes(new Uint8Array(MAX_TORRENT_FILE_BYTES + 1))).rejects.toThrow(
      /too large/i,
    );
  });

  test("rejects malformed bencode and trailing bytes", async () => {
    await expect(parseTorrentBytes(text.encode("not bencode"))).rejects.toThrow(
      /bencoded dictionary/i,
    );
    await expect(parseTorrentBytes(text.encode("d3:fooi1e"))).rejects.toThrow(
      /ends in the middle/i,
    );
    await expect(parseTorrentBytes(text.encode("d3:foo!"))).rejects.toThrow(/cannot read/i);
  });

  test("rejects a torrent without an info dictionary", async () => {
    await expect(parseTorrentBytes(bencode({ announce: "udp://tracker.example" }))).rejects.toThrow(
      /no info dictionary/i,
    );
  });

  test("rejects trailing data after the root dictionary", async () => {
    const bytes = bencode({
      info: { length: 1, name: "Tiny", pieces: new Uint8Array(20) },
    });

    await expect(parseTorrentBytes(concat([bytes, text.encode("x")]))).rejects.toThrow(/trailing/i);
  });
});

describe("parseTorrentFile", () => {
  test("reads a File and keeps its filename", async () => {
    const file = new File(
      [bencode({ info: { length: 1, name: "Tiny", pieces: new Uint8Array(20) } }) as BlobPart],
      "Example.TORRENT",
    );

    const parsed = await parseTorrentFile(file);

    expect(parsed.filename).toBe("Example.TORRENT");
    expect(torrentFileLabel(parsed)).toBe("Tiny");
  });
});

describe("torrent helpers", () => {
  test("labels a torrent by display name, filename or short hash", () => {
    const base = {
      filename: "Example.torrent",
      dataBase64: "",
      infoHash: "abcdef1234567890",
      displayName: null,
      size: null,
      fileCount: 0,
      trackers: [],
      webSeeds: [],
      isPrivate: false,
    };

    expect(torrentFileLabel({ ...base, displayName: "Name" })).toBe("Name");
    expect(torrentFileLabel(base)).toBe("Example");
    expect(torrentFileLabel({ ...base, filename: "" })).toBe("abcdef123456");
  });

  test("reduces trackers to unique, valid hosts", () => {
    expect(
      trackerHostsFromList(["https://a.example/announce", "https://a.example/other", "not-a-url"]),
    ).toEqual(["a.example"]);
  });
});

function bencode(value: BencodeInput): Uint8Array {
  if (typeof value === "string") return byteString(text.encode(value));
  if (typeof value === "number") return text.encode(`i${value}e`);
  if (value instanceof Uint8Array) return byteString(value);
  if (Array.isArray(value)) {
    return concat([text.encode("l"), ...value.map(bencode), text.encode("e")]);
  }

  const parts: Uint8Array[] = [text.encode("d")];
  for (const key of Object.keys(value).sort()) {
    parts.push(byteString(text.encode(key)), bencode(value[key] as BencodeInput));
  }
  parts.push(text.encode("e"));
  return concat(parts);
}

function byteString(bytes: Uint8Array): Uint8Array {
  return concat([text.encode(`${bytes.byteLength}:`), bytes]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }

  return result;
}

async function digestHex(algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(algorithm, bytes as BufferSource));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
