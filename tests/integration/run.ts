/**
 * End-to-end containerized regression test runner for Remagnet Proxy against
 * real torrent client containers (qBittorrent or Transmission).
 *
 * Usage: bun run tests/integration/run.ts --client <qbittorrent|transmission>
 */
import assert from "node:assert/strict";
import { buildTorrentFixture, readStoredZip, sha256, toHex } from "./fixture";

type ClientKind = "qbittorrent" | "transmission";

const client = parseClientArg();
const proxyBase = process.env.PROXY_URL ?? "http://127.0.0.1:18081";
const qbitHostBase = process.env.QBIT_HOST_URL ?? "http://127.0.0.1:18080";
const transmissionHostBase = process.env.TRANSMISSION_HOST_URL ?? "http://127.0.0.1:19091";

const SETUP_CODE = "integration-setup-code";
const ADMIN_USER = "admin";
const ADMIN_PASS = "remagnet-integration-password-123";

const ownedFixture = await buildTorrentFixture("remagnet-fixture.bin", "remagnet-owned");
const unrelatedFixture = await buildTorrentFixture("unrelated-fixture.bin", "remagnet-unrelated");
const magnetFixture = await buildTorrentFixture("remagnet-magnet.bin", "remagnet-magnet-only");

async function main() {
  console.log(`\n=== Running Remagnet integration suite for ${client} ===`);

  // 1. Wait for proxy and backend client containers to become reachable.
  const healthz = await waitFor("proxy /healthz", async () => {
    const res = await fetch(`${proxyBase}/healthz`);
    if (!res.ok) return null;
    return (await res.json()) as { ok: boolean; apiVersion: number; version: string };
  });
  assert.equal(healthz.ok, true);
  assert.equal(healthz.apiVersion, 1);
  console.log(`✓ Proxy alive (v${healthz.version}, apiVersion=${healthz.apiVersion})`);

  await waitForBackendReady(client);
  console.log(`✓ ${client} container ready`);

  // 2. Verify first-run status & SETUP_CODE enforcement.
  const initialStatus = await jsonFetch<{
    initialized: boolean;
    requiresSetupCode: boolean;
    authenticated: boolean;
  }>(`${proxyBase}/api/auth/status`);
  assert.equal(initialStatus.body.initialized, false);
  assert.equal(initialStatus.body.requiresSetupCode, true);

  const badSetup = await jsonFetch(`${proxyBase}/api/auth/setup`, {
    method: "POST",
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS, setupCode: "wrong" }),
  });
  assert.equal(badSetup.status, 403);

  const setup = await jsonFetch<{ username: string }>(`${proxyBase}/api/auth/setup`, {
    method: "POST",
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS, setupCode: SETUP_CODE }),
  });
  assert.equal(setup.status, 201);
  const adminCookie = extractSessionCookie(setup.headers);
  assert.ok(adminCookie, "Expected remagnet_session cookie from setup");
  console.log("✓ Admin setup and SETUP_CODE enforcement verified");

  // 3. Configure the backend client via PUT /api/config and verify GET /api/health.
  const configBody =
    client === "qbittorrent"
      ? {
          clientKind: "qbittorrent",
          baseUrl: "http://qbittorrent:8080",
          username: "admin",
          password: "adminadmin",
          defaultCategory: "remagnet",
          defaultTags: ["remagnet"],
        }
      : {
          clientKind: "transmission",
          baseUrl: "http://transmission:9091",
          username: "remagnet",
          password: "remagnet-test-pass",
          downloadsDir: "/downloads",
          clientDownloadsDir: "/downloads",
          defaultCategory: "",
          defaultTags: ["remagnet"],
        };

  const savedConfig = await jsonFetch(`${proxyBase}/api/config`, {
    method: "PUT",
    headers: { Cookie: adminCookie },
    body: JSON.stringify(configBody),
  });
  assert.equal(savedConfig.status, 200);

  const health = await waitFor("GET /api/health", async () => {
    const res = await fetch(`${proxyBase}/api/health`, { headers: { Cookie: adminCookie } });
    if (!res.ok) return null;
    return (await res.json()) as {
      ok: boolean;
      apiVersion: number;
      proxyVersion: string;
      clientLabel: string;
      appVersion: string;
      capabilities: { pauseOnAdd: boolean; archiveDownload: boolean };
    };
  });
  assert.equal(health.ok, true);
  assert.equal(health.apiVersion, 1);
  assert.equal(health.capabilities.pauseOnAdd, true);
  assert.equal(health.capabilities.archiveDownload, true);
  console.log(
    `✓ Connected to ${health.clientLabel} ${health.appVersion} (archiveDownload=${health.capabilities.archiveDownload})`,
  );

  // 4. Direct device sign-in and least-privilege 403 enforcement.
  const deviceLogin = await jsonFetch<{ token: string; device: { id: string; name: string } }>(
    `${proxyBase}/api/auth/device`,
    {
      method: "POST",
      body: JSON.stringify({
        username: ADMIN_USER,
        password: ADMIN_PASS,
        deviceName: "Integration runner",
      }),
    },
  );
  assert.equal(deviceLogin.status, 200);
  const deviceToken = deviceLogin.body.token;
  assert.ok(deviceToken.startsWith("rmg_"));

  const adminCheckWithDevice = await jsonFetch(`${proxyBase}/api/config`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(adminCheckWithDevice.status, 403);
  console.log("✓ Device token minted and blocked (403) from admin routes");

  // 5. Pairing flow mints a fresh per-device token encrypted with AES-256-GCM.
  const mintedPair = await jsonFetch<{ id: string; code: string; uri: string }>(
    `${proxyBase}/api/pair`,
    {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: JSON.stringify({ url: proxyBase }),
    },
  );
  assert.equal(mintedPair.status, 200);
  const pairedToken = await claimAndDecryptPairing(mintedPair.body.id, mintedPair.body.code);
  assert.ok(pairedToken.startsWith("rmg_"));
  assert.notEqual(pairedToken, deviceToken);
  console.log("✓ Pairing v2 minted a distinct per-device token");

  // 6. Add a paused magnet via POST /api/torrents, verify list/lookup, then delete.
  const addedMagnet = await jsonFetch<{ added: number; hashes: string[] }>(
    `${proxyBase}/api/torrents`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ urls: [magnetFixture.magnetUri], paused: true }),
    },
  );
  assert.equal(addedMagnet.status, 200);
  assert.equal(addedMagnet.body.added, 1);

  const listedMagnet = await waitFor("paused magnet in GET /api/torrents", async () => {
    const res = await jsonFetch<{ torrents: Array<{ hash: string; state: string }> }>(
      `${proxyBase}/api/torrents`,
      { headers: { Authorization: `Bearer ${deviceToken}` } },
    );
    assert.equal(res.status, 200);
    return res.body.torrents.find((entry) => entry.hash === magnetFixture.infoHash) ?? null;
  });
  assert.equal(listedMagnet.state, "stopped");

  const deletedMagnet = await fetch(
    `${proxyBase}/api/torrents/${magnetFixture.infoHash}?deleteFiles=true`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${deviceToken}` },
    },
  );
  assert.equal(deletedMagnet.status, 204);
  console.log("✓ Paused magnet add, list, and scoped delete verified");

  // 7. Seed an unrelated torrent (no Remagnet tags) directly in the client and verify isolation.
  await seedFixtureDirectly(client, unrelatedFixture.torrentBytes, false);

  const unfilteredLookup = await waitFor(
    "unrelated hash visible on GET /api/torrents/{hash}",
    async () => {
      const res = await fetch(`${proxyBase}/api/torrents/${unrelatedFixture.infoHash}`, {
        headers: { Authorization: `Bearer ${deviceToken}` },
      });
      return res.ok ? await res.json() : null;
    },
  );
  assert.ok(unfilteredLookup);

  const filteredList = await jsonFetch<{ torrents: Array<{ hash: string }> }>(
    `${proxyBase}/api/torrents`,
    { headers: { Authorization: `Bearer ${deviceToken}` } },
  );
  assert.equal(
    filteredList.body.torrents.some((entry) => entry.hash === unrelatedFixture.infoHash),
    false,
    "Unrelated torrent must not appear in GET /api/torrents",
  );

  const unrelatedDelete = await fetch(`${proxyBase}/api/torrents/${unrelatedFixture.infoHash}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(unrelatedDelete.status, 404);

  const unrelatedTicket = await fetch(
    `${proxyBase}/api/archive/${unrelatedFixture.infoHash}/ticket`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` },
    },
  );
  assert.equal(unrelatedTicket.status, 404);

  const unrelatedArchive = await fetch(`${proxyBase}/archive/${unrelatedFixture.infoHash}`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(unrelatedArchive.status, 404);
  console.log("✓ Unrelated torrent hidden from list and blocked (404) from delete & archive");

  // 8. Seed a Remagnet-owned completed torrent offline and verify ZIP streaming (Bearer + Ticket).
  await seedFixtureDirectly(client, ownedFixture.torrentBytes, true);

  await waitFor("owned torrent reaches 100%", async () => {
    const res = await jsonFetch<{ torrents: Array<{ hash: string; progress: number }> }>(
      `${proxyBase}/api/torrents`,
      { headers: { Authorization: `Bearer ${deviceToken}` } },
    );
    const match = res.body.torrents.find((entry) => entry.hash === ownedFixture.infoHash);
    return match && match.progress >= 0.999999 ? match : null;
  });

  // 8a. Bearer-authenticated archive stream.
  const bearerZipRes = await fetch(`${proxyBase}/archive/${ownedFixture.infoHash}`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(bearerZipRes.status, 200);
  await verifyZipPayload(new Uint8Array(await bearerZipRes.arrayBuffer()));

  // 8b. Single-use ticket archive stream.
  const ticketRes = await jsonFetch<{ ticket: string; expiresIn: number }>(
    `${proxyBase}/api/archive/${ownedFixture.infoHash}/ticket`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` },
    },
  );
  assert.equal(ticketRes.status, 200);

  const ticketZipRes = await fetch(
    `${proxyBase}/archive/${ownedFixture.infoHash}?ticket=${encodeURIComponent(ticketRes.body.ticket)}`,
  );
  assert.equal(ticketZipRes.status, 200);
  await verifyZipPayload(new Uint8Array(await ticketZipRes.arrayBuffer()));

  const reusedTicketRes = await fetch(
    `${proxyBase}/archive/${ownedFixture.infoHash}?ticket=${encodeURIComponent(ticketRes.body.ticket)}`,
  );
  assert.equal(reusedTicketRes.status, 401);
  console.log("✓ Completed ZIP streaming verified via Bearer header and single-use ticket");

  // 9. Remove owned torrent and verify self-service device revocation.
  const removeOwned = await fetch(
    `${proxyBase}/api/torrents/${ownedFixture.infoHash}?deleteFiles=false`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${deviceToken}` },
    },
  );
  assert.equal(removeOwned.status, 204);

  const revokeSelf = await fetch(`${proxyBase}/api/devices/current`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(revokeSelf.status, 204);

  const afterRevoke = await fetch(`${proxyBase}/api/torrents`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(afterRevoke.status, 401);
  console.log("✓ Self-service device revocation verified");

  console.log(`=== All ${client} integration checks passed ===\n`);
}

async function verifyZipPayload(zipBytes: Uint8Array) {
  const entries = readStoredZip(zipBytes);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, ownedFixture.name);
  assert.equal(toHex(await sha256(entries[0].data)), ownedFixture.payloadSha256);
}

async function waitForBackendReady(kind: ClientKind) {
  if (kind === "qbittorrent") {
    let lastFailure = "no response";
    try {
      await waitFor("qBittorrent Web UI", async () => {
        try {
          const res = await fetch(`${qbitHostBase}/api/v2/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "username=admin&password=adminadmin",
          });
          const body = (await res.text()).trim();
          // qBittorrent 4.x answers "Ok."; 5.3 returns 204 with no body.
          if (res.ok && (body === "" || body.toLowerCase() === "ok.")) return true;
          lastFailure = `HTTP ${res.status}: ${body || "(empty body)"}`;
          return null;
        } catch (error) {
          lastFailure = String(error);
          return null;
        }
      });
    } catch (error) {
      throw new Error(`${(error as Error).message} Last login response: ${lastFailure}`);
    }
  } else {
    await waitFor("Transmission RPC", async () => {
      try {
        const res = await fetch(`${transmissionHostBase}/transmission/rpc`, {
          method: "POST",
          headers: { Authorization: `Basic ${btoa("remagnet:remagnet-test-pass")}` },
        });
        return res.status === 409 || res.ok ? true : null;
      } catch {
        return null;
      }
    });
  }
}

