import type { components, ProxyError, ProxyPaths } from "@remagnet/proxy-client";
import { proxyErrorMessage, toProxyError } from "@remagnet/proxy-client";
import createClient from "openapi-fetch";

type Schemas = components["schemas"];

export type AuthStatus = Schemas["AuthStatus"];
export type AuthSession = Schemas["AuthSession"];
export type SetupAdminRequest = Schemas["SetupAdminRequest"];
export type LoginRequest = Schemas["LoginRequest"];
export type ChangePasswordRequest = Schemas["ChangePasswordRequest"];
export type PublicConfig = Schemas["PublicConfig"];
export type ConfigUpdate = Schemas["ConfigUpdate"];
export type TorrentSummary = Schemas["TorrentSummary"];
export type AddTorrentRequest = Schemas["AddTorrentRequest"];
export type AddTorrentResult = Schemas["AddTorrentResult"];
export type PairingSession = Schemas["PairingSession"];
export type PublicDevice = Schemas["PublicDevice"];
export type ConnectionHealth = Schemas["ConnectionHealth"];
export type Liveness = Schemas["Liveness"];
export type ArchiveTicket = Schemas["ArchiveTicket"];

/** `openapi-fetch` response with the parts this module reads. */
interface ApiResponse<T> {
  data?: T;
  error?: Partial<ProxyError>;
  response: Response;
}

interface RequestOptions {
  /** Administrative call whose `401` should be checked for an expired session. */
  auth?: boolean;
  /** The endpoint returns `204` or another bodyless success. */
  empty?: boolean;
}

/** A failed proxy request with the HTTP status and machine-readable code. */
export class ProxyApiError extends Error {
  status?: number;
  code?: string;
  /** True when the request failed because the administrator session ended. */
  expired: boolean;

  constructor(
    message: string,
    options: { status?: number; code?: string; expired?: boolean } = {},
  ) {
    super(message);
    this.name = "ProxyApiError";
    this.status = options.status;
    this.code = options.code;
    this.expired = options.expired ?? false;
  }
}

/**
 * The proxy page talks to its own origin with the HttpOnly session cookie.
 * `cache: "no-store"` keeps polling, sign-in state and capability checks from
 * being served stale by the browser.
 */
const apiClient = createClient<ProxyPaths>({
  baseUrl: "",
  credentials: "same-origin",
  cache: "no-store",
});

let expiredHandler: (() => void) | undefined;

/**
 * Register the callback used when an authenticated request finds that the
 * session has ended.
 *
 * A `401` is not enough on its own: sign-in also uses `401` with
 * `code: "totp_required"`, and some endpoints reject a bad second factor with
 * `401` while the session is still valid. On a `401`, the helpers below probe
 * `GET /api/auth/status`; only an unauthenticated status invokes the callback
 * and throws an error with `expired: true`.
 *
 * Returns a cleanup function that removes the handler when it is still the
 * active one.
 */
export function checkSessionExpired(onExpired: () => void): () => void {
  expiredHandler = onExpired;
  return () => {
    if (expiredHandler === onExpired) expiredHandler = undefined;
  };
}

async function unwrap<T>(result: ApiResponse<T>, options: RequestOptions = {}): Promise<T> {
  const { response, data, error } = result;

  if (response.ok) {
    if (data !== undefined) return data;
    if (options.empty) return undefined as T;
  }

  if (response.status === 401 && options.auth !== false) {
    let authenticated = true;
    try {
      const probe = await apiClient.GET("/api/auth/status");
      authenticated = Boolean(probe.response.ok && probe.data?.authenticated);
    } catch {
      // A transport failure during the probe says nothing about the session.
      authenticated = true;
    }

    if (!authenticated) {
      expiredHandler?.();
      throw new ProxyApiError("Your session ended. Sign in again.", {
        status: 401,
        ...(error?.code ? { code: error.code } : {}),
        expired: true,
      });
    }
  }

  throw new ProxyApiError(proxyErrorMessage(response, error), {
    status: response.status,
    ...(error?.code ? { code: error.code } : {}),
  });
}

async function run<T>(
  call: () => Promise<ApiResponse<T>>,
  options: RequestOptions = {},
): Promise<T> {
  try {
    return await unwrap(await call(), options);
  } catch (error) {
    if (error instanceof ProxyApiError) throw error;
    const proxyError = toProxyError(error);
    throw new ProxyApiError(proxyError.message, {
      ...(proxyError.status !== undefined ? { status: proxyError.status } : {}),
      ...(proxyError.code ? { code: proxyError.code } : {}),
    });
  }
}

