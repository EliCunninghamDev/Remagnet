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

// Seed the public settings and the encrypted archive token before the bundled
// worker starts. The mock accepts any login, but the token has to survive the
// normal encrypted-secrets path for the ZIP action to appear. The key is
// non-extractable and lives in the extension's IndexedDB, just as it would
// after saving the options page.
const archiveToken = "remagnet-demo-token";
const settings = {
  client: "qbittorrent",
  baseUrl,
  authMode: "password",
  username: "demo",
  defaultCategory: "remagnet",
  defaultTags: "remagnet",
  // Point the archive bridge at the same mock server. The token only has to
  // satisfy validation; the mock ignores credentials.
  archiveBaseUrl: baseUrl,
};
const backgroundPath = resolve(target, "background.js");
const background = await readFile(backgroundPath, "utf8");
const seed = `(async () => {
  try {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("remagnet-credentials", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("keys")) {
          request.result.createObjectStore("keys");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const readKey = () => new Promise((resolve, reject) => {
      const request = db.transaction("keys", "readonly").objectStore("keys").get("settings");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let key = await readKey();
    if (!key) {
      key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await new Promise((resolve, reject) => {
        const request = db.transaction("keys", "readwrite").objectStore("keys").put(key, "settings");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
    db.close();

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify({
      apiKey: "",
      password: "",
      archiveToken: ${JSON.stringify(archiveToken)},
    }));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const base64 = (bytes) => btoa(String.fromCharCode(...bytes));
    await chrome.storage.local.set({
      settings: ${JSON.stringify(settings)},
      secrets: { version: 1, iv: base64(iv), data: base64(new Uint8Array(ciphertext)) },
    });
  } catch (error) {
    console.warn("demo seed failed", error);
  }

  // Chrome's download bubble would cover the popover and leave a generated
  // file on the host. Fulfil archive requests in the worker instead, so the
  // ZIP action still runs its real code path but the recording stays clean.
  const patchDownloads = (downloads) => {
    if (!downloads?.download) return;
    const realDownload = downloads.download.bind(downloads);
    downloads.download = (options) => {
      const url = typeof options?.url === "string" ? options.url : "";
      if (url.includes("/archive/")) {
        const headers = Array.isArray(options.headers)
          ? Object.fromEntries(options.headers.map(({ name, value }) => [name, value]))
          : undefined;
        void fetch(url, { headers }).then(
          (response) => response.arrayBuffer(),
          (error) => console.warn("demo archive request failed", error),
        );
        // Hold the row in its Zipping state long enough to read on camera.
        return new Promise((resolve) => setTimeout(() => resolve(1), 700));
      }
      return realDownload(options);
    };
  };
  patchDownloads(chrome.downloads);
  if (globalThis.browser && globalThis.browser !== chrome) {
    patchDownloads(globalThis.browser.downloads);
  }

  ${background}
})();
`;
await writeFile(backgroundPath, seed);

console.log(`prepared ${target}`);
console.log(`  client: ${baseUrl}`);
