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
