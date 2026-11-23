import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { components, paths } from "./schema";

export type ProxyPaths = paths;
export type ProxyError = components["schemas"]["Error"];
export type ProxyClient = Client<paths>;

export interface ProxyClientOptions {
  /** Proxy origin, with or without a trailing slash. */
  baseUrl: string;
  /** Per-device token (`rmg_…`); sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Override the fetch implementation, mainly for tests. */
  fetch?: ClientOptions["fetch"];
}

/**
 * Create a typed client for the Remagnet proxy.
 *
 * Types come from `proxy/openapi.yaml`; regenerate them with
 * `bun run api:generate`. The device token is attached to every request so
 * callers cannot accidentally call an authenticated endpoint anonymously.
 */
export function createProxyClient(options: ProxyClientOptions): ProxyClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = options.token.trim();
  if (!baseUrl) throw new Error("The Remagnet Proxy URL is required.");
  if (!token) throw new Error("The Remagnet Proxy token is required.");

  return createClient<paths>({
    baseUrl,
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/**
 * Create a typed client without credentials.
 *
 * Only the public bootstrap endpoints work with it: `GET /api/auth/status`,
 * `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/device` and
 * `POST /api/pair/claim`. Use it before a device token exists, for example to
 * exchange administrator credentials for a token.
 */
export function createPublicProxyClient(
  baseUrl: string,
  fetch?: ClientOptions["fetch"],
): ProxyClient {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) throw new Error("The Remagnet Proxy URL is required.");

  return createClient<paths>({
    baseUrl: normalized,
    cache: "no-store",
    ...(fetch ? { fetch } : {}),
  });
}

/**
 * Turn an error response from the proxy into a readable message.
 *
 * `error` is the parsed `{ error }` body from `openapi-fetch`; it is absent for
 * non-JSON failures such as a proxy that is down.
 */
export function proxyErrorMessage(response: Response, error?: ProxyError): string {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  const detail = error?.error ? `: ${error.error}` : "";
  return `The Remagnet Proxy returned ${response.status}${statusText}${detail}`;
}

/**
 * Read the machine-readable `code` from a parsed error body.
 *
 * The proxy uses `totp_required` on a `401` from sign-in or device login to
 * ask for the second factor. Returns undefined for any other shape.
 */
export function proxyErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/** Proxy ZIP URL without credentials, for diagnostics and tests. */
export function archiveUrl(baseUrl: string, hash: string): string {
  return `${normalizeBaseUrl(baseUrl)}/archive/${encodeURIComponent(hash)}`;
}

/**
 * ZIP download URL for `browser.downloads` and other download APIs.
 *
 * With a single-use `ticket` the URL carries `?ticket=…`; without one it stays
 * bare and relies on an `Authorization` header, which Firefox and the Android
 * app can attach. A long-lived device token never belongs in a URL.
 */
export function archiveDownloadUrl(baseUrl: string, hash: string, ticket?: string): string {
  const url = new URL(archiveUrl(baseUrl, hash));
  const trimmed = ticket?.trim();
  if (trimmed) url.searchParams.set("ticket", trimmed);
  return url.toString();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}
