/** Largest `.torrent` metainfo file the extension will parse. */
export const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024;

/** A `.torrent` file reduced to the details the add flow shows before uploading. */
export interface ParsedTorrentFile {
  /** Original filename, including the `.torrent` suffix when the browser knows it. */
  filename: string;
  /** Standard base64 of the original bytes, ready for the proxy's `files` field. */
  dataBase64: string;
  /** Lowercase hex info hash: SHA-1 for v1/hybrid, SHA-256 for v2-only. */
  infoHash: string;
  /** The `name.utf-8` or `name` field, when present. */
  displayName: string | null;
  /** Total size in bytes, when the metainfo describes it. */
  size: number | null;
  /** Number of files in the torrent, or `0` when unknown. */
  fileCount: number;
  /** Tracker URLs from `announce` and `announce-list`. */
  trackers: string[];
  /** Web seed URLs from `url-list`. */
  webSeeds: string[];
  /** Whether the torrent is marked private. */
  isPrivate: boolean;
}

type BencodeValue =
  | { kind: "integer"; value: number }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "list"; value: BencodeValue[] }
  | { kind: "dictionary"; value: Map<string, BencodeValue> };

const MAX_DEPTH = 64;
const UTF8 = new TextDecoder();

/**
 * Parse a `.torrent` file without any dependency.
 *
 * The info hash must be computed over the exact `info` bytes as they appear in
 * the file, so the parser records the byte span of that dictionary instead of
 * re-encoding it.
 */
export async function parseTorrentBytes(
  bytes: Uint8Array,
  filename = "",
): Promise<ParsedTorrentFile> {
  if (bytes.byteLength === 0) throw new Error("The .torrent file is empty.");
  if (bytes.byteLength > MAX_TORRENT_FILE_BYTES) throw tooLargeError();

  const { root, infoBytes } = new BencodeParser(bytes).parseRoot();
  const info = root.get("info");
  if (info?.kind !== "dictionary") throw new Error("The .torrent file has no info dictionary.");
  const contents = torrentContents(info.value);

  return {
    filename,
    dataBase64: encodeBase64(bytes),
    infoHash: await infoHash(infoBytes, info.value),
    displayName: firstText(info.value, ["name.utf-8", "name"]),
    size: contents.size,
    fileCount: contents.fileCount,
    trackers: trackersFromRoot(root),
    webSeeds: webSeedsFromRoot(root),
    isPrivate: integerValue(info.value.get("private")) === 1,
  };
}

