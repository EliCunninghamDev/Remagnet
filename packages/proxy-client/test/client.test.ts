import { describe, expect, test } from "bun:test";
import {
  archiveDownloadUrl,
  archiveUrl,
  createProxyClient,
  createPublicProxyClient,
  proxyErrorCode,
  proxyErrorMessage,
} from "../src";

describe("createProxyClient", () => {
  test("normalizes the base URL and attaches the bearer token", async () => {
    let request: Request | undefined;
    const client = createProxyClient({
      baseUrl: "https://bridge.example/",
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
    expect(request?.url).toBe("https://bridge.example/api/health");
    expect(request?.headers.get("Authorization")).toBe("Bearer rmg_device_token");
  });

  test("rejects an empty URL or token", () => {
    expect(() => createProxyClient({ baseUrl: " ", token: "rmg_token" })).toThrow(/URL/);
    expect(() => createProxyClient({ baseUrl: "https://bridge.example", token: "  " })).toThrow(
      /token/,
    );
  });

  test("passes structured proxy errors through", async () => {
    const client = createProxyClient({
      baseUrl: "https://bridge.example",
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
    expect(proxyErrorMessage(response, error)).toBe(
      "The Remagnet Proxy returned 401 Unauthorized: Authentication required.",
    );
  });
});

describe("createPublicProxyClient", () => {
  test("calls public bootstrap endpoints without credentials", async () => {
    let request: Request | undefined;
    let body: unknown;
    const client = createPublicProxyClient("https://bridge.example/", async (input) => {
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
    expect(request?.url).toBe("https://bridge.example/api/auth/device");
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
      "https://bridge.example",
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

describe("archive URLs", () => {
  test("encodes the hash and strips trailing slashes", () => {
    expect(archiveUrl("https://bridge.example/", "a b")).toBe(
      "https://bridge.example/archive/a%20b",
    );
  });

  test("omits credentials when no ticket is supplied", () => {
    expect(archiveDownloadUrl("https://bridge.example/", "abc")).toBe(
      "https://bridge.example/archive/abc",
    );
  });

  test("appends an encoded single-use ticket", () => {
    expect(archiveDownloadUrl("https://bridge.example", "a b", "ticket+/=")).toBe(
      "https://bridge.example/archive/a%20b?ticket=ticket%2B%2F%3D",
    );
  });

  test("treats a blank ticket as no ticket", () => {
    expect(archiveDownloadUrl("https://bridge.example", "abc", "  ")).toBe(
      "https://bridge.example/archive/abc",
    );
  });
});
