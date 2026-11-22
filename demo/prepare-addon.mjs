#!/usr/bin/env bun
/**
 * Turn the normal Chrome build into a demo addon.
 *
 * The only differences from a shipped build are a host permission for the
 * local mock client and a seeded settings object, so the recording never shows
 * a real server URL or asks the viewer to configure anything.
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const source = resolve(root, "extension/.output/chrome-mv3");
const target = resolve(here, ".build/addon");

const port = Number(process.env.MOCK_QBIT_PORT ?? 8099);
const baseUrl = `http://127.0.0.1:${port}`;

await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });

const manifestPath = resolve(target, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.host_permissions = [`${baseUrl}/*`];
delete manifest.optional_host_permissions;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// `chrome.storage.local.set` runs before the bundled worker code. Playwright
// waits for the worker to start, so settings are in place before the first
// popup opens.
const settings = {
  client: "qbittorrent",
  baseUrl,
  authMode: "apiKey",
  apiKey: "demo",
  username: "admin",
  password: "",
  defaultCategory: "remagnet",
  defaultTags: "remagnet",
  archiveBaseUrl: "",
  archiveToken: "",
};
const backgroundPath = resolve(target, "background.js");
const background = await readFile(backgroundPath, "utf8");
const seed = `chrome.storage.local.set({ settings: ${JSON.stringify(settings)} });\n`;
await writeFile(backgroundPath, seed + background);

console.log(`prepared ${target}`);
console.log(`  client: ${baseUrl}`);