/** Read and parse a browser `File`, rejecting empty and oversized torrents early. */
export async function parseTorrentFile(file: File): Promise<ParsedTorrentFile> {
  if (file.size === 0) throw new Error("The .torrent file is empty.");
  if (file.size > MAX_TORRENT_FILE_BYTES) throw tooLargeError();
  return parseTorrentBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

/** A readable label for a parsed torrent, falling back to a short hash. */
export function torrentFileLabel(file: ParsedTorrentFile): string {
  if (file.displayName) return file.displayName;

  const filename = file.filename.replace(/\.torrent$/i, "").trim();
  if (filename) return filename;

  return file.infoHash.slice(0, 12);
}

/** Unique tracker hostnames, for a compact summary. */
export function trackerHostsFromList(trackers: string[]): string[] {
  const hosts = new Set<string>();
  for (const tracker of trackers) {
    try {
      hosts.add(new URL(tracker).host);
    } catch {
      // Trackers are not always valid URLs; ignore malformed ones.
    }
  }
  return [...hosts];
}

class BencodeParser {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  /** Parse the root dictionary and remember the raw span of its `info` value. */
  parseRoot(): { root: Map<string, BencodeValue>; infoBytes: Uint8Array } {
    if (this.peek() !== 0x64) {
      throw new Error("A .torrent file must be a bencoded dictionary.");
    }
    this.offset += 1;

    const root = new Map<string, BencodeValue>();
    let infoBytes: Uint8Array | undefined;

    while (true) {
      const byte = this.peek();
      if (byte === undefined) {
        throw new Error("The .torrent file ends in the middle of its root dictionary.");
      }
      if (byte === 0x65) {
        this.offset += 1;
        break;
      }
      if (!isDigit(byte)) {
        throw new Error("The .torrent file has a top-level key that is not a byte string.");
      }

      const key = UTF8.decode(this.parseByteString());
      const start = this.offset;
      const value = this.parseValue(1);
      const end = this.offset;

      if (key === "info") {
        if (value.kind !== "dictionary") {
          throw new Error("The torrent info value must be a bencoded dictionary.");
        }
        if (infoBytes) {
          throw new Error("The .torrent file contains more than one info dictionary.");
        }
        infoBytes = this.bytes.subarray(start, end);
      }

      root.set(key, value);
    }

    if (this.offset !== this.bytes.byteLength) {
      throw new Error("The .torrent file has trailing data after the root dictionary.");
    }
    if (!infoBytes) throw new Error("The .torrent file has no info dictionary.");

    return { root, infoBytes };
  }

  private parseValue(depth: number): BencodeValue {
    if (depth > MAX_DEPTH) {
      throw new Error("The .torrent file is nested too deeply to read.");
    }

    const byte = this.peek();
    if (byte === undefined) throw new Error("The .torrent file ends unexpectedly.");
    if (byte === 0x69) return this.parseInteger();
    if (byte === 0x6c) return this.parseList(depth + 1);
    if (byte === 0x64) return this.parseDictionary(depth + 1);
    if (isDigit(byte)) return { kind: "bytes", value: this.parseByteString() };

    throw new Error("The .torrent file contains bencode the extension cannot read.");
  }

  private parseList(depth: number): BencodeValue {
    this.offset += 1;
    const items: BencodeValue[] = [];

    while (true) {
      const byte = this.peek();
      if (byte === undefined) {
        throw new Error("The .torrent file ends in the middle of a list.");
      }
      if (byte === 0x65) {
        this.offset += 1;
        return { kind: "list", value: items };
      }
      items.push(this.parseValue(depth));
    }
  }

  private parseDictionary(depth: number): BencodeValue {
    this.offset += 1;
    const entries = new Map<string, BencodeValue>();

    while (true) {
      const byte = this.peek();
      if (byte === undefined) {
        throw new Error("The .torrent file ends in the middle of a dictionary.");
      }
      if (byte === 0x65) {
        this.offset += 1;
        return { kind: "dictionary", value: entries };
      }
      if (!isDigit(byte)) {
        throw new Error("The .torrent file has a dictionary key that is not a byte string.");
      }

      const key = UTF8.decode(this.parseByteString());
      entries.set(key, this.parseValue(depth));
    }
  }

  private parseInteger(): BencodeValue {
    this.offset += 1;
    const start = this.offset;

    if (this.peek() === 0x2d) this.offset += 1;
    const digitsStart = this.offset;
    while (isDigit(this.peek())) this.offset += 1;

    if (this.offset === digitsStart) {
      throw new Error("The .torrent file has an integer without digits.");
    }
    if (this.peek() !== 0x65) {
      throw new Error("The .torrent file has an unterminated integer.");
    }
    if (this.bytes[digitsStart] === 0x30 && this.offset - digitsStart > 1) {
      throw new Error("The .torrent file has a non-canonical integer.");
    }

    const value = Number(UTF8.decode(this.bytes.subarray(start, this.offset)));
    this.offset += 1;
    if (!Number.isSafeInteger(value)) {
      throw new Error("The .torrent file has an integer outside the supported range.");
    }
    return { kind: "integer", value };
  }

  private parseByteString(): Uint8Array {
    const start = this.offset;
    while (isDigit(this.peek())) this.offset += 1;

    if (this.offset === start) {
      throw new Error("The .torrent file has a byte string without a length.");
    }
    if (this.peek() !== 0x3a) {
      throw new Error("The .torrent file has an unterminated byte string length.");
    }
    if (this.bytes[start] === 0x30 && this.offset - start > 1) {
      throw new Error("The .torrent file has a non-canonical byte string length.");
    }

    const length = Number(UTF8.decode(this.bytes.subarray(start, this.offset)));
    this.offset += 1;
    if (!Number.isSafeInteger(length)) {
      throw new Error("The .torrent file has a byte string length outside the supported range.");
    }

    const end = this.offset + length;
    if (end > this.bytes.byteLength) {
      throw new Error("The .torrent file has a byte string that runs past the end of the file.");
    }

    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  private peek(): number | undefined {
    return this.bytes[this.offset];
  }
}

async function infoHash(infoBytes: Uint8Array, info: Map<string, BencodeValue>): Promise<string> {
  if (info.get("pieces")?.kind === "bytes") {
    return digestHex("SHA-1", infoBytes);
  }
  if (integerValue(info.get("meta version")) === 2) {
    return digestHex("SHA-256", infoBytes);
  }
  throw new Error("The .torrent file has neither v1 piece hashes nor BitTorrent v2 metadata.");
}

function torrentContents(info: Map<string, BencodeValue>): {
  size: number | null;
  fileCount: number;
} {
  const length = integerValue(info.get("length"));
  if (length !== null) return { size: length, fileCount: 1 };

  const files = info.get("files");
  if (files?.kind === "list") {
    let size = 0;
    for (const file of files.value) {
      if (file.kind !== "dictionary") continue;
      size += integerValue(file.value.get("length")) ?? 0;
    }
    return { size, fileCount: files.value.length };
  }

  const tree = info.get("file tree");
  if (tree?.kind === "dictionary") {
    const stats = fileTreeStats(tree.value);
    return { size: stats.size, fileCount: stats.files };
  }

  return { size: null, fileCount: 0 };
}

function fileTreeStats(tree: Map<string, BencodeValue>): { size: number; files: number } {
  const leaf = tree.get("");
  if (leaf?.kind === "dictionary") {
    return { size: integerValue(leaf.value.get("length")) ?? 0, files: 1 };
  }

  let size = 0;
  let files = 0;
  for (const value of tree.values()) {
    if (value.kind !== "dictionary") continue;
    const stats = fileTreeStats(value.value);
    size += stats.size;
    files += stats.files;
  }
  return { size, files };
}

function trackersFromRoot(root: Map<string, BencodeValue>): string[] {
  const values: string[] = [];
  const announce = root.get("announce");
  if (announce?.kind === "bytes") values.push(UTF8.decode(announce.value));

  const announceList = root.get("announce-list");
  if (announceList) values.push(...flattenStrings(announceList));

  return uniqueStrings(values);
}

function webSeedsFromRoot(root: Map<string, BencodeValue>): string[] {
  const urlList = root.get("url-list");
  return urlList ? uniqueStrings(flattenStrings(urlList)) : [];
}

/** Flatten nested bencoded string lists, which is how `announce-list` is shaped. */
function flattenStrings(value: BencodeValue): string[] {
  if (value.kind === "bytes") return [UTF8.decode(value.value)];
  if (value.kind === "list") return value.value.flatMap(flattenStrings);
  return [];
}

function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function firstText(entries: Map<string, BencodeValue>, keys: string[]): string | null {
  for (const key of keys) {
    const value = entries.get(key);
    if (value?.kind !== "bytes") continue;
    const text = UTF8.decode(value.value).trim();
    if (text) return text;
  }
  return null;
}

function integerValue(value: BencodeValue | undefined): number | null {
  return value?.kind === "integer" ? value.value : null;
}

function isDigit(value: number | undefined): boolean {
  return value !== undefined && value >= 0x30 && value <= 0x39;
}

async function digestHex(algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(algorithm, bytes as BufferSource));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Convert bytes to standard base64 in chunks, avoiding huge spread call stacks. */
function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function tooLargeError(): Error {
  const mebibytes = MAX_TORRENT_FILE_BYTES / (1024 * 1024);
  return new Error(`The .torrent file is too large. The maximum is ${mebibytes} MiB.`);
}
