#!/usr/bin/env bun
/**
 * Tiny stand-in for the Remagnet Proxy API.
 *
 * The demo records the real Remagnet extension, which only talks to the proxy.
 * This server keeps everything in memory, accepts the demo device token, and
 * implements the endpoints the extension uses: health, torrent list/lookup/add/
 * remove, single-use archive tickets and the completed-torrent ZIP route. It
 * never contacts qBittorrent, so the recording needs no network access, no
 * torrent client and no real torrent.
 */

const PORT = Number(process.env.MOCK_PROXY_PORT ?? 8099);
const TOKEN = process.env.MOCK_PROXY_TOKEN ?? "remagnet-demo-token";
const CATEGORY = "remagnet";
const TAGS = ["remagnet"];
const TICKET_TTL_MS = 60_000;

const tickets = new Map<string, { hash: string; expiresAt: number }>();

interface MockTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  downloadSpeed: number;
  uploadSpeed: number;
  eta: number;
  ratio: number;
  category: string;
  tags: string[];
  seeds: number;
  peers: number;
  addedAt: number;
}

const torrents = new Map<string, MockTorrent>();

function seed(torrent: Omit<MockTorrent, "addedAt">, ageMs: number) {
  torrents.set(torrent.hash, { ...torrent, addedAt: Date.now() - ageMs });
}

/** Seed the list with a completed ISO and a stalled one. */
seed(
  {
    hash: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
    name: "nebula-4.1-amd64-netinst.iso",
    state: "seeding",
    progress: 1,
    size: 1_087_795_200,
    downloadSpeed: 0,
    uploadSpeed: 2_400_000,
    eta: 86_400,
    ratio: 1.42,
    category: CATEGORY,
    tags: [...TAGS],
    seeds: 0,
    peers: 3,
  },
  86_400_000,
);

seed(
  {
    hash: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    name: "alpine-standard-3.22.0-x86_64.iso",
    state: "stalled",
    progress: 0.34,
    size: 193_986_560,
    downloadSpeed: 0,
    uploadSpeed: 0,
    eta: 86_400,
    ratio: 0,
    category: CATEGORY,
    tags: [...TAGS],
    seeds: 6,
    peers: 2,
  },
  7_200_000,
);

function parseMagnet(uri: string): { hash: string; name: string; size: number } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const hash = (url.searchParams.get("xt") ?? "").replace(/^urn:btih:/i, "").toLowerCase();
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) return null;
  const size = Number(url.searchParams.get("xl") ?? 0);
  return {
    hash,
    name: url.searchParams.get("dn")?.trim() || `${hash.slice(0, 12)}.torrent`,
    size: Number.isFinite(size) ? size : 0,
  };
}

