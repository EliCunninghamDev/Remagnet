import { normalizeBaseUrl } from "@remagnet/proxy-client";
import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";

export type TorrentFileSurface = "popup-window" | "tab";

export interface Settings {
  /** Remagnet Proxy origin, e.g. https://remagnet.example.com. */
  proxyBaseUrl: string;
  /** Proxy bearer token. Encrypted before it touches extension storage. */
  proxyToken: string;
  /** Where the `.torrent` file picker opens. */
  torrentFileSurface: TorrentFileSurface;
  /** Whether a browser notification is shown when a download completes. */
  downloadNotifications: boolean;
}

/** Settings that are safe to keep readable on disk. */
export type PublicSettings = Omit<Settings, "proxyToken">;

interface Secrets {
  proxyToken: string;
}

/** Shape older builds may still have on disk, including plain-text secrets. */
type StoredSettings = Partial<Settings>;

const PUBLIC_DEFAULTS: PublicSettings = {
  proxyBaseUrl: "",
  torrentFileSurface: "popup-window",
  downloadNotifications: true,
};

const PUBLIC_KEYS = new Set(Object.keys(PUBLIC_DEFAULTS));

const SECRET_DEFAULTS: Secrets = {
  proxyToken: "",
};

export const DEFAULT_SETTINGS: Settings = {
  ...PUBLIC_DEFAULTS,
  ...SECRET_DEFAULTS,
};

export interface ProxySettings {
  baseUrl: string;
  token: string;
}

/**
 * Credentials are encrypted before they touch extension storage.
 *
 * The AES-GCM key is generated once, marked non-extractable, and kept in the
 * extension's own IndexedDB. JavaScript can ask the browser to use the key but
 * cannot read its bytes, so the ciphertext in `storage.local` is not useful on
 * its own. This is not a passphrase vault: anyone who can run code as the
 * extension can still decrypt the credentials while the profile is in use.
 */
interface EncryptedSecrets {
  version: 1;
  iv: string;
  data: string;
}

const KEY_DATABASE = "remagnet-credentials";
const KEY_STORE = "keys";
const KEY_ID = "settings";

/** Shortest proxy token accepted by the validator. */
const MIN_PROXY_TOKEN_LENGTH = 16;
/** AES-GCM nonce length in bytes; 96 bits is the WebCrypto default and best practice. */
const GCM_IV_BYTES = 12;
/** AES key length in bits for the credential vault. */
const AES_KEY_BITS = 256;

let keyPromise: Promise<CryptoKey> | undefined;

const settingsItem = storage.defineItem<PublicSettings>("local:settings", {
  fallback: PUBLIC_DEFAULTS,
});

const secretsItem = storage.defineItem<EncryptedSecrets | null>("local:secrets", {
  fallback: null,
});

/**
 * Read non-secret preferences without opening IndexedDB or decrypting secrets.
 *
 * Useful for latency-sensitive UI actions like opening the `.torrent` upload
 * surface from the toolbar popover.
 */
export async function getPublicSettings(): Promise<PublicSettings> {
  const stored = (await settingsItem.getValue()) as StoredSettings;
  return toPublicSettings(stored);
}

/**
 * Read settings with defaults filled in.
 *
 * Storage returns the stored object as-is, so settings written before a field
 * existed would otherwise be `undefined` at runtime. Older builds also kept
 * client credentials and archive settings in these items; removed fields,
 * including any plain-text secrets, are dropped instead of migrated.
 */
export async function getSettings(): Promise<Settings> {
  const [storedValue, encrypted] = await Promise.all([
    settingsItem.getValue(),
    secretsItem.getValue(),
  ]);
  const stored = storedValue as StoredSettings;

  if (Object.keys(stored).some((key) => !PUBLIC_KEYS.has(key))) {
    await settingsItem.setValue(toPublicSettings(stored));
  }

  const secrets = await decryptSecrets(encrypted);
  return { ...DEFAULT_SETTINGS, ...toPublicSettings(stored), ...secrets };
}

/** Write public settings and the encrypted token together. */
export async function saveSettings(values: Settings): Promise<void> {
  const encrypted = await encryptSecrets({ proxyToken: values.proxyToken });
  await settingsItem.setValue(toPublicSettings(values));
  await secretsItem.setValue(encrypted);
}

/**
 * Update public preferences without touching the encrypted proxy token.
 *
 * Sign-out and sign-in both rewrite the secret item, so preference changes use
 * this path to avoid re-encrypting a token they did not modify.
 */
export async function savePublicSettings(partial: Partial<PublicSettings>): Promise<Settings> {
  const current = await getSettings();
  const merged = toPublicSettings({
    proxyBaseUrl: partial.proxyBaseUrl ?? current.proxyBaseUrl,
    torrentFileSurface: partial.torrentFileSurface ?? current.torrentFileSurface,
    downloadNotifications: partial.downloadNotifications ?? current.downloadNotifications,
  });
  await settingsItem.setValue(merged);
  return { ...current, ...merged };
}

