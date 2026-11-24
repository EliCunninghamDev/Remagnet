import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { components, paths } from "./schema";

export type ProxyPaths = paths;
export type ProxyError = components["schemas"]["Error"];
export type ProxyErrorCode = ProxyError["code"];
export type ProxyClient = Client<paths>;

/** An HTTP or transport failure while talking to the Remagnet Proxy. */
export class ProxyHttpError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "ProxyHttpError";
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
  }
}

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
 * non-JSON failures such as an HTML error page from a reverse proxy that is
 * down. A body message is already written for people, so it is returned as-is
 * instead of being wrapped in a generic status line.
 */
export function proxyErrorMessage(response: Response, error?: Partial<ProxyError>): string {
  const detail = error?.error?.trim();
  if (detail) return detail;

  switch (response.status) {
    case 401:
      return "Authentication failed. Sign in again or reconnect this device in Settings.";
    case 403:
      return "Access denied by the Remagnet Proxy.";
    case 404:
      return "The requested endpoint or torrent was not found on the Remagnet Proxy.";
    case 413:
      return "The request was too large for the Remagnet Proxy.";
    case 429:
      return "Too many requests. Wait a moment and try again.";
    case 500:
      return "The Remagnet Proxy returned an internal error (500). Check the proxy container logs.";
    case 502:
      return "The Remagnet Proxy (or reverse proxy in front of it) returned 502 Bad Gateway. Check that Remagnet Proxy and your torrent client are running.";
    case 503:
      return "The Remagnet Proxy is temporarily unavailable (503). Check that the container is running.";
    case 504:
      return "The request to Remagnet Proxy timed out (504). Check that the proxy and torrent client are responsive.";
    default: {
      const statusText = response.statusText ? ` ${response.statusText}` : "";
      return `The Remagnet Proxy returned HTTP ${response.status}${statusText}.`;
    }
  }
}

/** Build a structured error for a failed proxy response. */
export function proxyError(response: Response, error?: Partial<ProxyError>): ProxyHttpError {
  return new ProxyHttpError(proxyErrorMessage(response, error), {
    status: response.status,
    code: proxyErrorCode(error),
  });
}

/**
 * Describe a transport failure (DNS, TLS, connection refused, timeout, CORS).
 *
 * Browser `fetch` failures surface as bare `TypeError: Failed to fetch`, which
 * tells the user nothing actionable. Timeouts and blocked requests get the same
 * treatment so the UI can show a next step instead of the raw exception.
 */
export function describeNetworkError(error: unknown, baseUrl?: string): string {
  if (error instanceof ProxyHttpError) return error.message;

  const name = errorName(error);
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError" || /timed out|timeout/i.test(message)) {
    return "Timed out reaching the Remagnet Proxy. Check that the server is running and reachable.";
  }
  if (
    (error instanceof TypeError || name === "TypeError") &&
    /failed to fetch|networkerror|load failed|network request failed/i.test(message)
  ) {
    return "Could not reach the Remagnet Proxy. Check the proxy URL, that the server is running, and that its HTTPS certificate is trusted by your browser.";
  }

  // `baseUrl` is accepted for callers that want a place to add endpoint context
  // later; the message intentionally stays stable for tests and translations.
  void baseUrl;
  return message;
}

/** Normalize any thrown value into a structured proxy error. */
export function toProxyError(error: unknown, baseUrl?: string): ProxyHttpError {
  if (error instanceof ProxyHttpError) return error;

  return new ProxyHttpError(describeNetworkError(error, baseUrl), {
    ...errorDetails(error),
  });
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function errorDetails(error: unknown): { status?: number; code?: string } {
  if (typeof error !== "object" || error === null) return {};
  const { code, status } = error as { code?: unknown; status?: unknown };
  return {
    ...(typeof code === "string" && code.length > 0 ? { code } : {}),
    ...(typeof status === "number" ? { status } : {}),
  };
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
