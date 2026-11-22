#!/usr/bin/env bun
/**
 * Tiny stand-in for the qBittorrent Web API v2.
 *
 * The demo records the real Remagnet extension, so it needs a client to talk
 * to. This server keeps everything in memory, ignores authentication, and
 * reports one torrent that gets added and slowly progresses. It also answers the
 * archive bridge's ZIP route with a tiny generated file, so the completed
 * torrent's download button works without the real proxy. No network access
 * and no real torrent is touched.
 */

const PORT = Number(process.env.MOCK_QBIT_PORT ?? 8099);
const TRACKER = "http://bttracker.example.org:6969/announce";

interface MockTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  ratio: number;
  category: string;
  tags: string;
  num_seeds: number;
  num_leechs: number;
  added_on: number;
}

const torrents = new Map<string, MockTorrent>();

/** Seed the list with a completed ISO and a stalled one. */
torrents.set("c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00", {
  hash: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
  name: "nebula-4.1-amd64-netinst.iso",
  state: "uploading",
  progress: 1,
  size: 1_087_795_200,
  dlspeed: 0,
  upspeed: 2_400_000,
  eta: 86_400,
  ratio: 1.42,
  category: "remagnet",
  tags: "remagnet",
  num_seeds: 0,
  num_leechs: 3,
  added_on: Math.floor(Date.now() / 1000) - 86_400,
});

torrents.set("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", {
  hash: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  name: "alpine-standard-3.22.0-x86_64.iso",
  state: "stalledDL",
  progress: 0.34,
  size: 193_986_560,
  dlspeed: 0,
  upspeed: 0,
  eta: 86_400,
  ratio: 0,
  category: "remagnet",
  tags: "remagnet",
  num_seeds: 6,
  num_leechs: 2,
  added_on: Math.floor(Date.now() / 1000) - 7_200,
});

function parseMagnet(uri: string): { hash: string; name: string; size: number } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const hash = (url.searchParams.get("xt") ?? "").replace(/^urn:btih:/i, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return null;
  const size = Number(url.searchParams.get("xl") ?? 0);
  return {
    hash,
    name: url.searchParams.get("dn")?.trim() || `${hash.slice(0, 12)}.torrent`,
    size: Number.isFinite(size) ? size : 0,
  };
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

const text = (value: string) =>
  new Response(value, {
    headers: { "content-type": "text/plain", "access-control-allow-origin": "*" },
  });

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        },
      });
    }

    if (pathname === "/api/v2/app/version") return text("v5.3.0");
    if (pathname === "/api/v2/app/webapiVersion") return text("2.16.2");
    if (pathname === "/api/v2/auth/login") return text("Ok.");

    if (pathname === "/api/v2/torrents/info") {
      const hashes = (searchParams.get("hashes") ?? "")
        .split("|")
        .map((hash) => hash.trim().toLowerCase())
        .filter(Boolean);
      let list = [...torrents.values()];
      if (hashes.length > 0) list = list.filter((torrent) => hashes.includes(torrent.hash));
      list.sort((a, b) => b.added_on - a.added_on);
      return json(list);
    }

    if (pathname === "/api/v2/torrents/categories") {
      return json({ remagnet: { name: "remagnet", savePath: "" } });
    }

    if (pathname === "/api/v2/torrents/tags") return json(["remagnet"]);

    if (
      pathname === "/api/v2/torrents/createCategory" ||
      pathname === "/api/v2/torrents/createTags"
    ) {
      return text("");
    }

    if (pathname === "/api/v2/torrents/add") {
      const body = await request.text();
      const form = new URLSearchParams(body);
      const urls = (form.get("urls") ?? "").split("\n").filter(Boolean);
      const category = form.get("category") ?? "remagnet";
      const tags = form.get("tags") ?? "remagnet";

      for (const uri of urls) {
        const magnet = parseMagnet(uri);
        if (!magnet) continue;
        torrents.set(magnet.hash, {
          hash: magnet.hash,
          name: magnet.name,
          state: "downloading",
          progress: 0.03,
          size: magnet.size || 1_140_000_000,
          dlspeed: 18_400_000,
          upspeed: 420_000,
          eta: 64,
          ratio: 0,
          category,
          tags,
          num_seeds: 42,
          num_leechs: 7,
          added_on: Math.floor(Date.now() / 1000),
        });
      }

      return text("Ok.");
    }

    if (pathname === "/api/v2/torrents/delete") {
      const body = new URLSearchParams(await request.text());
      for (const hash of (body.get("hashes") ?? "").split("|")) torrents.delete(hash);
      return text("");
    }

    // The archive bridge's ZIP endpoint. The extension checks completion before
    // calling this, but keep the guard so a bad click cannot download a partial
    // torrent. The body is a minimal empty ZIP; only the download itself is on
    // camera.
    if (pathname.startsWith("/archive/")) {
      const hash = decodeURIComponent(pathname.slice("/archive/".length));
      const torrent = torrents.get(hash.toLowerCase());
      if (!torrent || torrent.progress < 1) {
        return new Response("torrent is not complete", { status: 409 });
      }

      return new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]), {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${torrent.name}.zip"`,
          "access-control-allow-origin": "*",
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

/** Nudge the added torrent forward so the progress bars visibly fill in the clip. */
setInterval(() => {
  for (const torrent of torrents.values()) {
    if (torrent.progress >= 1 || torrent.state === "stalledDL") continue;
    torrent.progress = Math.min(1, torrent.progress + 0.05);
    torrent.dlspeed = 18_400_000 + Math.round(Math.random() * 3_000_000);
    const remaining = (1 - torrent.progress) * torrent.size;
    torrent.eta = Math.max(1, Math.ceil(remaining / torrent.dlspeed));
    if (torrent.progress >= 1) {
      torrent.state = "uploading";
      torrent.progress = 1;
      torrent.dlspeed = 0;
      torrent.eta = 86_400;
    }
  }
}, 300);

console.log(`mock qBittorrent: http://127.0.0.1:${PORT} (${TRACKER})`);
