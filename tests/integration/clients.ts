/**
 * Shared torrent-client catalog for the integration suite and the local dev
 * stack. Keeping host/container URLs, fixtures, and qBittorrent setup in one
 * place prevents the two entry points from drifting apart.
 */
import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const CLIENT_KINDS = ["qbittorrent", "transmission", "deluge", "rtorrent"] as const;

export type ClientKind = (typeof CLIENT_KINDS)[number];

export interface ClientInfo {
  label: string;
  hostBaseUrl: string;
  containerBaseUrl: string;
  usesCompleteDir: boolean;
  defaultCategory: string;
  defaultTags: string[];
  composeProfile: string | null;
}

export const CLIENTS: Record<ClientKind, ClientInfo> = {
  qbittorrent: {
    label: "qBittorrent",
    hostBaseUrl: "http://127.0.0.1:18080",
    containerBaseUrl: "http://qbittorrent:8080",
    usesCompleteDir: false,
    defaultCategory: "remagnet",
    defaultTags: ["remagnet"],
    composeProfile: "qbit",
  },
  transmission: {
    label: "Transmission",
    hostBaseUrl: "http://127.0.0.1:19091",
    containerBaseUrl: "http://transmission:9091",
    usesCompleteDir: true,
    defaultCategory: "",
    defaultTags: ["remagnet"],
    composeProfile: null,
  },
  deluge: {
    label: "Deluge",
    hostBaseUrl: "http://127.0.0.1:18112",
    containerBaseUrl: "http://deluge:8112",
    usesCompleteDir: false,
    defaultCategory: "remagnet",
    defaultTags: [],
    composeProfile: "deluge",
  },
  rtorrent: {
    label: "rTorrent",
    hostBaseUrl: "http://127.0.0.1:18000",
    containerBaseUrl: "http://rtorrent:8000",
    usesCompleteDir: true,
    defaultCategory: "remagnet",
    defaultTags: [],
    composeProfile: "rtorrent",
  },
};

/** Fixture names and seeds shared by `prepare.ts` and `run.ts`. */
export const INTEGRATION_FIXTURES = {
  owned: { name: "remagnet-fixture.bin", seed: "remagnet-owned" },
  unrelated: { name: "unrelated-fixture.bin", seed: "remagnet-unrelated" },
  magnet: { name: "remagnet-magnet.bin", seed: "remagnet-magnet-only" },
  upload: { name: "remagnet-upload.bin", seed: "remagnet-uploaded-file" },
} as const;

export function isClientKind(value: string | undefined): value is ClientKind {
  return value !== undefined && (CLIENT_KINDS as readonly string[]).includes(value);
}

export function parseClientArg(argv: readonly string[], usage: string): ClientKind {
  const index = argv.indexOf("--client");
  const inline = argv.find((arg) => arg.startsWith("--client="));
  const value = index >= 0 ? argv[index + 1] : inline?.slice("--client=".length);
  if (!isClientKind(value)) {
    throw new Error(usage);
  }
  return value;
}

/**
 * Copy the bundled qBittorrent configuration into a client config directory,
 * preserving an existing file so local dev settings survive restarts.
 */
export async function ensureQbitConfig(configDir: string, sourceConf: string): Promise<void> {
  const targetDir = join(configDir, "qBittorrent");
  const targetConfig = join(targetDir, "qBittorrent.conf");
  if (existsSync(targetConfig)) return;

  await mkdir(targetDir, { recursive: true });
  await cp(sourceConf, targetConfig);
}
