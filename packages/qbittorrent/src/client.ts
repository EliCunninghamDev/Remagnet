import { QBittorrentAuthError, QBittorrentError } from "./errors";
import type {
  AddTorrentOptions,
  AppPreferences,
  BuildInfo,
  Category,
  MainData,
  TorrentFile,
  TorrentInfo,
  TorrentListParams,
  TorrentTracker,
  TransferInfo,
} from "./types";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface QBittorrentClientOptions {
  /** Web UI root, for example `http://127.0.0.1:8080` or `https://host/qbt`. */
  baseUrl: string;
  /**
   * qBittorrent v5.2+ API key (`qbt_...`). When set it takes precedence over
   * username/password and requests are authenticated with `Authorization: Bearer`.
   */
  apiKey?: string;
  username?: string;
  password?: string;
  /** Custom fetch implementation, mainly for tests or non-standard runtimes. */
  fetch?: FetchLike;
  /**
   * How the SID cookie is handled.
   *
   * - `browser`: let the browser cookie jar send/store the SID (extensions).
   * - `manual`: parse `Set-Cookie` and send a `Cookie` header (Bun/Node).
   * - `auto`: pick `manual` in Node-like runtimes, otherwise `browser`.
   */
  cookieMode?: "auto" | "browser" | "manual";
  /** Per-request timeout in milliseconds. Defaults to 15s. Set to 0 to disable. */
  timeoutMs?: number;
}

type FormValue = string | number | boolean | undefined;

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: BodyInit | null;
  form?: Record<string, FormValue>;
}

export class QBittorrentClient {
  readonly baseUrl: string;
  readonly apiKey?: string;

  private readonly username?: string;
  private readonly password: string;
  private readonly fetchImpl: FetchLike;
  private readonly cookieMode: "browser" | "manual";
  private readonly timeoutMs: number;
  private sid: string | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(options: QBittorrentClientOptions) {
    const baseUrl = options.baseUrl?.trim();
    if (!baseUrl) {
      throw new QBittorrentError("A qBittorrent baseUrl is required");
    }

    try {
      new URL(baseUrl);
    } catch {
      throw new QBittorrentError(`Invalid qBittorrent baseUrl: ${baseUrl}`);
    }

    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.username = options.username?.trim() || undefined;
    this.password = options.password ?? "";
    this.cookieMode =
      !options.cookieMode || options.cookieMode === "auto"
        ? detectCookieMode()
        : options.cookieMode;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  get hasApiKey(): boolean {
    return this.apiKey !== undefined;
  }

  get hasPasswordAuth(): boolean {
    return this.username !== undefined;
  }

  /** Log in with username/password. No-op when an API key is configured. */
  async login(force = false): Promise<void> {
    if (this.apiKey) return;
    if (!this.username) {
      throw new QBittorrentAuthError(
        "No username configured. Provide an API key or username/password.",
      );
    }
    if (!force && this.cookieMode === "manual" && this.sid) return;
    if (this.loginPromise) return this.loginPromise;

    const promise = this.performLogin();
    this.loginPromise = promise;
    try {
      await promise;
    } finally {
      if (this.loginPromise === promise) this.loginPromise = null;
    }
  }

  /** Log out of the cookie-based session. No-op when an API key is configured. */
  async logout(): Promise<void> {
    if (this.apiKey) return;

    try {
      const response = await this.send("api/v2/auth/logout", { method: "POST" });
      if (!response.ok) {
        throw new QBittorrentError(
          `qBittorrent logout failed: ${response.status} ${response.statusText}`.trim(),
          {
            status: response.status,
            statusText: response.statusText,
            body: await response.text(),
            url: this.resolve("api/v2/auth/logout"),
          },
        );
      }
    } finally {
      this.sid = null;
    }
  }

  /** Authenticate (if needed) and return the app and Web API versions. */
  async testConnection(): Promise<{ appVersion: string; webApiVersion: string }> {
    await this.login();
    const [appVersion, webApiVersion] = await Promise.all([
      this.getAppVersion(),
      this.getWebApiVersion(),
    ]);
    return { appVersion, webApiVersion };
  }

  async getAppVersion(): Promise<string> {
    return this.request<string>("api/v2/app/version");
  }

  async getWebApiVersion(): Promise<string> {
    return this.request<string>("api/v2/app/webapiVersion");
  }

  async getBuildInfo(): Promise<BuildInfo> {
    return this.request<BuildInfo>("api/v2/app/buildInfo");
  }

  async getPreferences(): Promise<AppPreferences> {
    return this.request<AppPreferences>("api/v2/app/preferences");
  }

  /** Rotate the Web API key. Requires an authenticated client. */
  async rotateApiKey(): Promise<string> {
    return this.request<string>("api/v2/app/rotateAPIKey", { method: "POST" });
  }

  /** Delete the current Web API key. Requires an authenticated client. */
  async deleteApiKey(): Promise<void> {
    await this.request("api/v2/app/deleteAPIKey", { method: "POST" });
  }

  async getTorrents(params: TorrentListParams = {}): Promise<TorrentInfo[]> {
    const query = new URLSearchParams();
    if (params.filter) query.set("filter", params.filter);
    if (params.category) query.set("category", params.category);
    if (params.tag) query.set("tag", params.tag);
    if (params.sort) query.set("sort", params.sort);
    if (params.reverse !== undefined) query.set("reverse", String(params.reverse));
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));
    if (params.hashes) query.set("hashes", joinHashes(params.hashes));

