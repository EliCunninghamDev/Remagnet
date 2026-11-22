import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { components, paths } from "./schema";

export type ProxyPaths = paths;
export type ProxyError = components["schemas"]["Error"];
export type ProxyClient = Client<paths>;

export interface ProxyClientOptions {
  /** Proxy origin, with or without a trailing slash. */
  baseUrl: string;
  /** `BRIDGE_TOKEN`; sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Override the fetch implementation, mainly for tests. */
  fetch?: ClientOptions["fetch"];
}

/**
 * Create a typed client for the Remagnet proxy.
 *
 * Types come from `proxy/openapi.yaml`; regenerate them with
 * `bun run api:generate`. The bearer token is attached to every request so
 * callers cannot accidentally call an authenticated endpoint anonymously.
 */
export function createProxyClient(options: ProxyClientOptions): ProxyClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = options.token.trim();
  if (!baseUrl) throw new Error("The archive bridge URL is required.");
  if (!token) throw new Error("The archive bridge token is required.");

  return createClient<paths>({
    baseUrl,
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    ...(options.fetch ? { fetch: options.fetch } : {}),
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
  return `The archive bridge returned ${response.status}${statusText}${detail}`;
}

/** Proxy ZIP URL without credentials, for diagnostics and tests. */
export function archiveUrl(baseUrl: string, hash: string): string {
  return `${normalizeBaseUrl(baseUrl)}/archive/${encodeURIComponent(hash)}`;
}

/**
 * ZIP download URL for `browser.downloads` and other download APIs.
 *
 * Firefox can attach an Authorization header; other browsers get the token as a
 * query parameter because their download API cannot set headers.
 */
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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}