// ---- Authentication -------------------------------------------------------

export function getAuthStatus(): Promise<AuthStatus> {
  return run(() => apiClient.GET("/api/auth/status"), { auth: false });
}

export function setupAdmin(body: SetupAdminRequest): Promise<AuthSession> {
  return run(() => apiClient.POST("/api/auth/setup", { body }), { auth: false });
}

export function loginAdmin(body: LoginRequest): Promise<AuthSession> {
  // A 401 here is usually `totp_required`, not an expired session.
  return run(() => apiClient.POST("/api/auth/login", { body }), { auth: false });
}

export function logoutAdmin(): Promise<void> {
  return run<void>(() => apiClient.POST("/api/auth/logout"), { empty: true });
}

export function changePassword(body: ChangePasswordRequest): Promise<void> {
  return run<void>(() => apiClient.POST("/api/auth/password", { body }), { empty: true });
}

export function setupTotp(): Promise<Schemas["TotpSetup"]> {
  return run(() => apiClient.POST("/api/auth/2fa/setup"));
}

export function enableTotp(code: string): Promise<Schemas["TotpEnabled"]> {
  return run(() => apiClient.POST("/api/auth/2fa/enable", { body: { code } }));
}

export function disableTotp(body: Schemas["DisableTotpRequest"]): Promise<void> {
  return run<void>(() => apiClient.POST("/api/auth/2fa/disable", { body }), { empty: true });
}

// ---- Configuration and health --------------------------------------------

export function fetchConfig(): Promise<PublicConfig> {
  return run(() => apiClient.GET("/api/config"));
}

export function saveConfig(body: ConfigUpdate): Promise<PublicConfig> {
  return run(() => apiClient.PUT("/api/config", { body }));
}

export function fetchHealth(): Promise<ConnectionHealth> {
  return run(() => apiClient.GET("/api/health"));
}

export function fetchLiveness(): Promise<Liveness> {
  return run(() => apiClient.GET("/healthz"), { auth: false });
}

// ---- Torrents -------------------------------------------------------------

export function fetchTorrents(): Promise<TorrentSummary[]> {
  return run(() => apiClient.GET("/api/torrents")).then((result) =>
    Array.isArray(result.torrents) ? result.torrents : [],
  );
}

export function fetchTorrent(hash: string): Promise<TorrentSummary> {
  return run(() => apiClient.GET("/api/torrents/{hash}", { params: { path: { hash } } }));
}

export function addTorrents(body: AddTorrentRequest): Promise<AddTorrentResult> {
  return run(() => apiClient.POST("/api/torrents", { body }));
}

export function removeTorrent(hash: string, deleteFiles = false): Promise<void> {
  return run<void>(
    () =>
      apiClient.DELETE("/api/torrents/{hash}", {
        params: { path: { hash }, query: { deleteFiles } },
      }),
    { empty: true },
  );
}

// ---- Archive downloads ----------------------------------------------------

export function createArchiveTicket(hash: string): Promise<ArchiveTicket> {
  return run(() => apiClient.POST("/api/archive/{hash}/ticket", { params: { path: { hash } } }));
}

/** Same-origin ZIP URL for a single-use ticket. */
export function archiveDownloadHref(hash: string, ticket: string): string {
  return `/archive/${encodeURIComponent(hash)}?ticket=${encodeURIComponent(ticket)}`;
}

/** Same-origin ZIP URL for headers or cookie-authorized downloads. */
export function archiveHref(hash: string): string {
  return `/archive/${encodeURIComponent(hash)}`;
}

// ---- Pairing and devices --------------------------------------------------

export function createPairing(url: string): Promise<PairingSession> {
  return run(() => apiClient.POST("/api/pair", { body: { url } }));
}

/** Revoking an unknown or expired id is not an error, so pagehide can be quiet. */
export async function revokePairing(id: string): Promise<void> {
  try {
    await run<void>(
      () =>
        apiClient.DELETE("/api/pair/{id}", {
          params: { path: { id } },
          keepalive: true,
        }),
      { empty: true },
    );
  } catch {
    // The code may already have been consumed or rotated away.
  }
}

export function fetchDevices(): Promise<PublicDevice[]> {
  return run(() => apiClient.GET("/api/devices")).then((result) =>
    Array.isArray(result.devices) ? result.devices : [],
  );
}

export function revokeDevice(id: string): Promise<void> {
  return run<void>(() => apiClient.DELETE("/api/devices/{id}", { params: { path: { id } } }), {
    empty: true,
  });
}
