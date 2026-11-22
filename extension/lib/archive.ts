import type { Settings } from "./settings";

export interface ArchiveSettings {
  baseUrl: string;
  token: string;
}

const DISABLED = "The archive bridge is not configured. Add its URL and token in settings.";

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
  if (!baseUrl) return "Enter the archive bridge URL, or clear the bridge token.";
  if (!token) return "Enter the archive bridge token, or clear the bridge URL.";
  if (token.length < 16) return "The archive bridge token must be at least 16 characters.";

  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "The archive bridge URL must use http:// or https://.";
    }
    if (!url.hostname) return "The archive bridge URL needs a host.";
    if (url.username || url.password) {
      return "Put the bridge token in its own field, not in the URL.";
    }
  } catch {
    return "Enter a valid archive bridge URL.";
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

export function archiveUrl(baseUrl: string, hash: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/archive/${encodeURIComponent(hash)}`;
}

/** Firefox can attach an Authorization header to browser downloads. */
export function archiveDownloadUrl(
  baseUrl: string,
  hash: string,
  token: string,
  useHeader: boolean,
): string {
  const url = new URL(archiveUrl(baseUrl, hash));
  if (!useHeader) url.searchParams.set("token", token);
  return url.toString();
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
