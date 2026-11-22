import { describe, expect, test } from "bun:test";
import { archiveDownloadUrl, archiveUrl, createProxyClient, proxyErrorMessage } from "../src";

describe("createProxyClient", () => {
  test("normalizes the base URL and attaches the bearer token", async () => {
    let request: Request | undefined;
    const client = createProxyClient({
      baseUrl: "https://bridge.example/",
      token: "secret-token",
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
    expect(request?.headers.get("Authorization")).toBe("Bearer secret-token");
  });

  test("rejects an empty URL or token", () => {
    expect(() => createProxyClient({ baseUrl: " ", token: "secret-token" })).toThrow(/URL/);
    expect(() => createProxyClient({ baseUrl: "https://bridge.example", token: "  " })).toThrow(
      /token/,
    );
  });

  test("passes structured proxy errors through", async () => {
    const client = createProxyClient({
      baseUrl: "https://bridge.example",
      token: "secret-token",
      fetch: async () =>
        new Response(JSON.stringify({ error: "Missing or invalid bridge token." }), {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        }),
    });

    const { data, error, response } = await client.GET("/api/health");

    expect(data).toBeUndefined();
    expect(error?.error).toBe("Missing or invalid bridge token.");
    expect(proxyErrorMessage(response, error)).toBe(
      "The archive bridge returned 401 Unauthorized: Missing or invalid bridge token.",
    );
  });
});

describe("archive URLs", () => {
  test("encodes the hash and strips trailing slashes", () => {
    expect(archiveUrl("https://bridge.example/", "a b")).toBe(
      "https://bridge.example/archive/a%20b",
    );
  });

  test("builds header and query-token download URLs", () => {
    expect(archiveDownloadUrl("https://bridge.example/", "abc", "token", true)).toBe(
      "https://bridge.example/archive/abc",
    );
    expect(archiveDownloadUrl("https://bridge.example", "a b", "tok en", false)).toBe(
      "https://bridge.example/archive/a%20b?token=tok+en",
    );
  });
});
