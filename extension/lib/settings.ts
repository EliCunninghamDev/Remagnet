import { storage } from "wxt/utils/storage";
import type { AuthMode, ClientKind } from "./clients/types";

export type { AuthMode, ClientKind };

export interface Settings {
  /** Which torrent client adapter to use. */
  client: ClientKind;
  /** Client Web UI root, e.g. http://127.0.0.1:8080. */
  baseUrl: string;
  authMode: AuthMode;
  /** Stateless bearer token (qBittorrent 5.2+), when the adapter offers it. */
  apiKey: string;
  username: string;
  password: string;
  /** Category applied to magnets added from the extension. */
  defaultCategory: string;
  /** Comma-separated tags applied to magnets added from the extension. */
  defaultTags: string;
  /** Root URL of the optional archive bridge, e.g. https://remagnet.example.com. */
  archiveBaseUrl: string;
  /** Bearer token for the archive bridge. Kept out of page bundles. */
  archiveToken: string;
}

export const DEFAULT_SETTINGS: Settings = {
  client: "qbittorrent",
  baseUrl: "http://127.0.0.1:8080",
  authMode: "apiKey",
  apiKey: "",
  username: "admin",
  password: "",
  defaultCategory: "remagnet",
  defaultTags: "remagnet",
  archiveBaseUrl: "",
  archiveToken: "",
};

export const settingsItem = storage.defineItem<Settings>("local:settings", {
  fallback: DEFAULT_SETTINGS,
});

/**
 * Read settings with defaults filled in.
 *
 * Storage returns the stored object as-is, so settings written before a field
 * existed (for example `client`) would otherwise be `undefined` at runtime.
 */
export async function getSettings(): Promise<Settings> {
  const stored = await settingsItem.getValue();
  return { ...DEFAULT_SETTINGS, ...stored };
}