async function seedFixtureDirectly(
  kind: ClientKind,
  torrentBytes: Uint8Array,
  remagnetOwned: boolean,
) {
  if (kind === "qbittorrent") {
    const login = await fetch(`${qbitHostBase}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=admin&password=adminadmin",
    });
    assert.equal(login.ok, true);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const form = new FormData();
    const torrentBuffer = torrentBytes.buffer.slice(
      torrentBytes.byteOffset,
      torrentBytes.byteOffset + torrentBytes.byteLength,
    ) as ArrayBuffer;
    form.append("torrents", new Blob([torrentBuffer]), "fixture.torrent");
    form.append("savepath", "/downloads");
    form.append("skip_checking", "true");
    if (remagnetOwned) {
      form.append("category", "remagnet");
      form.append("tags", "remagnet");
    }

    const res = await fetch(`${qbitHostBase}/api/v2/torrents/add`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    assert.equal(res.ok, true, `qBittorrent direct seed failed: ${await res.text()}`);
    return;
  }

  // Transmission JSON-RPC direct seed.
  const authHeader = `Basic ${btoa("remagnet:remagnet-test-pass")}`;
  const handshake = await fetch(`${transmissionHostBase}/transmission/rpc`, {
    method: "POST",
    headers: { Authorization: authHeader },
  });
  const sessionId = handshake.headers.get("x-transmission-session-id") ?? "";
  assert.ok(sessionId, "Expected X-Transmission-Session-Id from Transmission");

  const metainfo = Buffer.from(torrentBytes).toString("base64");
  const args: Record<string, unknown> = {
    metainfo,
    "download-dir": "/downloads/complete",
    paused: false,
  };
  if (remagnetOwned) {
    args.labels = ["remagnet"];
  }

  const res = await fetch(`${transmissionHostBase}/transmission/rpc`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "X-Transmission-Session-Id": sessionId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method: "torrent-add", arguments: args }),
  });
  assert.equal(res.ok, true);
  const body = (await res.json()) as { result: string };
  assert.equal(body.result, "success");
}

async function claimAndDecryptPairing(id: string, code: string): Promise<string> {
  const secret = decodeBase64Url(code);
  const proof = encodeBase64Url(await sha256(secret));
  const claimed = await jsonFetch<{ iv: string; data: string }>(`${proxyBase}/api/pair/claim`, {
    method: "POST",
    body: JSON.stringify({ id, proof, deviceName: "Paired integration device" }),
  });
  assert.equal(claimed.status, 200);

  const context = new TextEncoder().encode("remagnet-pair-v1");
  const idBytes = new TextEncoder().encode(id);
  const material = new Uint8Array(context.length + idBytes.length + secret.length);
  material.set(context, 0);
  material.set(idBytes, context.length);
  material.set(secret, context.length + idBytes.length);

  const keyRaw = await sha256(material);
  const key = await crypto.subtle.importKey(
    "raw",
    keyRaw.buffer.slice(keyRaw.byteOffset, keyRaw.byteOffset + keyRaw.byteLength) as ArrayBuffer,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const iv = decodeBase64Url(claimed.body.iv);
  const ciphertext = decodeBase64Url(claimed.body.data);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer,
    },
    key,
    ciphertext.buffer.slice(
      ciphertext.byteOffset,
      ciphertext.byteOffset + ciphertext.byteLength,
    ) as ArrayBuffer,
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
    version: number;
    proxyToken: string;
  };
  assert.equal(payload.version, 2);
  return payload.proxyToken;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function extractSessionCookie(headers: Headers): string {
  const raw = headers.get("set-cookie") ?? "";
  const match = raw.match(/remagnet_session=[^;]+/);
  return match ? match[0] : "";
}

async function jsonFetch<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; body: T }> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  const body = (text ? JSON.parse(text) : undefined) as T;
  return { status: res.status, headers: res.headers, body };
}

async function waitFor<T>(label: string, check: () => Promise<T | null>, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== null) return result;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

function parseClientArg(): ClientKind {
  const index = process.argv.indexOf("--client");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === "qbittorrent" || value === "transmission") return value;
  throw new Error("Usage: bun run tests/integration/run.ts --client <qbittorrent|transmission>");
}

await main();
