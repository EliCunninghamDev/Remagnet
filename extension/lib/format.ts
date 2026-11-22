const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Unknown/unlimited ETA reported by torrent clients (qBittorrent uses 8640000). */
const ETA_UNKNOWN = 8_640_000;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : 1;

  return `${Number(value.toFixed(digits))} ${BYTE_UNITS[exponent] ?? "B"}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(progress: number): string {
  if (!Number.isFinite(progress)) return "0%";
  return `${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%`;
}

/** Names up to this many characters fit on one row without splitting. */
const TORRENT_NAME_FIT = 28;
/** Characters kept at the end so the extension stays visible. */
const TORRENT_NAME_TAIL = 16;
/** How far left to look for a natural split point (dot, dash, space, underscore). */
const TORRENT_NAME_BOUNDARY = 5;
const NAME_SEPARATOR = /[\s._-]/;

/**
 * Split a long torrent name into a start and an end, leaving the middle to be
 * clipped by CSS. Concatenating the parts returns the original name, so the
 * visible text and the `title` tooltip stay complete.
 */
export function splitTorrentName(name: string): { head: string; tail: string } {
  const characters = Array.from(name);
  if (characters.length <= TORRENT_NAME_FIT) return { head: name, tail: "" };

  let start = characters.length - TORRENT_NAME_TAIL;
  // Prefer a boundary a few characters to the left so the end of the name does
  // not begin in the middle of a group or extension.
  for (let index = start; index > start - TORRENT_NAME_BOUNDARY && index > 0; index -= 1) {
    if (NAME_SEPARATOR.test(characters[index - 1] ?? "")) {
      start = index;
      break;
    }
  }

  return {
    head: characters.slice(0, start).join(""),
    tail: characters.slice(start).join(""),
  };
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= ETA_UNKNOWN) return "—";
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Labels for the normalized states produced by client adapters. */
const STATE_LABELS: Record<string, string> = {
  checking: "Checking",
  metadata: "Fetching metadata",
  downloading: "Downloading",
  stalled: "Stalled",
  queued: "Queued",
  moving: "Moving",
  seeding: "Seeding",
  stopped: "Stopped",
  error: "Error",
  missingFiles: "Missing files",
  unknown: "Unknown",
};

export type StateTone = "active" | "good" | "warn" | "bad" | "idle";

const ACTIVE_STATES = new Set(["checking", "metadata", "downloading", "moving"]);
const GOOD_STATES = new Set(["seeding"]);
const BAD_STATES = new Set(["error", "missingFiles"]);

export function stateLabel(state: string): string {
  const known = STATE_LABELS[state];
  if (known) return known;
  // Fall back to something readable for states added by future adapters.
  return state.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase());
}

export function stateTone(state: string): StateTone {
  if (BAD_STATES.has(state)) return "bad";
  if (GOOD_STATES.has(state)) return "good";
  if (ACTIVE_STATES.has(state)) return "active";
  if (state === "stalled") return "warn";
  return "idle";
}
