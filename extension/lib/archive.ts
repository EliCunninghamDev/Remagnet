import type { Settings } from "./settings";

export interface ArchiveSettings {
  baseUrl: string;
  token: string;
}

const DISABLED = "The Remagnet Proxy is not configured. Add its URL and token in settings.";

/** Return usable archive settings, or null when the feature is turned off. */
export function getArchiveSettings(settings: Settings): ArchiveSettings | null {
  const baseUrl = settings.archiveBaseUrl.trim().replace(/\/+$/, "");
  const token = settings.archiveToken.trim();
  if (!baseUrl && !token) return null;
  return { baseUrl, token };
}

/**
 * Validate the archive fields. Both blank disables the feature; one blank or
 * an invalid URL is a configuration error.
 */
export function validateArchiveSettings(settings: Settings): string | null {
  const { baseUrl, token } = {
    baseUrl: settings.archiveBaseUrl.trim(),
    token: settings.archiveToken.trim(),
  };

  if (!baseUrl && !token) return null;
  if (!baseUrl) return "Enter the Remagnet Proxy URL, or clear the Remagnet Proxy token.";
  if (!token) return "Enter the Remagnet Proxy token, or clear the Remagnet Proxy URL.";
  if (token.length < 16) return "The Remagnet Proxy token must be at least 16 characters.";

  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "The Remagnet Proxy URL must use http:// or https://.";
    }
    if (!url.hostname) return "The Remagnet Proxy URL needs a host.";
    if (url.username || url.password) {
      return "Put the Remagnet Proxy token in its own field, not in the URL.";
    }
  } catch {
    return "Enter a valid Remagnet Proxy URL.";
  }

  return null;
}

export function requireArchiveSettings(settings: Settings): ArchiveSettings {
  const archive = getArchiveSettings(settings);
  if (!archive) throw new Error(DISABLED);
  const error = validateArchiveSettings(settings);
  if (error) throw new Error(error);
  return archive;
}

/**
 * Suggested download filename. Keeps the torrent's readable name while
 * removing path separators and characters browsers reject.
 */
export function archiveFilename(name: string): string {
  const cleaned = Array.from(name.normalize("NFC"))
    .map((character) => (character < " " || character === "\x7f" ? "" : character))
    .join("")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim()
    .slice(0, 140)
    .replace(/[.\s]+$/, "");

  return `${/[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "torrent"}.zip`;
}