function summary(torrent: MockTorrent) {
  return {
    hash: torrent.hash,
    name: torrent.name,
    state: torrent.state,
    progress: torrent.progress,
    size: torrent.size,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    eta: torrent.eta,
    ratio: torrent.ratio,
    category: torrent.category,
    tags: torrent.tags,
    seeds: torrent.seeds,
    peers: torrent.peers,
  };
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

/** Only the bearer device token authenticates the API routes. */
const authorized = (request: Request): boolean => {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase() === `bearer ${TOKEN}`.toLowerCase();
};

/** Consume a single-use ticket bound to one info hash. */
function claimTicket(value: string | null, hash: string): boolean {
  if (!value) return false;
  const ticket = tickets.get(value);
  if (!ticket) return false;
  tickets.delete(value);
  return ticket.hash === hash && ticket.expiresAt > Date.now();
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (pathname === "/healthz") {
      return json({
        ok: true,
        service: "remagnet-proxy",
        version: "0.1.0",
        apiVersion: 1,
      });
    }

    // Mint a single-use ticket so the Chrome download URL never carries the
    // long-lived device token.
    const ticketPath = pathname.match(/^\/api\/archive\/([^/]+)\/ticket$/);
    if (ticketPath && request.method === "POST") {
      if (!authorized(request)) {
        return json({ error: "Missing or invalid device token." }, 401);
      }
      const hash = decodeURIComponent(ticketPath[1]).toLowerCase();
      if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
        return json({ error: "Expected a 40 or 64 character hex info hash." }, 400);
      }
      const now = Date.now();
      for (const [value, ticket] of tickets) {
        if (ticket.expiresAt <= now) tickets.delete(value);
      }
      const ticket = crypto.randomUUID().replace(/-/g, "");
      tickets.set(ticket, { hash, expiresAt: now + TICKET_TTL_MS });
      return json({ ticket, expiresIn: 60 });
    }

    // The proxy's ZIP endpoint. The extension checks completion before calling
    // it, but keep the guard so a bad click cannot download a partial torrent.
    // Accept either the bearer device token (Firefox) or a single-use ticket
    // (Chrome); the body is a minimal empty ZIP because only the download
    // itself is on camera.
    const archivePath = pathname.match(/^\/archive\/([^/]+)$/);
    if (archivePath && request.method === "GET") {
      const hash = decodeURIComponent(archivePath[1]).toLowerCase();
      const hasTicket = claimTicket(url.searchParams.get("ticket"), hash);
      if (!hasTicket && !authorized(request)) {
        return json({ error: "Authentication required." }, 401);
      }
      const torrent = torrents.get(hash);
      if (!torrent) return json({ error: "Torrent not found in qBittorrent." }, 404);
      if (torrent.progress < 1) {
        return json({ error: `${torrent.name} is not complete yet.` }, 409);
      }

      return new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]), {
        headers: {
          ...cors,
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${torrent.name}.zip"`,
          "cache-control": "no-store",
        },
      });
    }

    if (!authorized(request)) {
      return json({ error: "Missing or invalid device token." }, 401);
    }

    if (pathname === "/api/devices/current" && request.method === "DELETE") {
      // The demo has no persisted device records; acknowledge the best-effort
      // disconnect call the extension makes before clearing its token.
      return new Response(null, { status: 204, headers: cors });
    }

    if (pathname === "/api/health") {
      return json({
        ok: true,
        clientLabel: "qBittorrent",
        appVersion: "5.3.0",
        webApiVersion: "2.16.2",
        apiVersion: 1,
        proxyVersion: "0.1.0",
        capabilities: { pauseOnAdd: true },
        defaultCategory: CATEGORY,
        defaultTags: TAGS,
      });
    }

    if (pathname === "/api/torrents" && request.method === "GET") {
      const list = [...torrents.values()].sort((a, b) => b.addedAt - a.addedAt).map(summary);
      return json({ torrents: list });
    }

    if (pathname === "/api/torrents" && request.method === "POST") {
      let payload: { urls?: unknown };
      try {
        payload = (await request.json()) as typeof payload;
      } catch {
        return json({ error: "Send a JSON body with a urls array." }, 400);
      }

      const urls = Array.isArray(payload.urls)
        ? payload.urls.filter((url): url is string => typeof url === "string")
        : [];
      if (urls.length === 0) {
        return json({ error: "No magnet or torrent URL was supplied." }, 400);
      }

      const hashes: string[] = [];
      for (const uri of urls) {
        const magnet = parseMagnet(uri);
        if (!magnet) continue;
        hashes.push(magnet.hash);
        torrents.set(magnet.hash, {
          hash: magnet.hash,
          name: magnet.name,
          state: "downloading",
          progress: 0.03,
          size: magnet.size || 1_140_000_000,
          downloadSpeed: 18_400_000,
          uploadSpeed: 420_000,
          eta: 64,
          ratio: 0,
          category: CATEGORY,
          tags: [...TAGS],
          seeds: 42,
          peers: 7,
          addedAt: Date.now(),
        });
      }

      return json({ added: urls.length, hashes, category: CATEGORY, tags: TAGS });
    }

    const torrentPath = pathname.match(/^\/api\/torrents\/([^/]+)$/);
    if (torrentPath) {
      const hash = decodeURIComponent(torrentPath[1]).toLowerCase();
      const torrent = torrents.get(hash);
      if (!torrent) return json({ error: "Torrent not found." }, 404);

      if (request.method === "GET") return json(summary(torrent));

      if (request.method === "DELETE") {
        torrents.delete(hash);
        return new Response(null, { status: 204, headers: cors });
      }
    }

    return json({ error: "Not found." }, 404);
  },
});

/** Nudge the added torrent forward so the progress bars visibly fill in the clip. */
setInterval(() => {
  for (const torrent of torrents.values()) {
    if (torrent.progress >= 1 || torrent.state === "stalled") continue;
    torrent.progress = Math.min(1, torrent.progress + 0.08);
    torrent.downloadSpeed = 18_400_000 + Math.round(Math.random() * 3_000_000);
    const remaining = (1 - torrent.progress) * torrent.size;
    torrent.eta = Math.max(1, Math.ceil(remaining / torrent.downloadSpeed));
    if (torrent.progress >= 1) {
      torrent.state = "seeding";
      torrent.progress = 1;
      torrent.downloadSpeed = 0;
      torrent.eta = 86_400;
    }
  }
}, 300);

console.log(`mock Remagnet Proxy: http://127.0.0.1:${PORT} (device token ${TOKEN})`);
