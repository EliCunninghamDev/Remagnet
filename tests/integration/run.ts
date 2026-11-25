/**
 * End-to-end containerized regression test runner for Remagnet Proxy against
 * real torrent client containers (qBittorrent, Transmission, Deluge, or rTorrent).
 *
 * Usage: bun run tests/integration/run.ts --client <qbittorrent|transmission|deluge|rtorrent>
 */
import assert from "node:assert/strict";
import { CLIENTS, type ClientKind, INTEGRATION_FIXTURES, parseClientArg } from "./clients";
import {
  buildTorrentFixture,
  concatBytes,
  readStoredZip,
  sha256,
  toArrayBuffer,
  toHex,
} from "./fixture";

const USAGE =
  "Usage: bun run tests/integration/run.ts --client <qbittorrent|transmission|deluge|rtorrent>";

const client = parseClientArg(process.argv, USAGE);
const clientInfo = CLIENTS[client];

const proxyBase = process.env.PROXY_URL ?? "http://127.0.0.1:18081";
const qbitHostBase = process.env.QBIT_HOST_URL ?? CLIENTS.qbittorrent.hostBaseUrl;
const transmissionHostBase = process.env.TRANSMISSION_HOST_URL ?? CLIENTS.transmission.hostBaseUrl;
const delugeHostBase = process.env.DELUGE_HOST_URL ?? CLIENTS.deluge.hostBaseUrl;
const rtorrentHostBase = process.env.RTORRENT_HOST_URL ?? CLIENTS.rtorrent.hostBaseUrl;

const SETUP_CODE = "integration-setup-code";
const ADMIN_USER = "admin";
const ADMIN_PASS = "remagnet-integration-password-123";

const COMPLETE_EPSILON = 0.999999;
const PAIRING_CONTEXT = "remagnet-pair-v1";
const PAIRING_VERSION = 2;
const DEFAULT_WAIT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;

const ownedFixture = await buildTorrentFixture(
  INTEGRATION_FIXTURES.owned.name,
  INTEGRATION_FIXTURES.owned.seed,
);
const unrelatedFixture = await buildTorrentFixture(
  INTEGRATION_FIXTURES.unrelated.name,
  INTEGRATION_FIXTURES.unrelated.seed,
);
const magnetFixture = await buildTorrentFixture(
  INTEGRATION_FIXTURES.magnet.name,
  INTEGRATION_FIXTURES.magnet.seed,
);
const uploadFixture = await buildTorrentFixture(
  INTEGRATION_FIXTURES.upload.name,
  INTEGRATION_FIXTURES.upload.seed,
);

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
  const adminCookie = extractNamedCookie(setup.headers, "remagnet_session");
  assert.ok(adminCookie, "Expected remagnet_session cookie from setup");
  console.log("✓ Admin setup and SETUP_CODE enforcement verified");

  // 3. Configure the backend client via PUT /api/config and verify GET /api/health.
  const credentials =
    client === "qbittorrent"
      ? { username: "admin", password: "adminadmin" }
      : client === "transmission"
        ? { username: "remagnet", password: "remagnet-test-pass" }
        : client === "deluge"
          ? { password: "deluge" }
          : {};
  const configBody = {
    clientKind: client,
    baseUrl: clientInfo.containerBaseUrl,
    ...credentials,
    ...(client === "qbittorrent"
      ? {}
      : { downloadsDir: "/downloads", clientDownloadsDir: "/downloads" }),
    defaultCategory: clientInfo.defaultCategory,
    defaultTags: clientInfo.defaultTags,
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
      capabilities: {
        pauseOnAdd: boolean;
        archiveDownload: boolean;
        torrentFiles: boolean;
      };
    };
  });
  assert.equal(health.ok, true);
  assert.equal(health.apiVersion, 1);
  assert.equal(health.capabilities.pauseOnAdd, true);
  assert.equal(health.capabilities.archiveDownload, true);
  assert.equal(health.capabilities.torrentFiles, true);
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
    const entry = res.body.torrents.find((entry) => entry.hash === magnetFixture.infoHash);
    // Let clients such as Deluge and rTorrent settle into the paused state
    // after a `paused: true` add before asserting on it.
    return entry?.state === "stopped" ? entry : null;
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

  // 6b. Upload a paused `.torrent` file, verify its info hash, then delete it.
  const uploadBody = {
    files: [
      {
        filename: "remagnet-upload.torrent",
        data: Buffer.from(uploadFixture.torrentBytes).toString("base64"),
      },
    ],
    paused: true,
  };
  const uploaded = await jsonFetch<{ added: number; hashes: string[] }>(
    `${proxyBase}/api/torrents`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify(uploadBody),
    },
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.added, 1);
  assert.ok(
    uploaded.body.hashes.includes(uploadFixture.infoHash),
    "Uploaded .torrent hash must match its info hash",
  );

  const listedUpload = await waitFor("paused .torrent in GET /api/torrents", async () => {
    const res = await jsonFetch<{ torrents: Array<{ hash: string; state: string }> }>(
      `${proxyBase}/api/torrents`,
      { headers: { Authorization: `Bearer ${deviceToken}` } },
    );
    assert.equal(res.status, 200);
    const entry = res.body.torrents.find((entry) => entry.hash === uploadFixture.infoHash);
    // qBittorrent lists a fresh upload as "checking" for a moment before the
    // paused state settles, so presence alone does not prove `paused: true`.
    return entry?.state === "stopped" ? entry : null;
  });
  assert.equal(listedUpload.state, "stopped");

  const duplicateUpload = await jsonFetch(`${proxyBase}/api/torrents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify(uploadBody),
  });
  assert.equal(duplicateUpload.status, 400);

  const deletedUpload = await fetch(
    `${proxyBase}/api/torrents/${uploadFixture.infoHash}?deleteFiles=true`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${deviceToken}` },
    },
  );
  assert.equal(deletedUpload.status, 204);
  console.log("✓ Paused .torrent upload, duplicate rejection, list, and delete verified");

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
    return match && match.progress >= COMPLETE_EPSILON ? match : null;
  });

  // 8a. Bearer-authenticated archive stream.
  const bearerZipRes = await fetch(`${proxyBase}/archive/${ownedFixture.infoHash}`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(bearerZipRes.status, 200);
  await verifyZipPayload(bearerZipRes);

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
  await verifyZipPayload(ticketZipRes);

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

async function verifyZipPayload(response: Response) {
  const contentLength = response.headers.get("content-length");
  assert.ok(contentLength, "Expected a Content-Length header on the ZIP response");

  const zipBytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(Number(contentLength), zipBytes.byteLength);

  const entries = readStoredZip(zipBytes);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, ownedFixture.name);
  assert.equal(toHex(await sha256(entries[0].data)), ownedFixture.payloadSha256);
}

