import { createProxyClient, type ProxyClient, proxyErrorMessage } from "@remagnet/proxy-client";
import type { AddTorrentsResult, ConnectionTestResult } from "./messages";
import { getSettings, requireProxySettings } from "./settings";
import type { TorrentSummary } from "./torrents";

/**
 * Background-side service facade.
 *
 * The UI never talks to the proxy directly. It sends messages, and this module
 * resolves the saved connection, validates it and calls the typed proxy API.
 */
async function connect(): Promise<ProxyClient> {
  const settings = requireProxySettings(await getSettings());
  return createProxyClient({ baseUrl: settings.baseUrl, token: settings.token });
}

export async function testConnection(): Promise<ConnectionTestResult> {
  const client = await connect();
  const { data, error, response } = await client.GET("/api/health");

  if (error || !data) throw new Error(proxyErrorMessage(response, error));

  return {
    clientLabel: data.clientLabel,
    appVersion: data.appVersion,
    webApiVersion: data.webApiVersion,
    capabilities: { pauseOnAdd: data.capabilities.pauseOnAdd },
    defaultCategory: data.defaultCategory,
    defaultTags: data.defaultTags,
  };
}

/** List the torrents the proxy owns; filtering happens server-side. */
export async function listTorrents(): Promise<TorrentSummary[]> {
  const client = await connect();
  const { data, error, response } = await client.GET("/api/torrents");

  if (error || !data) throw new Error(proxyErrorMessage(response, error));
  return data.torrents;
}

/** Look up a torrent anywhere in the client, for duplicate checks. */
export async function getTorrent(hash: string): Promise<TorrentSummary | null> {
  const client = await connect();
  const { data, error, response } = await client.GET("/api/torrents/{hash}", {
    params: { path: { hash } },
  });

  if (response.status === 404) return null;
  if (error || !data) throw new Error(proxyErrorMessage(response, error));
  return data;
}

export async function addTorrents(input: {
  urls: string[];
  paused?: boolean;
}): Promise<AddTorrentsResult> {
  const client = await connect();
  const { data, error, response } = await client.POST("/api/torrents", {
    body: { urls: input.urls, paused: input.paused ?? false },
  });

  if (error || !data) throw new Error(proxyErrorMessage(response, error));

  return {
    added: data.added,
    hashes: data.hashes,
    category: data.category,
    tags: data.tags,
  };
}

export async function removeTorrents(input: {
  hashes: string[];
  deleteFiles?: boolean;
}): Promise<void> {
  const client = await connect();

  for (const hash of input.hashes) {
    const { error, response } = await client.DELETE("/api/torrents/{hash}", {
      params: {
        path: { hash },
        query: { deleteFiles: input.deleteFiles ?? false },
      },
    });
    if (!response.ok) throw new Error(proxyErrorMessage(response, error));
  }
}
