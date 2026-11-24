import { describeNetworkError, ProxyHttpError } from "@remagnet/proxy-client";

/** Connection details returned by a successful pairing claim. */
export interface PairedSettings {
  proxyBaseUrl: string;
  proxyToken: string;
}

export interface PairingLink {
  baseUrl: string;
  id: string;
  code: string;
}

interface EncryptedPayload {
  iv: string;
  data: string;
}

const CONTEXT = new TextEncoder().encode("remagnet-pair-v1");

/**
 * Parse the `remagnet://pair` link copied from the Remagnet Proxy page.
 *
 * The link carries the proxy origin, so the extension does not need the URL or
 * token to claim it; both arrive in the encrypted response.
 */
export function parsePairingLink(text: string): PairingLink {
  const value = text.trim();
  if (!value) throw new Error("Paste a pairing link from the Remagnet Proxy page.");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("This is not a valid pairing link.");
  }
  if (url.protocol !== "remagnet:" || url.hostname !== "pair") {
    throw new Error("Expected a remagnet://pair link from the Remagnet Proxy page.");
  }

  const baseUrl = normalizeOrigin(url.searchParams.get("url"));
  const id = url.searchParams.get("id")?.trim() ?? "";
  const code = url.searchParams.get("code")?.trim() ?? "";
  if (!id || !code) {
    throw new Error("The pairing link is incomplete. Show a new code and copy it again.");
  }

  return { baseUrl, id, code };
}

/**
 * Claim a pairing link and decrypt the connection settings.
 *
 * The proxy receives only `SHA-256(code)`, and the response is encrypted with a
 * key derived from the code and session id. A proxy access log therefore cannot
 * recover the qBittorrent credentials or the Remagnet Proxy token.
 *
 * `deviceName` labels the new device record (for example `Firefox`). Pairing
 * never asks for the administrator's second factor: possession of the link is
 * the proof of presence.
 */
export async function claimPairing(
  link: PairingLink,
  deviceName?: string,
): Promise<PairedSettings> {
  const secret = decode(link.code);
  if (secret.length !== 32) {
    throw new Error("The pairing code is malformed. Show a new code and copy it again.");
  }

  const trimmedDeviceName = deviceName?.trim();
  const proof = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(secret))));
  const response = await claimRequest(link, proof, trimmedDeviceName).catch((error: unknown) => {
    if (error instanceof ProxyHttpError) throw error;
    throw new ProxyHttpError(describeNetworkError(error, link.baseUrl));
  });
  if (!response.ok) {
    throw await pairingError(response, "The pairing code was rejected.");
  }

  const encrypted = (await response.json()) as EncryptedPayload;
  if (!encrypted?.iv || !encrypted?.data) {
    throw new Error("The Remagnet Proxy sent an incomplete pairing response.");
  }

  let plaintext: Uint8Array;
  try {
    const key = await deriveKey(link.id, secret);
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buffer(decode(encrypted.iv)) },
        key,
        buffer(decode(encrypted.data)),
      ),
    );
  } catch {
    throw new Error(
      "The pairing response could not be decrypted. Show a new code and copy it again.",
    );
  }

  let payload: { version?: unknown; proxyToken?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext)) as typeof payload;
  } catch {
    throw new Error("The Remagnet Proxy returned unreadable connection settings.");
  }

  if (payload.version !== 2) {
    throw new Error(
      "This pairing response uses an unsupported version. Update the Remagnet Proxy or the extension and try again.",
    );
  }
  if (typeof payload.proxyToken !== "string" || !payload.proxyToken.trim()) {
    throw new Error("The Remagnet Proxy returned incomplete connection settings.");
  }

  return {
    proxyBaseUrl: link.baseUrl,
    proxyToken: payload.proxyToken.trim(),
  };
}

function normalizeOrigin(raw: string | null): string {
  if (!raw) throw new Error("The pairing link is missing the Remagnet Proxy URL.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The pairing link contains an invalid Remagnet Proxy URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The pairing URL must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("The pairing URL must not contain credentials.");
  }

  const loopback = ["127.0.0.1", "localhost", "[::1]", "10.0.2.2"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(
      "Pairing needs an HTTPS Remagnet Proxy URL. Put the proxy behind HTTPS and try again.",
    );
  }

  return url.origin;
}

async function deriveKey(id: string, secret: Uint8Array): Promise<CryptoKey> {
  const material = new Uint8Array([...CONTEXT, ...new TextEncoder().encode(id), ...secret]);
  const raw = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
}

function decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A plain ArrayBuffer view avoids the `SharedArrayBuffer` branch of TS's generic. */
function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** POST the hashed pairing code; transport failures are normalized by the caller. */
function claimRequest(link: PairingLink, proof: string, deviceName?: string): Promise<Response> {
  return fetch(`${link.baseUrl}/api/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: link.id,
      proof,
      ...(deviceName ? { deviceName } : {}),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * Turn a rejected claim into a `ProxyHttpError` that keeps the HTTP status and
 * the proxy's machine-readable error code, so the UI can act on them.
 */
async function pairingError(response: Response, fallback: string): Promise<ProxyHttpError> {
  let message = "";
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string" && body.error.trim()) message = body.error;
    if (typeof body.code === "string" && body.code.trim()) code = body.code;
  } catch {
    // Non-JSON error pages fall back to the status text.
  }
  if (!message) {
    message = response.statusText ? `${fallback} (${response.statusText})` : fallback;
  }
  return new ProxyHttpError(message, { status: response.status, code });
}
