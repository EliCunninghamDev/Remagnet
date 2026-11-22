import { describe, expect, test } from "bun:test";
import { QBittorrentAuthError, QBittorrentClient, QBittorrentError } from "../src/index";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

type Handler = (call: RecordedCall, index: number) => Response | Promise<Response>;

function createMock(handler: Handler) {
  const calls: RecordedCall[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;

  return { calls, fetchMock };
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
}

function headersOf(call: RecordedCall | undefined): Headers {
  return new Headers(call?.init.headers);
}

describe("QBittorrentClient authentication", () => {
  test("uses an API key with no login round-trip", async () => {
    const { calls, fetchMock } = createMock(() => jsonResponse([{ hash: "abc" }]));
    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "qbt_test_key",
      fetch: fetchMock,
      cookieMode: "browser",
    });

    const torrents = await client.getTorrents({ filter: "downloading" });

    expect(torrents).toHaveLength(1);
    expect(torrents[0]?.hash).toBe("abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8080/api/v2/torrents/info?filter=downloading");
    expect(headersOf(calls[0]).get("authorization")).toBe("Bearer qbt_test_key");
  });

  test("API keys take precedence over username/password", async () => {
    const { calls, fetchMock } = createMock(() => jsonResponse([]));
    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "qbt_preferred",
      username: "admin",
      password: "adminadmin",
      fetch: fetchMock,
      cookieMode: "browser",
    });

    await client.getTorrents();

    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0]).get("authorization")).toBe("Bearer qbt_preferred");
  });

  test("logs in and reuses the SID cookie in manual mode", async () => {
    const { calls, fetchMock } = createMock(({ url }) => {
      if (url.endsWith("/api/v2/auth/login")) {
        return new Response("Ok.", {
          status: 200,
          headers: { "set-cookie": "SID=sid123; path=/" },
        });
      }
      return jsonResponse([{ hash: "abc" }]);
    });
    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080",
      username: "admin",
      password: "secret",
      fetch: fetchMock,
      cookieMode: "manual",
    });

    await client.getTorrents();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8080/api/v2/auth/login");
    expect(headersOf(calls[0]).get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(calls[0]?.init.body?.toString()).toBe("username=admin&password=secret");
    expect(headersOf(calls[1]).get("cookie")).toBe("SID=sid123");
  });

  test("retries once after a 403 in browser cookie mode", async () => {
    let torrentRequests = 0;
    const { calls, fetchMock } = createMock(({ url }) => {
      if (url.endsWith("/api/v2/auth/login")) return new Response("Ok.");
      torrentRequests += 1;
      if (torrentRequests === 1) return new Response("Forbidden", { status: 403 });
      return jsonResponse([]);
    });
    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080",
      username: "admin",
      password: "secret",
      fetch: fetchMock,
      cookieMode: "browser",
    });

    await client.getTorrents();

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v2/torrents/info",
      "/api/v2/auth/login",
      "/api/v2/torrents/info",
    ]);
    expect(calls[0]?.init.credentials).toBe("include");
    expect(calls[1]?.init.credentials).toBe("include");
  });

  test("throws an auth error for a rejected API key", async () => {
    const { calls, fetchMock } = createMock(
      () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "qbt_bad",
      fetch: fetchMock,
    });

    let error: unknown;
    try {
      await client.getAppVersion();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(QBittorrentAuthError);
    expect((error as QBittorrentAuthError).status).toBe(401);
    expect(calls).toHaveLength(1);
  });
});

describe("QBittorrentClient torrents", () => {
  test("serializes addTorrent parameters", async () => {
    const { calls, fetchMock } = createMock(() => new Response("Ok."));
    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080/",
      apiKey: "qbt_test",
      fetch: fetchMock,
    });

    await client.addTorrent({
      urls: ["magnet:?xt=urn:btih:one", "magnet:?xt=urn:btih:two"],
      category: "tv",
      tags: ["a", "b"],
      paused: true,
      savePath: "/downloads/tv",
    });

    const body = calls[0]?.init.body as URLSearchParams;
    expect(calls[0]?.url).toBe("http://127.0.0.1:8080/api/v2/torrents/add");
    expect(body.get("urls")).toBe("magnet:?xt=urn:btih:one\nmagnet:?xt=urn:btih:two");
    expect(body.get("category")).toBe("tv");
    expect(body.get("tags")).toBe("a,b");
    expect(body.get("paused")).toBe("true");
    expect(body.get("stopped")).toBe("true");
    expect(body.get("savepath")).toBe("/downloads/tv");
  });

  test("starts and stops torrents with the current endpoint names", async () => {
    const { calls, fetchMock } = createMock(() => new Response(""));
    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "qbt_test",
      fetch: fetchMock,
    });

    await client.stopTorrents(["abc", "def"]);
    await client.startTorrents("abc");
    await client.pauseTorrents("abc");
    await client.resumeTorrents("abc");

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v2/torrents/stop",
      "/api/v2/torrents/start",
      "/api/v2/torrents/stop",
      "/api/v2/torrents/start",
    ]);
    const body = calls[0]?.init.body;
    expect(body instanceof URLSearchParams ? body.get("hashes") : undefined).toBe("abc|def");
  });

  test("surfaces qBittorrent's Fails response", async () => {
    const { fetchMock } = createMock(() => new Response("Fails."));
    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "qbt_test",
      fetch: fetchMock,
    });

    let error: unknown;
    try {
      await client.addTorrent({ urls: "magnet:?xt=urn:btih:bad" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(QBittorrentError);
    expect((error as QBittorrentError).body).toBe("Fails.");
  });

  test("supports a base URL with a path prefix", async () => {
    const { calls, fetchMock } = createMock(() => new Response("v5.2.0"));
    const client = new QBittorrentClient({
      baseUrl: "https://example.com/qbt",
      apiKey: "qbt_test",
      fetch: fetchMock,
    });

    await expect(client.getAppVersion()).resolves.toBe("v5.2.0");
    expect(calls[0]?.url).toBe("https://example.com/qbt/api/v2/app/version");
  });

  test("throws QBittorrentError with status details", async () => {
    const { fetchMock } = createMock(
      () =>
        new Response("Unsupported Media Type", {
          status: 415,
          statusText: "Unsupported Media Type",
        }),
    );
    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "qbt_test",
      fetch: fetchMock,
    });

    let error: unknown;
    try {
      await client.getPreferences();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(QBittorrentError);
    expect((error as QBittorrentError).status).toBe(415);
    expect((error as QBittorrentError).body).toBe("Unsupported Media Type");
  });

  test("completes the cookie login flow against a real HTTP server", async () => {
    const loginBody = "username=admin&password=secret";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v2/auth/login") {
          if ((await request.text()) !== loginBody) {
            return new Response("Fails.", { status: 200 });
          }
          return new Response("Ok.", {
            status: 200,
            headers: { "set-cookie": "SID=integration; path=/" },
          });
        }
        if (request.headers.get("cookie") !== "SID=integration") {
          return new Response("Forbidden", { status: 403 });
        }
        return Response.json([{ hash: "from-server" }]);
      },
    });

    try {
      const client = new QBittorrentClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        username: "admin",
        password: "secret",
        cookieMode: "manual",
      });

      const torrents = await client.getTorrents();
      expect(torrents[0]?.hash).toBe("from-server");
    } finally {
      server.stop(true);
    }
  });
});