/** Both the proxy URL and token must be present before any request is made. */
export function isProxyConfigured(settings: Settings): boolean {
  return settings.proxyBaseUrl.trim().length > 0 && settings.proxyToken.trim().length > 0;
}

/** Validate just the proxy origin, for sign-in before a token exists. */
export function validateProxyBaseUrl(value: string): string | null {
  const baseUrl = value.trim();
  if (!baseUrl) return "Enter the Remagnet Proxy URL.";

  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "The Remagnet Proxy URL must use http:// or https://.";
    }
    if (!url.hostname) return "The Remagnet Proxy URL needs a host.";
    if (url.username || url.password) {
      return "The Remagnet Proxy URL must not contain credentials.";
    }
  } catch {
    return "Enter a valid Remagnet Proxy URL.";
  }

  return null;
}

/** Validate the proxy fields. Returns a message to show, or null when valid. */
export function validateProxySettings(settings: Settings): string | null {
  const baseUrl = settings.proxyBaseUrl.trim();
  const token = settings.proxyToken.trim();

  if (!baseUrl) return "Enter the Remagnet Proxy URL.";
  if (!token) return "Enter the Remagnet Proxy token.";
  if (token.length < MIN_PROXY_TOKEN_LENGTH)
    return "The Remagnet Proxy token must be at least 16 characters.";

  return validateProxyBaseUrl(baseUrl);
}

/** Throw a readable error unless the proxy connection settings are usable. */
export function requireProxySettings(settings: Settings): ProxySettings {
  const error = validateProxySettings(settings);
  if (error) throw new Error(error);

  return {
    baseUrl: normalizeBaseUrl(settings.proxyBaseUrl),
    token: settings.proxyToken.trim(),
  };
}

/**
 * Keep extension storage out of content-script reach where the browser supports
 * it. Chrome exposes setAccessLevel; Firefox has no such switch.
 */
export function restrictSettingsStorageAccess(): void {
  const local = browser.storage.local as typeof browser.storage.local & {
    setAccessLevel?: (options: {
      accessLevel: "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS";
    }) => Promise<void>;
  };
  const result = local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  result?.catch(() => {
    // Older browsers and Firefox do not offer the switch.
  });
}

function toPublicSettings(values: StoredSettings): PublicSettings {
  return {
    proxyBaseUrl:
      typeof values.proxyBaseUrl === "string" ? values.proxyBaseUrl : PUBLIC_DEFAULTS.proxyBaseUrl,
    torrentFileSurface: isTorrentFileSurface(values.torrentFileSurface)
      ? values.torrentFileSurface
      : PUBLIC_DEFAULTS.torrentFileSurface,
    downloadNotifications:
      typeof values.downloadNotifications === "boolean"
        ? values.downloadNotifications
        : PUBLIC_DEFAULTS.downloadNotifications,
  };
}

function isTorrentFileSurface(value: unknown): value is TorrentFileSurface {
  return value === "popup-window" || value === "tab";
}

async function encryptSecrets(secrets: Secrets): Promise<EncryptedSecrets> {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    version: 1,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptSecrets(encrypted: EncryptedSecrets | null): Promise<Secrets> {
  if (encrypted?.version !== 1) return { ...SECRET_DEFAULTS };

  try {
    const key = await encryptionKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(encrypted.iv) },
      key,
      fromBase64(encrypted.data),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<Secrets>;
    return {
      proxyToken: typeof parsed.proxyToken === "string" ? parsed.proxyToken : "",
    };
  } catch {
    // A fresh profile or cleared key store leaves orphaned ciphertext. Treat
    // the credentials as unset so the settings page can replace them.
    return { ...SECRET_DEFAULTS };
  }
}

function encryptionKey(): Promise<CryptoKey> {
  keyPromise ??= loadOrCreateKey().catch((error) => {
    keyPromise = undefined;
    throw error;
  });
  return keyPromise;
}

async function loadOrCreateKey(): Promise<CryptoKey> {
  const db = await openKeyDatabase();
  try {
    const existing = await readKey(db);
    if (existing) return existing;

    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: AES_KEY_BITS }, false, [
      "encrypt",
      "decrypt",
    ]);
    await writeKey(db, key);
    return key;
  } finally {
    db.close();
  }
}

function openKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEY_STORE)) {
        request.result.createObjectStore(KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the credential key store."));
  });
}

function readKey(db: IDBDatabase): Promise<CryptoKey | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(KEY_ID);
    request.onsuccess = () => resolve(request.result as CryptoKey | undefined);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not read the credential key."));
  });
}

function writeKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(KEY_STORE, "readwrite").objectStore(KEY_STORE).put(key, KEY_ID);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Could not save the credential key."));
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
