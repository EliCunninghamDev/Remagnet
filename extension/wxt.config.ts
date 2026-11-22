import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserManifest } from "wxt";

// web-ext treats `--firefox-profile` as a profile *name* until the directory
// exists, so create it before the runner starts. Reusing one profile in dev
// keeps granted host access and extension settings across restarts.
const firefoxProfile = fileURLToPath(new URL(".dev/firefox-profile", import.meta.url));
mkdirSync(firefoxProfile, { recursive: true });

export default defineConfig({
  modules: ["@wxt-dev/module-solid"],
  webExt: {
    firefoxProfile,
    keepProfileChanges: true,
  },
  hooks: {
    // The gallery is a development aid. Keep it out of packaged builds unless
    // explicitly requested with REMAGNET_GALLERY=1 (useful for design review
    // against an installed build).
    "entrypoints:resolved": (wxt, entrypoints) => {
      if (wxt.config.command !== "build" || process.env.REMAGNET_GALLERY === "1") return;
      for (const entrypoint of entrypoints) {
        if (entrypoint.name === "gallery") entrypoint.skipped = true;
      }
    },
    // The link context menu is Chrome-only; Firefox has a `magnet:` protocol
    // handler and should not ask for access to every page just to filter it.
    "build:manifestGenerated": (_wxt, manifest) => {
      if (manifest.manifest_version === 2) delete manifest.content_scripts;
    },
  },
  manifest: ({ manifestVersion, browser }) =>
    ({
      name: "Remagnet",
      description: "Re-add magnet links to qBittorrent.",
      permissions: [
        "storage",
        "downloads",
        "alarms",
        "notifications",
        // Chrome's stand-in for Firefox's magnet: protocol handler.
        ...(manifestVersion === 3 ? ["contextMenus"] : []),
      ],
      // MV2 (Firefox) calls optional origins `optional_permissions`; MV3
      // (Chrome) requires `optional_host_permissions`. Declare a wildcard so any
      // configured Web UI origin can be requested at runtime; the actual request
      // is narrowed to the origin from settings. Firefox drops `<all_urls>` from
      // optional permissions, so use `*://*/*` explicitly.
      ...(manifestVersion === 2
        ? { optional_permissions: ["*://*/*"] }
        : { optional_host_permissions: ["*://*/*"] }),
      ...(browser === "firefox"
        ? {
            // Firefox can register the extension itself as the magnet handler.
            // The add page reads the percent-encoded magnet from the URL hash.
            protocol_handlers: [
              {
                protocol: "magnet",
                name: "Remagnet",
                uriTemplate: "/add.html#%s",
              },
            ],
            browser_specific_settings: {
              gecko: {
                // Stable ID keeps the moz-extension:// UUID and extension storage
                // consistent across dev reloads.
                id: "remagnet@localhost",
                strict_min_version: "140.0",
              },
            },
          }
        : {}),
    }) as UserManifest,
});
