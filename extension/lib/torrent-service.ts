import {
  type components,
  createProxyClient,
  type ProxyClient,
  proxyError,
  toProxyError,
} from "@remagnet/proxy-client";
import type { AddTorrentsResult, ConnectionTestResult, TorrentFileUploadInput } from "./messages";
import { getSettings, requireProxySettings } from "./settings";
import type { TorrentFile, TorrentSummary } from "./torrents";

/**
 * Background-side service facade.
 *
 * The UI never talks to the proxy directly. It sends messages, and this module
 * resolves the saved connection, validates it and calls the typed proxy API.
 *
 * Every failure leaves here as a `ProxyHttpError` with a message written for
 * people, plus the proxy's `code` and HTTP `status` when the server supplied
 * them, so the background worker can forward them to the UI.
 */
async function withProxy<T>(run: (client: ProxyClient) => Promise<T>): Promise<T> {
  let baseUrl: string | undefined;
  try {
    const settings = requireProxySettings(await getSettings());
    baseUrl = settings.baseUrl;
    const client = createProxyClient({ baseUrl, token: settings.token });
    return await run(client);
  } catch (error) {
    throw toProxyError(error, baseUrl);
  }
}

export async function testConnection(): Promise<ConnectionTestResult> {
  return withProxy(async (client) => {
    const { data, error, response } = await client.GET("/api/health");

    if (error || !data) throw proxyError(response, error);

    return {
      clientLabel: data.clientLabel,
      appVersion: data.appVersion,
      webApiVersion: data.webApiVersion,
      capabilities: {
        pauseOnAdd: data.capabilities.pauseOnAdd,
        torrentFiles: data.capabilities.torrentFiles,
      },
      defaultCategory: data.defaultCategory,
      defaultTags: data.defaultTags,
    };
  });
}

/** List the torrents the proxy owns; filtering happens server-side. */
export async function listTorrents(): Promise<TorrentSummary[]> {
  return withProxy(async (client) => {
    const { data, error, response } = await client.GET("/api/torrents");

    if (error || !data) throw proxyError(response, error);
    return data.torrents;
  });
}

/** Look up a torrent anywhere in the client, for duplicate checks. */
export async function getTorrent(hash: string): Promise<TorrentSummary | null> {
  return withProxy(async (client) => {
    const { data, error, response } = await client.GET("/api/torrents/{hash}", {
      params: { path: { hash } },
    });

    if (response.status === 404) return null;
    if (error || !data) throw proxyError(response, error);
    return data;
  });
}

/** List the wanted files in one owned torrent, in the client's file-index order. */
export async function listTorrentFiles(hash: string): Promise<TorrentFile[]> {
  return withProxy(async (client) => {
    const { data, error, response } = await client.GET("/api/torrents/{hash}/files", {
      params: { path: { hash } },
    });

    if (error || !data) throw proxyError(response, error);
    return data.files;
  });
}

export async function addTorrents(input: {
  urls?: string[];
  files?: TorrentFileUploadInput[];
  paused?: boolean;
}): Promise<AddTorrentsResult> {
  return withProxy(async (client) => {
    const { data, error, response } = await client.POST("/api/torrents", {
      // The generated schema marks `urls` and `files` as required because they
      // have OpenAPI defaults, but the proxy accepts either one on its own.
      body: {
        ...(input.urls?.length ? { urls: input.urls } : {}),
        ...(input.files?.length ? { files: input.files } : {}),
        paused: input.paused ?? false,
      } as components["schemas"]["AddTorrentRequest"],
    });

    if (error || !data) throw proxyError(response, error);

    return {
      added: data.added,
      hashes: data.hashes,
      category: data.category,
      tags: data.tags,
    };
  });
}

export async function removeTorrents(input: {
  hashes: string[];
  deleteFiles?: boolean;
}): Promise<void> {
  return withProxy(async (client) => {
    for (const hash of input.hashes) {
      const { error, response } = await client.DELETE("/api/torrents/{hash}", {
        params: {
          path: { hash },
          query: { deleteFiles: input.deleteFiles ?? false },
        },
      });
      if (!response.ok) throw proxyError(response, error);
    }
  });
}

/** Pause each owned torrent, stopping at the first failure. */
export async function pauseTorrents(hashes: string[]): Promise<void> {
  return withProxy(async (client) => {
    for (const hash of hashes) {
      const { error, response } = await client.POST("/api/torrents/{hash}/pause", {
        params: { path: { hash } },
      });
      if (!response.ok) throw proxyError(response, error);
    }
  });
}

/** Resume each owned torrent, stopping at the first failure. */
export async function resumeTorrents(hashes: string[]): Promise<void> {
  return withProxy(async (client) => {
    for (const hash of hashes) {
      const { error, response } = await client.POST("/api/torrents/{hash}/resume", {
        params: { path: { hash } },
      });
      if (!response.ok) throw proxyError(response, error);
    }
  });
}

export async function pauseAllTorrents(): Promise<void> {
  return withProxy(async (client) => {
    const { error, response } = await client.POST("/api/torrents/pause");

    if (!response.ok) throw proxyError(response, error);
  });
}

export async function resumeAllTorrents(): Promise<void> {
  return withProxy(async (client) => {
    const { error, response } = await client.POST("/api/torrents/resume");

    if (!response.ok) throw proxyError(response, error);
  });
}
