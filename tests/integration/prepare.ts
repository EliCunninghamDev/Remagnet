/**
 * Prepare local directories and offline payload fixtures before booting a
 * containerized integration test stack.
 *
 * Usage: bun run tests/integration/prepare.ts --client <qbittorrent|transmission>
 */
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildTorrentFixture } from "./fixture";

const client = parseClientArg();
const root = resolve(import.meta.dir);
const tmpRoot = join(root, "tmp", client);
const configDir = join(tmpRoot, "config");
const downloadsDir = join(tmpRoot, "downloads");
const proxyDataDir = join(tmpRoot, "proxy-data");

await rm(tmpRoot, { recursive: true, force: true });
await mkdir(configDir, { recursive: true });
await mkdir(downloadsDir, { recursive: true });
await mkdir(proxyDataDir, { recursive: true });

if (client === "qbittorrent") {
  const qbitConfigDir = join(configDir, "qBittorrent");
  await mkdir(qbitConfigDir, { recursive: true });
  await cp(
    join(root, "qbittorrent-config/qBittorrent.conf"),
    join(qbitConfigDir, "qBittorrent.conf"),
  );
} else {
  await mkdir(join(downloadsDir, "complete"), { recursive: true });
}

const ownedFixture = await buildTorrentFixture("remagnet-fixture.bin", "remagnet-owned");
const unrelatedFixture = await buildTorrentFixture("unrelated-fixture.bin", "remagnet-unrelated");

const targetDownloadsDir =
  client === "transmission" ? join(downloadsDir, "complete") : downloadsDir;
await writeFile(join(targetDownloadsDir, ownedFixture.name), ownedFixture.payloadBytes);
await writeFile(join(targetDownloadsDir, unrelatedFixture.name), unrelatedFixture.payloadBytes);

// The proxy container runs as non-root UID 10001; make mounted dirs writable/readable.
await chmod(proxyDataDir, 0o777);
await chmod(downloadsDir, 0o777);
if (client === "transmission") {
  await chmod(targetDownloadsDir, 0o777);
}

console.log(
  `Prepared ${client} integration directories in ${tmpRoot} (owned=${ownedFixture.infoHash}, unrelated=${unrelatedFixture.infoHash})`,
);

function parseClientArg(): "qbittorrent" | "transmission" {
  const index = process.argv.indexOf("--client");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === "qbittorrent" || value === "transmission") return value;
  throw new Error(
    "Usage: bun run tests/integration/prepare.ts --client <qbittorrent|transmission>",
  );
}
