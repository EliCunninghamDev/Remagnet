/**
 * Deterministic offline BitTorrent v1 fixture builder and stored-ZIP reader for
 * containerized integration tests.
 *
 * Pre-seeding the generated payload file into the client's download volume lets
 * real qBittorrent and Transmission containers reach 100% completion in
 * milliseconds without contacting any external tracker or peer.
 */

export type BencodeValue =
  | number
  | string
  | Uint8Array
  | BencodeValue[]
  | { [key: string]: BencodeValue };

/** Default payload size used by integration fixtures (64 KiB). */
export const DEFAULT_FIXTURE_SIZE = 65_536;

/** ZIP signatures used by the stored-archive reader. */
export const ZIP_LOCAL_SIGNATURE = 0x04034b50;
export const ZIP_CD_SIGNATURE = 0x02014b50;
export const ZIP_EOCD_SIGNATURE = 0x06054b50;
export const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

/** Fixed header sizes and the maximum EOCD comment length, in bytes. */
export const ZIP_LOCAL_HEADER_SIZE = 30;
export const ZIP_CD_HEADER_SIZE = 46;
export const ZIP_EOCD_SIZE = 22;
export const ZIP_MAX_COMMENT_LENGTH = 65_535;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode a value into canonical BitTorrent bencode (keys sorted by raw bytes). */
export function bencode(value: BencodeValue): Uint8Array {
  const chunks: Uint8Array[] = [];
  encodeInto(value, chunks);
  return concatBytes(chunks);
}

function encodeInto(value: BencodeValue, chunks: Uint8Array[]): void {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`Bencode integers only, got ${value}`);
    chunks.push(encoder.encode(`i${value}e`));
    return;
  }

  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    chunks.push(encoder.encode(`${bytes.length}:`), bytes);
    return;
  }

  if (value instanceof Uint8Array) {
    chunks.push(encoder.encode(`${value.length}:`), value);
    return;
  }

  if (Array.isArray(value)) {
    chunks.push(encoder.encode("l"));
    for (const item of value) encodeInto(item, chunks);
    chunks.push(encoder.encode("e"));
    return;
  }

  chunks.push(encoder.encode("d"));
  const keys = Object.keys(value).sort((left, right) => {
    const a = encoder.encode(left);
    const b = encoder.encode(right);
    const limit = Math.min(a.length, b.length);
    for (let i = 0; i < limit; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  });
  for (const key of keys) {
    encodeInto(key, chunks);
    encodeInto(value[key], chunks);
  }
  chunks.push(encoder.encode("e"));
}

export interface TorrentFixture {
  name: string;
  infoHash: string;
  magnetUri: string;
  torrentBytes: Uint8Array;
  payloadBytes: Uint8Array;
  payloadSha256: string;
}

const PIECE_LENGTH = 16_384;

/** Build a deterministic single-file `.torrent` and matching payload bytes. */
export async function buildTorrentFixture(
  name: string,
  seed: string,
  size = DEFAULT_FIXTURE_SIZE,
): Promise<TorrentFixture> {
  const payloadBytes = new Uint8Array(size);
  const seedBytes = encoder.encode(seed);
  for (let i = 0; i < size; i += 1) {
    payloadBytes[i] = (seedBytes[i % seedBytes.length] + ((i * 31) & 0xff)) & 0xff;
  }

  const pieceHashes: Uint8Array[] = [];
  for (let offset = 0; offset < payloadBytes.length; offset += PIECE_LENGTH) {
    const slice = payloadBytes.subarray(
      offset,
      Math.min(offset + PIECE_LENGTH, payloadBytes.length),
    );
    pieceHashes.push(await sha1(slice));
  }

  const infoDict: { [key: string]: BencodeValue } = {
    length: payloadBytes.length,
    name,
    "piece length": PIECE_LENGTH,
    pieces: concatBytes(pieceHashes),
  };

  const infoBytes = bencode(infoDict);
  const infoHash = toHex(await sha1(infoBytes));
  const torrentBytes = bencode({
    "created by": "remagnet-integration-test",
    info: infoDict,
  });

  const payloadSha256 = toHex(await sha256(payloadBytes));
  const magnetUri = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;

  return {
    name,
    infoHash,
    magnetUri,
    torrentBytes,
    payloadBytes,
    payloadSha256,
  };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Parse a streamed stored (method 0) ZIP archive produced by Remagnet Proxy.
 *
 * Uses the Central Directory at the end of the archive so entries written with
 * streaming data descriptors (flag bit 3, zero sizes in local headers) are read
 * accurately.
 */
export function readStoredZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw new Error("Response is not a valid ZIP archive (missing EOCD signature).");
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  let cdOffset = view.getUint32(eocdOffset + 16, true);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(cdOffset, true) !== ZIP_CD_SIGNATURE) {
      throw new Error(`Invalid central directory header at offset ${cdOffset}.`);
    }
    const method = view.getUint16(cdOffset + 10, true);
    if (method !== 0) {
      throw new Error(`Expected stored (uncompressed) ZIP entry, got method ${method}.`);
    }
    const compressedSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);

    const name = decoder.decode(
      bytes.subarray(cdOffset + ZIP_CD_HEADER_SIZE, cdOffset + ZIP_CD_HEADER_SIZE + nameLen),
    );
    cdOffset += ZIP_CD_HEADER_SIZE + nameLen + extraLen + commentLen;

    if (view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error(`Invalid local file header for ${name}.`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + ZIP_LOCAL_HEADER_SIZE + localNameLen + localExtraLen;
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    entries.push({ name, data });
  }

  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minOffset = Math.max(0, view.byteLength - ZIP_EOCD_SIZE - ZIP_MAX_COMMENT_LENGTH);
  for (let offset = view.byteLength - ZIP_EOCD_SIZE; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/** Copy a Uint8Array into a standalone ArrayBuffer for WebCrypto calls. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function digest(algorithm: AlgorithmIdentifier, bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, toArrayBuffer(bytes)));
}

export async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  return digest("SHA-1", bytes);
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return digest("SHA-256", bytes);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