    const search = query.toString();
    return this.request<TorrentInfo[]>(`api/v2/torrents/info${search ? `?${search}` : ""}`);
  }

  async addTorrent(options: AddTorrentOptions): Promise<void> {
    const hasUrls = Array.isArray(options.urls) ? options.urls.length > 0 : Boolean(options.urls);
    const hasFiles = (options.files?.length ?? 0) > 0;
    if (!hasUrls && !hasFiles) {
      throw new QBittorrentError("addTorrent requires at least one URL or .torrent file");
    }

    const form: Record<string, FormValue> = {};
    if (options.urls) {
      form.urls = Array.isArray(options.urls) ? options.urls.join("\n") : options.urls;
    }
    if (options.savePath !== undefined) form.savepath = options.savePath;
    if (options.category !== undefined) form.category = options.category;
    if (options.tags !== undefined) {
      form.tags = Array.isArray(options.tags) ? options.tags.join(",") : options.tags;
    }
    if (options.paused !== undefined) {
      // qBittorrent < 5 reads "paused"; >= 5 reads "stopped" and ignores "paused".
      form.paused = options.paused;
      form.stopped = options.paused;
    }
    if (options.skipChecking !== undefined) form.skip_checking = options.skipChecking;
    if (options.sequentialDownload !== undefined) {
      form.sequentialDownload = options.sequentialDownload;
    }
    if (options.firstLastPiecePrio !== undefined) {
      form.firstLastPiecePrio = options.firstLastPiecePrio;
    }
    if (options.autoTMM !== undefined) form.autoTMM = options.autoTMM;
    if (options.rename !== undefined) form.rename = options.rename;
    if (options.upLimit !== undefined) form.upLimit = options.upLimit;
    if (options.dlLimit !== undefined) form.dlLimit = options.dlLimit;
    if (options.ratioLimit !== undefined) form.ratioLimit = options.ratioLimit;
    if (options.seedingTimeLimit !== undefined) {
      form.seedingTimeLimit = options.seedingTimeLimit;
    }

    let result: string;
    if (hasFiles) {
      const body = new FormData();
      for (const [key, value] of Object.entries(form)) {
        if (value !== undefined) body.set(key, String(value));
      }
      for (const file of options.files ?? []) {
        body.append("torrents", file, file.name);
      }
      result = await this.request<string>("api/v2/torrents/add", { method: "POST", body });
    } else {
      result = await this.request<string>("api/v2/torrents/add", {
        method: "POST",
        form,
      });
    }

    if (typeof result === "string" && result.trim().toLowerCase().startsWith("fail")) {
      throw new QBittorrentError("qBittorrent rejected the torrent", { body: result });
    }
  }

  async deleteTorrents(hashes: string | string[], deleteFiles = false): Promise<void> {
    await this.request("api/v2/torrents/delete", {
      method: "POST",
      form: { hashes: joinHashes(hashes), deleteFiles },
    });
  }

  async stopTorrents(hashes: string | string[]): Promise<void> {
    await this.request("api/v2/torrents/stop", {
      method: "POST",
      form: { hashes: joinHashes(hashes) },
    });
  }

  async startTorrents(hashes: string | string[]): Promise<void> {
    await this.request("api/v2/torrents/start", {
      method: "POST",
      form: { hashes: joinHashes(hashes) },
    });
  }

  /** @deprecated qBittorrent removed `torrents/pause`; alias for {@link stopTorrents}. */
  async pauseTorrents(hashes: string | string[]): Promise<void> {
    await this.stopTorrents(hashes);
  }

  /** @deprecated qBittorrent removed `torrents/resume`; alias for {@link startTorrents}. */
  async resumeTorrents(hashes: string | string[]): Promise<void> {
    await this.startTorrents(hashes);
  }

  async recheckTorrents(hashes: string | string[]): Promise<void> {
    await this.request("api/v2/torrents/recheck", {
      method: "POST",
      form: { hashes: joinHashes(hashes) },
    });
  }

  async reannounceTorrents(hashes: string | string[]): Promise<void> {
    await this.request("api/v2/torrents/reannounce", {
      method: "POST",
      form: { hashes: joinHashes(hashes) },
    });
  }

  async getTorrentFiles(hash: string): Promise<TorrentFile[]> {
    return this.request<TorrentFile[]>(`api/v2/torrents/files?${new URLSearchParams({ hash })}`);
  }

  async getTorrentTrackers(hash: string): Promise<TorrentTracker[]> {
    return this.request<TorrentTracker[]>(
      `api/v2/torrents/trackers?${new URLSearchParams({ hash })}`,
    );
  }

  async addTorrentTrackers(hash: string, urls: string | string[]): Promise<void> {
    await this.request("api/v2/torrents/addTrackers", {
      method: "POST",
      form: {
        hash,
        urls: Array.isArray(urls) ? urls.join("\n") : urls,
      },
    });
  }

  async getCategories(): Promise<Record<string, Category>> {
    return this.request<Record<string, Category>>("api/v2/torrents/categories");
  }

  async createCategory(name: string, savePath = ""): Promise<void> {
    await this.request("api/v2/torrents/createCategory", {
      method: "POST",
      form: { category: name, savePath },
    });
  }

  async removeCategories(categories: string | string[]): Promise<void> {
    await this.request("api/v2/torrents/removeCategories", {
      method: "POST",
      form: {
        categories: Array.isArray(categories) ? categories.join("\n") : categories,
      },
    });
  }

  async getTags(): Promise<string[]> {
    return this.request<string[]>("api/v2/torrents/tags");
  }

  async createTags(tags: string | string[]): Promise<void> {
    await this.request("api/v2/torrents/createTags", {
      method: "POST",
      form: { tags: Array.isArray(tags) ? tags.join(",") : tags },
    });
  }

  async deleteTags(tags: string | string[]): Promise<void> {
    await this.request("api/v2/torrents/deleteTags", {
      method: "POST",
      form: { tags: Array.isArray(tags) ? tags.join(",") : tags },
    });
  }

  async getTransferInfo(): Promise<TransferInfo> {
    return this.request<TransferInfo>("api/v2/transfer/info");
  }

  async getMainData(rid = 0): Promise<MainData> {
    return this.request<MainData>(
      `api/v2/sync/maindata?${new URLSearchParams({ rid: String(rid) })}`,
    );
  }

  private async performLogin(): Promise<void> {
    this.sid = null;
    const response = await this.send("api/v2/auth/login", {
      method: "POST",
      form: { username: this.username ?? "", password: this.password },
    });
    const body = (await response.text()).trim();

    if (!response.ok || body !== "Ok.") {
      const reason =
        response.status === 403
          ? "Login failed: the IP may be banned after too many attempts."
          : "Login failed: check the username and password.";
      throw new QBittorrentAuthError(reason, {
        status: response.status,
        statusText: response.statusText,
        body,
        url: this.resolve("api/v2/auth/login"),
      });
    }

    if (this.cookieMode === "manual" && !this.sid) {
      throw new QBittorrentAuthError(
        "Login succeeded but qBittorrent did not return a SID cookie",
        { url: this.resolve("api/v2/auth/login") },
      );
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.apiKey || !this.hasPasswordAuth) return;
    if (this.cookieMode === "manual" && !this.sid) {
      await this.login();
    }
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    await this.ensureSession();

    let response = await this.send(path, options);
    if (
      !this.apiKey &&
      this.hasPasswordAuth &&
      (response.status === 401 || response.status === 403)
    ) {
      this.sid = null;
      await this.login(true);
      response = await this.send(path, options);
    }

    const body = await response.text();
    if (!response.ok) {
      const message = `qBittorrent request failed: ${response.status} ${response.statusText}`;
      if (response.status === 401 || response.status === 403) {
        throw new QBittorrentAuthError(message.trim(), {
          status: response.status,
          statusText: response.statusText,
          body,
          url: this.resolve(path),
        });
      }
      throw new QBittorrentError(message.trim(), {
        status: response.status,
        statusText: response.statusText,
        body,
        url: this.resolve(path),
      });
    }

    return parseBody<T>(body);
  }

  private async send(path: string, options: RequestOptions = {}): Promise<Response> {
    const { form, headers: initialHeaders, ...init } = options;
    const headers = new Headers(initialHeaders);
    headers.set("Accept", "application/json");

    let body = init.body;
    if (form) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        if (value !== undefined) params.set(key, String(value));
      }
      body = params;
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }

    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    } else if (this.cookieMode === "manual" && this.sid) {
      headers.set("Cookie", `SID=${this.sid}`);
    }

    const url = this.resolve(path);
    const signal =
      init.signal ?? (this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        body,
        headers,
        credentials: this.cookieMode === "browser" && !this.apiKey ? "include" : "omit",
        signal,
      });
    } catch (error) {
      throw new QBittorrentError(`Could not reach qBittorrent at ${this.baseUrl}`, {
        url,
        cause: error,
      });
    }

    this.captureCookies(response);
    return response;
  }

  private captureCookies(response: Response): void {
    if (this.cookieMode !== "manual") return;

    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : [headers.get("set-cookie")].filter((value): value is string => value !== null);
    for (const cookie of setCookies) {
      const pair = cookie.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name === "SID" && value) this.sid = value;
    }
  }

  private resolve(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }
}

function detectCookieMode(): "browser" | "manual" {
  const runtime = globalThis as {
    process?: { versions?: { node?: string } };
  };
  return runtime.process?.versions?.node ? "manual" : "browser";
}

function joinHashes(hashes: string | string[]): string {
  return Array.isArray(hashes) ? hashes.join("|") : hashes;
}

function parseBody<T>(body: string): T {
  const trimmed = body.trim();
  if (!trimmed) return undefined as T;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // Fall through: not every endpoint returns JSON despite the shape.
    }
  }
  return trimmed as T;
}
