import { browser } from "wxt/browser";
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

/** Settings that are safe to keep readable on disk. */
type PublicSettings = Omit<Settings, "apiKey" | "password" | "archiveToken">;

interface Secrets {
  apiKey: string;
  password: string;
  archiveToken: string;
}

/** Shape older builds may still have on disk, including plain-text secrets. */
type StoredSettings = PublicSettings & Partial<Secrets>;

const PUBLIC_DEFAULTS: PublicSettings = {
  client: "qbittorrent",
  baseUrl: "http://127.0.0.1:8080",
  authMode: "apiKey",
  username: "admin",
  defaultCategory: "remagnet",
  defaultTags: "remagnet",
  archiveBaseUrl: "",
};

const SECRET_DEFAULTS: Secrets = {
  apiKey: "",
  password: "",
  archiveToken: "",
};

export const DEFAULT_SETTINGS: Settings = {
  ...PUBLIC_DEFAULTS,
  ...SECRET_DEFAULTS,
};

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

let keyPromise: Promise<CryptoKey> | undefined;

const settingsItem = storage.defineItem<PublicSettings>("local:settings", {
  fallback: PUBLIC_DEFAULTS,
});

const secretsItem = storage.defineItem<EncryptedSecrets | null>("local:secrets", {
  fallback: null,
});

/**
 * Read settings with defaults filled in.
 *
 * Storage returns the stored object as-is, so settings written before a field
 * existed (for example `client`) would otherwise be `undefined` at runtime.
 */
export async function getSettings(): Promise<Settings> {
  const [storedValue, encrypted] = await Promise.all([
    settingsItem.getValue(),
    secretsItem.getValue(),
  ]);
  const stored = storedValue as StoredSettings;

  // Earlier builds wrote credentials straight into this object. Drop those
  // fields instead of migrating them; the encrypted item is the only source.
  if ("apiKey" in stored || "password" in stored || "archiveToken" in stored) {
    await settingsItem.setValue(toPublicSettings(stored));
  }

  const secrets = await decryptSecrets(encrypted);
  return { ...DEFAULT_SETTINGS, ...toPublicSettings(stored), ...secrets };
}

/** Write public settings and the encrypted credentials together. */
export async function saveSettings(values: Settings): Promise<void> {
  const encrypted = await encryptSecrets({
    apiKey: values.apiKey,
    password: values.password,
    archiveToken: values.archiveToken,
  });
  await settingsItem.setValue(toPublicSettings(values));
  await secretsItem.setValue(encrypted);
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
    client: values.client ?? PUBLIC_DEFAULTS.client,
    baseUrl: values.baseUrl ?? PUBLIC_DEFAULTS.baseUrl,
    authMode: values.authMode ?? PUBLIC_DEFAULTS.authMode,
    username: values.username ?? PUBLIC_DEFAULTS.username,
    defaultCategory: values.defaultCategory ?? PUBLIC_DEFAULTS.defaultCategory,
    defaultTags: values.defaultTags ?? PUBLIC_DEFAULTS.defaultTags,
    archiveBaseUrl: values.archiveBaseUrl ?? PUBLIC_DEFAULTS.archiveBaseUrl,
  };
}

async function encryptSecrets(secrets: Secrets): Promise<EncryptedSecrets> {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
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
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      password: typeof parsed.password === "string" ? parsed.password : "",
      archiveToken: typeof parsed.archiveToken === "string" ? parsed.archiveToken : "",
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

    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
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
