import { afterEach, describe, expect, test } from "bun:test";
import { claimPairing, parsePairingLink } from "./pairing";

const originalFetch = globalThis.fetch;
const CODE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 32 zero bytes
const ID = "session-1";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function link(overrides: Partial<Record<"url" | "id" | "code", string>> = {}): string {
  const values = {
    url: "https://proxy.example.com",
    id: ID,
    code: CODE,
    ...overrides,
  };
  const query = Object.entries(values)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `remagnet://pair?${query}`;
}

describe("parsePairingLink", () => {
  test("reads the origin, session and code", () => {
    const parsed = parsePairingLink(link({ code: "abc+/=" }));

    expect(parsed.baseUrl).toBe("https://proxy.example.com");
    expect(parsed.id).toBe(ID);
    expect(parsed.code).toBe("abc+/=");
  });

  test("rejects a plain HTTP origin that the phone could not reach", () => {
    expect(() => parsePairingLink(link({ url: "http://proxy.example.com" }))).toThrow("HTTPS");
  });

  test("accepts loopback HTTP for local testing", () => {
    const parsed = parsePairingLink(link({ url: "http://127.0.0.1:8080/" }));

    expect(parsed.baseUrl).toBe("http://127.0.0.1:8080");
  });

  test("rejects incomplete or unrelated links", () => {
    expect(() => parsePairingLink("")).toThrow("Paste a pairing link");
    expect(() => parsePairingLink("https://proxy.example.com")).toThrow("remagnet://pair");
    expect(() => parsePairingLink(link({ code: "" }))).toThrow("incomplete");
    expect(() => parsePairingLink(link({ id: "" }))).toThrow("incomplete");
  });
});

describe("claimPairing", () => {
  test("sends only the proof and decrypts the connection", async () => {
    let seenUrl = "";
    let seenBody = "";
    const encrypted = await encrypt(
      JSON.stringify({
        version: 1,
        qbitBaseUrl: "https://qbt.example.com",
        authMode: "password",
        username: "admin",
        password: "secret",
        proxyToken: "0123456789abcdef",
      }),
      ID,
      CODE,
    );
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = String(init?.body);
      return Response.json(encrypted);
    }) as unknown as typeof fetch;

    const paired = await claimPairing(parsePairingLink(link()));

    expect(seenUrl).toBe("https://proxy.example.com/api/pair/claim");
    expect(seenBody).toContain(`"id":"${ID}"`);
    // SHA-256 of 32 zero bytes, base64url without padding.
    expect(seenBody).toContain('"proof":"Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU"');
    expect(seenBody).not.toContain(CODE);

    expect(paired).toEqual({
      proxyBaseUrl: "https://proxy.example.com",
      proxyToken: "0123456789abcdef",
      qbitBaseUrl: "https://qbt.example.com",
      authMode: "password",
      apiKey: undefined,
      username: "admin",
      password: "secret",
    });
  });

  test("surfaces the proxy's rejection message", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "The pairing code is invalid or expired." },
        { status: 400 },
      )) as unknown as typeof fetch;

    await expect(claimPairing(parsePairingLink(link()))).rejects.toThrow(
      "The pairing code is invalid or expired.",
    );
  });

  test("rejects a payload encrypted for a different code", async () => {
    const other = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    const encrypted = await encrypt(
      JSON.stringify({ version: 1, qbitBaseUrl: "https://qbt", proxyToken: "token" }),
      ID,
      other,
    );
    globalThis.fetch = (async () => Response.json(encrypted)) as unknown as typeof fetch;

    await expect(claimPairing(parsePairingLink(link()))).rejects.toThrow("could not be decrypted");
  });
});

async function encrypt(payload: string, id: string, code: string) {
  const secret = fromBase64Url(code);
  const material = new Uint8Array([
    ...new TextEncoder().encode("remagnet-pair-v1"),
    ...new TextEncoder().encode(id),
    ...secret,
  ]);
  const raw = await crypto.subtle.digest("SHA-256", material);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(7);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(payload),
  );
  return { iv: toBase64Url(iv), data: toBase64Url(new Uint8Array(data)) };
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
