import { createTorrentClient, getTorrentClientDefinition } from "./clients";
import type {
  AddTorrentRequest,
  AddTorrentResult,
  ConnectionDetails,
  RemoveTorrentRequest,
  TorrentClientAdapter,
} from "./clients/types";
import { filterTorrents, getTorrentFilter } from "./relevance";
import { getSettings, type Settings } from "./settings";
import type { TorrentSummary, TorrentTaxonomy } from "./torrents";

/**
 * Background-side service facade.
 *
 * The UI never imports an adapter or a client SDK. It sends messages, and this
 * module resolves the configured client, validates its settings and delegates.
 * The adapter is cached so password-auth sessions (the SID cookie) survive
 * between popup opens and settings are only re-read when needed.
 */
let cached: { fingerprint: string; adapter: TorrentClientAdapter } | null = null;

/** Identity of the settings that affect the adapter instance. */
function fingerprint(settings: Settings): string {
  return JSON.stringify([
    settings.client,
    settings.baseUrl,
    settings.authMode,
    settings.apiKey,
    settings.username,
    settings.password,
  ]);
}

async function getAdapter(): Promise<TorrentClientAdapter> {
  const settings = await getSettings();
  const key = fingerprint(settings);

  if (cached?.fingerprint === key) return cached.adapter;

  const definition = getTorrentClientDefinition(settings.client);
  const error = definition.validate(settings);
  if (error) throw new Error(`${error} Open Remagnet settings.`);

  const adapter = createTorrentClient(settings);
  cached = { fingerprint: key, adapter };
  return adapter;
}

export async function testConnection(): Promise<ConnectionDetails> {
  return (await getAdapter()).testConnection();
}

export async function addTorrents(input: AddTorrentRequest): Promise<AddTorrentResult> {
  return (await getAdapter()).addTorrent(input);
}

/**
 * List only torrents that belong to Remagnet.
 *
 * qBittorrent is often shared with other tools, so the popup filters to the
 * configured category/tags. `getTorrent` deliberately stays unfiltered: the
 * archive bridge can stream any completed torrent by hash.
 */
export async function listTorrents(): Promise<TorrentSummary[]> {
  const settings = await getSettings();
  const torrents = await (await getAdapter()).listTorrents();
  return filterTorrents(torrents, getTorrentFilter(settings));
}

export async function getTorrent(hash: string): Promise<TorrentSummary | null> {
  return (await getAdapter()).getTorrent(hash);
}

export async function getTaxonomy(): Promise<TorrentTaxonomy> {
  return (await getAdapter()).getTaxonomy();
}

export async function removeTorrents(input: RemoveTorrentRequest): Promise<void> {
  await (await getAdapter()).removeTorrent(input);
}
