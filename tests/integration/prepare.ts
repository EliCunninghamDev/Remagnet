/**
 * Prepare local directories and offline payload fixtures before booting a
 * containerized integration test stack.
 *
 * Usage: bun run tests/integration/prepare.ts --client <qbittorrent|transmission|deluge|rtorrent>
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CLIENTS, ensureQbitConfig, INTEGRATION_FIXTURES, parseClientArg } from "./clients";
import { buildTorrentFixture } from "./fixture";

const WORLD_RWX = 0o777;
const USAGE =
  "Usage: bun run tests/integration/prepare.ts --client <qbittorrent|transmission|deluge|rtorrent>";

const client = parseClientArg(process.argv, USAGE);
const root = resolve(import.meta.dir);
const tmpRoot = join(root, "tmp", client);
const configDir = join(tmpRoot, "config");
const downloadsDir = join(tmpRoot, "downloads");
const proxyDataDir = join(tmpRoot, "proxy-data");
const usesCompleteDir = CLIENTS[client].usesCompleteDir;

await rm(tmpRoot, { recursive: true, force: true });
await mkdir(configDir, { recursive: true });
await mkdir(downloadsDir, { recursive: true });
await mkdir(proxyDataDir, { recursive: true });

const targetDownloadsDir = usesCompleteDir ? join(downloadsDir, "complete") : downloadsDir;

if (client === "qbittorrent") {
  await ensureQbitConfig(configDir, join(root, "qbittorrent-config/qBittorrent.conf"));
} else if (usesCompleteDir) {
  await mkdir(targetDownloadsDir, { recursive: true });
}

const ownedFixture = await buildTorrentFixture(
  INTEGRATION_FIXTURES.owned.name,
  INTEGRATION_FIXTURES.owned.seed,
);
const unrelatedFixture = await buildTorrentFixture(
  INTEGRATION_FIXTURES.unrelated.name,
  INTEGRATION_FIXTURES.unrelated.seed,
);

await writeFile(join(targetDownloadsDir, ownedFixture.name), ownedFixture.payloadBytes);
await writeFile(join(targetDownloadsDir, unrelatedFixture.name), unrelatedFixture.payloadBytes);

// The proxy container runs as non-root UID 10001; make mounted dirs writable/readable.
await chmod(proxyDataDir, WORLD_RWX);
await chmod(downloadsDir, WORLD_RWX);
if (usesCompleteDir) {
  await chmod(targetDownloadsDir, WORLD_RWX);
}
if (client === "rtorrent") {
  // crazymax/rtorrent-rutorrent writes its configuration under /data.
  await chmod(configDir, WORLD_RWX);
}

console.log(
  `Prepared ${client} integration directories in ${tmpRoot} (owned=${ownedFixture.infoHash}, unrelated=${unrelatedFixture.infoHash})`,
);
