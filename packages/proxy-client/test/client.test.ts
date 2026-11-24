import { describe, expect, test } from "bun:test";
import {
  archiveDownloadUrl,
  archiveUrl,
  createProxyClient,
  createPublicProxyClient,
  describeNetworkError,
  type ProxyErrorCode,
  ProxyHttpError,
  proxyError,
  proxyErrorCode,
  proxyErrorMessage,
  toProxyError,
} from "../src";

describe("createProxyClient", () => {
  test("normalizes the base URL and attaches the bearer token", async () => {
    let request: Request | undefined;
    const client = createProxyClient({
      baseUrl: "https://proxy.example/",
      token: "rmg_device_token",
      fetch: async (input) => {
        request = input;
        return new Response(
          JSON.stringify({ ok: true, appVersion: "5.3.0", webApiVersion: "2.16.2" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const { data, error } = await client.GET("/api/health");

    expect(error).toBeUndefined();
    expect(data?.appVersion).toBe("5.3.0");
    expect(request?.url).toBe("https://proxy.example/api/health");
    expect(request?.headers.get("Authorization")).toBe("Bearer rmg_device_token");
  });

  test("rejects an empty URL or token", () => {
    expect(() => createProxyClient({ baseUrl: " ", token: "rmg_token" })).toThrow(/URL/);
    expect(() => createProxyClient({ baseUrl: "https://proxy.example", token: "  " })).toThrow(
      /token/,
    );
  });

  test("passes structured proxy errors through", async () => {
    const client = createProxyClient({
      baseUrl: "https://proxy.example",
      token: "rmg_device_token",
      fetch: async () =>
        new Response(JSON.stringify({ error: "Authentication required." }), {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        }),
    });

    const { data, error, response } = await client.GET("/api/health");

    expect(data).toBeUndefined();
    expect(error?.error).toBe("Authentication required.");
    expect(proxyErrorMessage(response, error)).toBe("Authentication required.");
  });
});

describe("createPublicProxyClient", () => {
  test("calls public bootstrap endpoints without credentials", async () => {
    let request: Request | undefined;
    let body: unknown;
    const client = createPublicProxyClient("https://proxy.example/", async (input) => {
      request = input;
      body = await input.clone().json();
      return new Response(
        JSON.stringify({
          token: "rmg_new_token",
          device: { id: "dev-1", name: "Pixel 9", createdAt: 1_700_000_000, lastUsedAt: null },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const { data, error } = await client.POST("/api/auth/device", {
      body: { username: "admin", password: "correct horse battery staple", deviceName: "Pixel 9" },
    });

    expect(error).toBeUndefined();
    expect(data?.token).toBe("rmg_new_token");
    expect(data?.device.name).toBe("Pixel 9");
    expect(request?.url).toBe("https://proxy.example/api/auth/device");
    expect(request?.headers.get("Authorization")).toBeNull();
    expect(body).toEqual({
      username: "admin",
      password: "correct horse battery staple",
      deviceName: "Pixel 9",
    });
  });

  test("rejects an empty URL", () => {
    expect(() => createPublicProxyClient(" ")).toThrow(/URL/);
  });
});

describe("proxyErrorCode", () => {
  test("reads totp_required from a parsed error body", async () => {
    const client = createPublicProxyClient(
      "https://proxy.example",
      async () =>
        new Response(
          JSON.stringify({
            error: "Two-factor authentication code required.",
            code: "totp_required",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
    );

    const { error } = await client.POST("/api/auth/device", {
      body: { username: "admin", password: "correct horse battery staple" },
    });

    expect(proxyErrorCode(error)).toBe("totp_required");
  });

  test("returns undefined for non-coded or malformed errors", () => {
    expect(proxyErrorCode({ error: "Authentication required." })).toBeUndefined();
    expect(proxyErrorCode({ code: "" })).toBeUndefined();
    expect(proxyErrorCode({ code: 42 })).toBeUndefined();
    expect(proxyErrorCode(null)).toBeUndefined();
    expect(proxyErrorCode("totp_required")).toBeUndefined();
  });
});

describe("proxyErrorMessage", () => {
  test("returns a clean proxy message without wrapping it", () => {
    const response = new Response(null, { status: 502, statusText: "Bad Gateway" });

    expect(proxyErrorMessage(response, { error: "  qBittorrent is unreachable.  " })).toBe(
      "qBittorrent is unreachable.",
    );
  });

  test("maps common statuses when the body has no message", () => {
    const cases: Array<[number, string, string]> = [
      [
        401,
        "Unauthorized",
        "Authentication failed. Sign in again or reconnect this device in Settings.",
      ],
      [403, "Forbidden", "Access denied by the Remagnet Proxy."],
      [404, "Not Found", "The requested endpoint or torrent was not found on the Remagnet Proxy."],
      [413, "Payload Too Large", "The request was too large for the Remagnet Proxy."],
      [429, "Too Many Requests", "Too many requests. Wait a moment and try again."],
      [
        502,
        "Bad Gateway",
        "The Remagnet Proxy (or reverse proxy in front of it) returned 502 Bad Gateway. Check that Remagnet Proxy and your torrent client are running.",
      ],
      [
        503,
        "Service Unavailable",
        "The Remagnet Proxy is temporarily unavailable (503). Check that the container is running.",
      ],
      [
        504,
        "Gateway Timeout",
        "The request to Remagnet Proxy timed out (504). Check that the proxy and torrent client are responsive.",
      ],
      [
        500,
        "Internal Server Error",
        "The Remagnet Proxy returned an internal error (500). Check the proxy container logs.",
      ],
    ];

    for (const [status, statusText, expected] of cases) {
      expect(proxyErrorMessage(new Response(null, { status, statusText }))).toBe(expected);
    }
  });

  test("falls back to the status and status text", () => {
    expect(proxyErrorMessage(new Response(null, { status: 418, statusText: "I'm a teapot" }))).toBe(
      "The Remagnet Proxy returned HTTP 418 I'm a teapot.",
    );
    expect(proxyErrorMessage(new Response(null, { status: 418 }))).toBe(
      "The Remagnet Proxy returned HTTP 418.",
    );
  });
});

describe("proxyError", () => {
  test("keeps the status and machine-readable code", () => {
    const response = new Response(null, { status: 401, statusText: "Unauthorized" });
    const error = proxyError(response, {
      error: "Two-factor authentication code required.",
      code: "totp_required",
    });

    expect(error).toBeInstanceOf(ProxyHttpError);
    expect(error.name).toBe("ProxyHttpError");
    expect(error.message).toBe("Two-factor authentication code required.");
    expect(error.status).toBe(401);
    expect(error.code).toBe("totp_required");
    expect(error).toBeInstanceOf(Error);
  });

  test("omits the code when the body has none", () => {
    const error = proxyError(new Response(null, { status: 403 }));

    expect(error.status).toBe(403);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("Access denied by the Remagnet Proxy.");
  });
});

describe("ProxyHttpError", () => {
  test("starts without a status or code", () => {
    const error = new ProxyHttpError("Something went wrong.");

    expect(error.message).toBe("Something went wrong.");
    expect(error.status).toBeUndefined();
    expect(error.code).toBeUndefined();
  });
});

describe("describeNetworkError", () => {
  test("returns the message of an existing proxy error", () => {
    expect(describeNetworkError(new ProxyHttpError("Access denied by the Remagnet Proxy."))).toBe(
      "Access denied by the Remagnet Proxy.",
    );
  });

  test("explains timeouts", () => {
    const timeout = new Error("The operation timed out.");
    timeout.name = "TimeoutError";
    const aborted = new Error("The operation was aborted.");
    aborted.name = "AbortError";

    const expected =
      "Timed out reaching the Remagnet Proxy. Check that the server is running and reachable.";
    expect(describeNetworkError(timeout)).toBe(expected);
    expect(describeNetworkError(aborted)).toBe(expected);
    expect(describeNetworkError(new Error("Request timeout exceeded"))).toBe(expected);
  });

  test("explains browser fetch failures", () => {
    const expected =
      "Could not reach the Remagnet Proxy. Check the proxy URL, that the server is running, and that its HTTPS certificate is trusted by your browser.";

    expect(describeNetworkError(new TypeError("Failed to fetch"))).toBe(expected);
    expect(
      describeNetworkError(new TypeError("NetworkError when attempting to fetch resource.")),
    ).toBe(expected);
    expect(describeNetworkError(new TypeError("Load failed"))).toBe(expected);
    expect(describeNetworkError(new TypeError("Network request failed"))).toBe(expected);
  });

  test("preserves other errors and non-error values", () => {
    expect(describeNetworkError(new Error("Disk is full."))).toBe("Disk is full.");
    expect(describeNetworkError("plain string")).toBe("plain string");
  });
});

describe("toProxyError", () => {
  test("returns an existing ProxyHttpError unchanged", () => {
    const original = new ProxyHttpError("Access denied by the Remagnet Proxy.", {
      status: 403,
      code: "forbidden",
    });

    expect(toProxyError(original)).toBe(original);
  });

  test("wraps network failures without leaking the raw TypeError", () => {
    const error = toProxyError(new TypeError("Failed to fetch"), "https://proxy.example");

    expect(error).toBeInstanceOf(ProxyHttpError);
    expect(error.message).toBe(
      "Could not reach the Remagnet Proxy. Check the proxy URL, that the server is running, and that its HTTPS certificate is trusted by your browser.",
    );
    expect(error.status).toBeUndefined();
    expect(error.code).toBeUndefined();
  });

  test("keeps structured details from other errors", () => {
    const cause = Object.assign(new Error("Upstream exploded."), {
      status: 502,
      code: "upstream_error",
    });
    const error = toProxyError(cause);

    expect(error.message).toBe("Upstream exploded.");
    expect(error.status).toBe(502);
    expect(error.code).toBe("upstream_error");
  });
});

describe("ProxyErrorCode", () => {
  test("names the machine-readable codes from the schema", () => {
    const code: ProxyErrorCode = "rate_limited";

    expect(code).toBe("rate_limited");
  });
});

describe("archive URLs", () => {
  test("encodes the hash and strips trailing slashes", () => {
    expect(archiveUrl("https://proxy.example/", "a b")).toBe("https://proxy.example/archive/a%20b");
  });

  test("omits credentials when no ticket is supplied", () => {
    expect(archiveDownloadUrl("https://proxy.example/", "abc")).toBe(
      "https://proxy.example/archive/abc",
    );
  });

  test("appends an encoded single-use ticket", () => {
    expect(archiveDownloadUrl("https://proxy.example", "a b", "ticket+/=")).toBe(
      "https://proxy.example/archive/a%20b?ticket=ticket%2B%2F%3D",
    );
  });

  test("treats a blank ticket as no ticket", () => {
    expect(archiveDownloadUrl("https://proxy.example", "abc", "  ")).toBe(
      "https://proxy.example/archive/abc",
    );
  });
});
