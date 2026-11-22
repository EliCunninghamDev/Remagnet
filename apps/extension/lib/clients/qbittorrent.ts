import {
  QBittorrentClient,
  type QBittorrentClientOptions,
  QBittorrentError,
  type TorrentInfo,
} from "@remagnet/qbittorrent";
import { parseMagnet } from "../magnet";
import type { Settings } from "../settings";
import type { TorrentState, TorrentSummary } from "../torrents";
import { getTorrentClientDefinition } from "./catalog";
import type {
  AddTorrentRequest,
  AddTorrentResult,
  ConnectionDetails,
  RemoveTorrentRequest,
  TorrentClientAdapter,
} from "./types";

const definition = getTorrentClientDefinition("qbittorrent");

/** qBittorrent state name → normalized state used by the UI. */
const STATE_MAP: Record<string, TorrentState> = {
  allocating: "checking",
  checkingDL: "checking",
  checkingResumeData: "checking",
  checkingUP: "checking",
  downloading: "downloading",
  forcedDL: "downloading",
  metaDL: "metadata",
  stalledDL: "stalled",
  queuedDL: "queued",
  queuedUP: "queued",
  moving: "moving",
  uploading: "seeding",
  forcedUP: "seeding",
  stalledUP: "seeding",
  pausedDL: "stopped",
  pausedUP: "stopped",
  stoppedDL: "stopped",
  stoppedUP: "stopped",
  error: "error",
  missingFiles: "missingFiles",
  unknown: "unknown",
};

/** Collapse a qBittorrent state into the client-neutral set. */
export function normalizeQBittorrentState(state: string): TorrentState {
  return STATE_MAP[state] ?? state;
}

/** Translate a raw Web API torrent into the shape the UI consumes. */
export function toTorrentSummary(torrent: TorrentInfo): TorrentSummary {
  return {
    hash: torrent.hash,
    name: torrent.name,
    state: normalizeQBittorrentState(torrent.state),
    progress: torrent.progress,
    size: torrent.size,
    downloadSpeed: torrent.dlspeed,
    uploadSpeed: torrent.upspeed,
    eta: torrent.eta,
    ratio: torrent.ratio,
    category: torrent.category,
    tags: splitTags(torrent.tags),
    seeds: torrent.num_seeds,
    peers: torrent.num_leechs,
  };
}

/** Build the qBittorrent Web API client for the current settings. */
export function createQBittorrentClient(settings: Settings): QBittorrentClient {
  const options: QBittorrentClientOptions = {
    baseUrl: settings.baseUrl,
    // The background worker runs in the browser, so the browser cookie jar
    // handles SID for password auth. API keys are stateless.
    cookieMode: "browser",
    timeoutMs: 15_000,
  };

  if (settings.authMode === "apiKey") {
    options.apiKey = settings.apiKey;
  } else {
    options.username = settings.username;
    options.password = settings.password;
  }

  return new QBittorrentClient(options);
}

/** qBittorrent implementation of the client adapter contract. */
export function createQBittorrentAdapter(settings: Settings): TorrentClientAdapter {
  const client = createQBittorrentClient(settings);

  return {
    kind: "qbittorrent",
    definition,

    async testConnection(): Promise<ConnectionDetails> {
      const { appVersion, webApiVersion } = await client.testConnection();
      return {
        kind: "qbittorrent",
        clientLabel: definition.label,
        version: appVersion,
        apiVersion: webApiVersion,
        authMode: settings.authMode,
      };
    },

    async listTorrents(): Promise<TorrentSummary[]> {
      const torrents = await client.getTorrents({ sort: "added_on", reverse: true });
      return torrents.map(toTorrentSummary);
    },

    async getTorrent(hash: string): Promise<TorrentSummary | null> {
      const [torrent] = await client.getTorrents({ hashes: hash });
      return torrent ? toTorrentSummary(torrent) : null;
    },

    async getTaxonomy() {
      const [categories, tags] = await Promise.all([client.getCategories(), client.getTags()]);
      return {
        categories: Object.keys(categories).sort((a, b) => a.localeCompare(b)),
        tags: [...tags].sort((a, b) => a.localeCompare(b)),
      };
    },

    async addTorrent(input: AddTorrentRequest): Promise<AddTorrentResult> {
      const category = input.category?.trim() ?? "";
      const tags = normalizeTags(input.tags ?? []);

      if (category) await ensureCategory(client, category);
      if (tags.length > 0) await ensureTags(client, tags);

      try {
        await client.addTorrent({
          urls: input.urls,
          ...(category ? { category } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(input.paused ? { paused: true } : {}),
        });
      } catch (error) {
        if (error instanceof QBittorrentError && error.message.includes("rejected the torrent")) {
          throw new Error(
            "qBittorrent did not add this torrent. It may already exist, or the magnet link may be invalid.",
          );
        }
        throw error;
      }

      const hashes = input.urls
        .map((url) => parseMagnet(url)?.infoHash)
        .filter((hash): hash is string => Boolean(hash));

      return { added: input.urls.length, hashes };
    },

    async removeTorrent(input: RemoveTorrentRequest): Promise<void> {
      await client.deleteTorrents(input.hashes, input.deleteFiles ?? false);
    },
  };
}

async function ensureCategory(client: QBittorrentClient, name: string): Promise<void> {
  const categories = await client.getCategories();
  if (name in categories) return;

  try {
    await client.createCategory(name);
  } catch (error) {
    // A concurrent add may have created it between the check and the request.
    const refreshed = await client.getCategories();
    if (!(name in refreshed)) throw error;
  }
}

async function ensureTags(client: QBittorrentClient, tags: string[]): Promise<void> {
  const existing = new Set(await client.getTags());
  const missing = tags.filter((tag) => !existing.has(tag));
  if (missing.length === 0) return;

  try {
    await client.createTags(missing);
  } catch (error) {
    const refreshed = new Set(await client.getTags());
    if (missing.some((tag) => !refreshed.has(tag))) throw error;
  }
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags) {
    for (const part of raw.split(",")) {
      const tag = part.trim();
      if (tag) seen.add(tag);
    }
  }
  return [...seen];
}

function splitTags(tags: unknown): string[] {
  if (typeof tags !== "string" || tags.trim() === "") return [];
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}
