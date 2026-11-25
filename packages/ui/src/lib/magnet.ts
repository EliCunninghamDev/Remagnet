import { trackerHostsFromList } from "./torrent-file";

/** Characters of an info hash kept when a full name is unavailable. */
export const SHORT_HASH_LENGTH = 12;

/** A parsed magnet link. */
export interface MagnetLink {
  /** The original, trimmed URI. */
  uri: string;
  /** Lowercase hex info hash, when the URI contains a BitTorrent v1 hash. */
  infoHash: string | null;
  /** The `dn` display name. */
  displayName: string | null;
  /** The `xl` exact length in bytes, when present. */
  size: number | null;
  /** Tracker URLs from all `tr` parameters. */
  trackers: string[];
  /** Web seed URLs from all `ws` parameters. */
  webSeeds: string[];
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HEX_HASH = /^[0-9a-f]{40}$/i;
const BASE32_HASH = /^[a-z2-7]{32}$/i;

/**
 * Parse the parts of a magnet URI that are useful before the torrent is added.
 *
 * This deliberately does not try to fetch metadata: only qBittorrent (or a
 * DHT-capable client) can resolve the file list, and doing that here would
 * mean downloading the metadata twice.
 */
export function parseMagnet(uri: string): MagnetLink | null {
  const trimmed = uri.trim();
  if (!/^magnet:\?/i.test(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const params = url.searchParams;
  const infoHash =
    params
      .getAll("xt")
      .map(parseBitTorrentHash)
      .find((hash): hash is string => hash !== null) ?? null;

  const displayName = params.get("dn")?.trim() || null;
  const length = params.get("xl");
  const size = length && /^\d+$/.test(length) ? Number(length) : null;

  return {
    uri: trimmed,
    infoHash,
    displayName,
    size,
    trackers: params
      .getAll("tr")
      .map((value) => value.trim())
      .filter(Boolean),
    webSeeds: params
      .getAll("ws")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

export function isMagnetLink(value: string): boolean {
  return /^magnet:\?/i.test(value.trim());
}

/**
 * Pick a magnet URI out of a link URL or surrounding text.
 *
 * Context menus hand over either a link's `href` or a selection, and selections
 * often include quotes, brackets or trailing punctuation around the URI.
 */
export function magnetFromText(value: string | undefined): string | null {
  if (!value) return null;

  for (const token of value.trim().split(/\s+/)) {
    const candidate = token.replace(/^[<("'[]+/, "").replace(/[>)"'\].,;]+$/, "");
    if (parseMagnet(candidate)) return candidate;
  }

  return null;
}

/** A readable label for a parsed magnet, falling back to a short hash. */
export function magnetLabel(magnet: MagnetLink): string {
  if (magnet.displayName) return magnet.displayName;
  if (magnet.infoHash) return magnet.infoHash.slice(0, SHORT_HASH_LENGTH);
  return "Magnet link";
}

/** Unique tracker hostnames, for a compact summary. */
export function trackerHosts(magnet: MagnetLink): string[] {
  return trackerHostsFromList(magnet.trackers);
}

function parseBitTorrentHash(value: string): string | null {
  const match = /^urn:btih:([a-z0-9]+)$/i.exec(value.trim());
  if (!match?.[1]) return null;

  const hash = match[1];
  if (HEX_HASH.test(hash)) return hash.toLowerCase();
  if (BASE32_HASH.test(hash)) return base32ToHex(hash);
  return null;
}

/** Decode an RFC 4648 base32 info hash (without padding) to lowercase hex. */
function base32ToHex(value: string): string | null {
  const clean = value.toUpperCase().replace(/=+$/, "");
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;

  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) return null;

    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  if (bytes.length !== 20) return null;
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