async function waitForBackendReady(kind: ClientKind) {
  switch (kind) {
    case "qbittorrent": {
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
      return;
    }
    case "transmission": {
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
      return;
    }
    case "deluge": {
      await waitFor("Deluge Web UI", async () => {
        try {
          const login = await delugeLogin();
          if (!login.result || !login.cookie) return null;
          await ensureDelugeConnected(login.cookie);
          const version = await delugeCall<string>(login.cookie, "daemon.get_version", []);
          return version ? true : null;
        } catch {
          return null;
        }
      });
      return;
    }
    case "rtorrent": {
      await waitFor("rTorrent XML-RPC", async () => {
        try {
          const res = await fetch(`${rtorrentHostBase}/RPC2`, {
            method: "POST",
            headers: { "Content-Type": "text/xml" },
            body: buildXmlRpcCall("system.client_version", []),
          });
          if (res.status !== 200) return null;
          const body = await res.text();
          return body.includes("<methodResponse>") ? true : null;
        } catch {
          return null;
        }
      });
      return;
    }
  }
}

async function seedFixtureDirectly(
  kind: ClientKind,
  torrentBytes: Uint8Array,
  remagnetOwned: boolean,
) {
  switch (kind) {
    case "qbittorrent": {
      const login = await fetch(`${qbitHostBase}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "username=admin&password=adminadmin",
      });
      assert.equal(login.ok, true);
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

      const form = new FormData();
      form.append("torrents", new Blob([toArrayBuffer(torrentBytes)]), "fixture.torrent");
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
    case "transmission": {
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
      return;
    }
    case "deluge": {
      const login = await delugeLogin();
      assert.equal(login.result, true, "Deluge rejected the integration password");
      assert.ok(login.cookie, "Expected _session_id cookie from Deluge");
      await ensureDelugeConnected(login.cookie);

      const base64 = Buffer.from(torrentBytes).toString("base64");
      const hash = await delugeCall<string>(login.cookie, "core.add_torrent_file", [
        "fixture.torrent",
        base64,
        { download_location: "/downloads", add_paused: false },
      ]);
      assert.ok(
        typeof hash === "string" && hash.length > 0,
        "Deluge did not return the added torrent hash",
      );

      if (remagnetOwned) {
        const enabled = await delugeCall<string[]>(login.cookie, "core.get_enabled_plugins", []);
        if (!enabled.includes("Label")) {
          await delugeCall(login.cookie, "core.enable_plugin", ["Label"]);
        }
        const labels = await delugeCall<string[]>(login.cookie, "label.get_labels", []);
        if (!labels.some((label) => label.toLowerCase() === "remagnet")) {
          await delugeCall(login.cookie, "label.add", ["remagnet"]);
        }
        await delugeCall(login.cookie, "label.set_torrent", [hash, "remagnet"]);
      }
      return;
    }
    case "rtorrent": {
      const base64 = Buffer.from(torrentBytes).toString("base64");
      const params = [
        "<string></string>",
        `<base64>${base64}</base64>`,
        "<string>d.directory.set=/downloads/complete</string>",
      ];
      if (remagnetOwned) {
        params.push("<string>d.custom1.set=remagnet</string>");
      }

      const res = await fetch(`${rtorrentHostBase}/RPC2`, {
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body: buildXmlRpcCall("load.raw_start", params),
      });
      assert.equal(res.ok, true, `rTorrent direct seed failed: ${await res.text()}`);
      return;
    }
  }
}

async function delugeLogin(): Promise<{ cookie: string; result: boolean }> {
  const res = await fetch(`${delugeHostBase}/json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, method: "auth.login", params: ["deluge"] }),
  });
  assert.equal(res.ok, true, `Deluge login failed: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: boolean };
  return {
    cookie: extractNamedCookie(res.headers, "_session_id"),
    result: body.result === true,
  };
}

async function delugeCall<T = unknown>(
  cookie: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(`${delugeHostBase}/json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ id: 1, method, params }),
  });
  const text = await res.text();
  assert.equal(res.ok, true, `Deluge ${method} failed: HTTP ${res.status}: ${text}`);
  const body = JSON.parse(text) as {
    result?: T;
    error?: { message?: string } | null;
  };
  if (body.error) {
    throw new Error(`Deluge ${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  return body.result as T;
}

async function ensureDelugeConnected(cookie: string) {
  const connected = await delugeCall<boolean>(cookie, "web.connected", []);
  if (connected) return;

  const hosts = await delugeCall<unknown[]>(cookie, "web.get_hosts", []);
  const host = Array.isArray(hosts)
    ? hosts.find((entry): entry is unknown[] => Array.isArray(entry))
    : undefined;
  const hostId = Array.isArray(host) && typeof host[0] === "string" ? host[0] : undefined;
  if (!hostId) {
    throw new Error("Deluge Web UI has no daemon host to connect to");
  }

  await delugeCall(cookie, "web.connect", [hostId]);
  for (let attempt = 0; attempt < 15; attempt++) {
    if (await delugeCall<boolean>(cookie, "web.connected", [])) return;
    await Bun.sleep(100);
  }
  throw new Error("Deluge Web UI did not connect to its daemon");
}

function buildXmlRpcCall(method: string, params: string[]): string {
  const encodedParams = params.map((value) => `<param><value>${value}</value></param>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${encodedParams}</params></methodCall>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function claimAndDecryptPairing(id: string, code: string): Promise<string> {
  const secret = decodeBase64Url(code);
  const proof = encodeBase64Url(await sha256(secret));
  const claimed = await jsonFetch<{ iv: string; data: string }>(`${proxyBase}/api/pair/claim`, {
    method: "POST",
    body: JSON.stringify({ id, proof, deviceName: "Paired integration device" }),
  });
  assert.equal(claimed.status, 200);

  const encoder = new TextEncoder();
  const material = concatBytes([encoder.encode(PAIRING_CONTEXT), encoder.encode(id), secret]);

  const keyRaw = await sha256(material);
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(keyRaw), "AES-GCM", false, [
    "decrypt",
  ]);
  const iv = decodeBase64Url(claimed.body.iv);
  const ciphertext = decodeBase64Url(claimed.body.data);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext),
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
    version: number;
    proxyToken: string;
  };
  assert.equal(payload.version, PAIRING_VERSION);
  return payload.proxyToken;
}

function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function extractNamedCookie(headers: Headers, name: string): string {
  const raw = headers.get("set-cookie") ?? "";
  const match = raw.match(new RegExp(`${name}=([^;,\\s]+)`));
  return match ? `${name}=${match[1]}` : "";
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

async function waitFor<T>(
  label: string,
  check: () => Promise<T | null>,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== null) return result;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

await main();
