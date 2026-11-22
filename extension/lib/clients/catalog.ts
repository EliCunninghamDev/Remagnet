import type { ClientKind, TorrentClientDefinition } from "./types";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const qbittorrent: TorrentClientDefinition = {
  kind: "qbittorrent",
  label: "qBittorrent",
  description: "qBittorrent Web API v2. API keys require qBittorrent 5.2 or newer.",
  authModes: ["apiKey", "password"],
  defaultBaseUrl: "http://127.0.0.1:8080",
  apiKeyPlaceholder: "qbt_…",
  apiKeyHelp: "Generate one under Preferences → Web UI → API Key.",
  capabilities: {
    categories: true,
    tags: true,
    pauseOnAdd: true,
    completedFileDownload: true,
  },
  validate(settings) {
    if (!isHttpUrl(settings.baseUrl)) {
      return "Enter a valid http:// or https:// Web UI URL.";
    }
    if (settings.authMode === "apiKey" && !settings.apiKey.trim()) {
      return "Enter an API key, or switch to username & password.";
    }
    if (settings.authMode === "password" && !settings.username.trim()) {
      return "Enter a username, or switch to an API key.";
    }
    return null;
  },
};

/**
 * Every supported client, keyed by kind.
 *
 * `satisfies Record<ClientKind, …>` makes TypeScript complain when a new kind is
 * added to the union but no catalog entry is registered.
 */
export const TORRENT_CLIENTS = {
  qbittorrent,
} satisfies Record<ClientKind, TorrentClientDefinition>;

/** Catalog entries in a stable order for pickers. */
export const TORRENT_CLIENT_LIST: readonly TorrentClientDefinition[] =
  Object.values(TORRENT_CLIENTS);

export function getTorrentClientDefinition(kind: ClientKind): TorrentClientDefinition {
  return TORRENT_CLIENTS[kind];
}
