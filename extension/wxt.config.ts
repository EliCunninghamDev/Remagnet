import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserManifest } from "wxt";

// web-ext treats `--firefox-profile` as a profile *name* until the directory
// exists, so create it before the runner starts. Reusing one profile in dev
// keeps granted host access and extension settings across restarts.
const firefoxProfile = fileURLToPath(new URL(".dev/firefox-profile", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(firefoxProfile, { recursive: true });

export default defineConfig({
  modules: ["@wxt-dev/module-solid"],
  webExt: {
    firefoxProfile,
    keepProfileChanges: true,
  },
  // Bundle the full workspace subset required to run
  // `bun install --frozen-lockfile && bun run build:firefox` for AMO source
  // review, while keeping unrelated subprojects (android, proxy, demo, site)
  // and build/dev caches out of the archive.
  zip: {
    name: "remagnet",
    sourcesRoot: repoRoot,
    includeSources: [
      "package.json",
      "bun.lock",
      "bunfig.toml",
      "tsconfig.base.json",
      "tokens.js",
      "tokens.d.ts",
      "LICENSE",
      "PRIVACY.md",
      "README.md",
      "extension/**",
      "packages/**",
    ],
    excludeSources: [
      "**/node_modules/**",
      "extension/.dev/**",
      "extension/.output/**",
      "extension/.wxt/**",
      "packages/*/dist/**",
    ],
  },
  hooks: {
    // The gallery is a development aid; keep it out of packaged builds unless
    // explicitly requested with REMAGNET_GALLERY=1. The link context-menu
    // content script is Chrome-only; Firefox uses the `magnet:` protocol
    // handler and should neither declare nor bundle an all-sites script.
    "entrypoints:resolved": (wxt, entrypoints) => {
      const skipGallery = wxt.config.command === "build" && process.env.REMAGNET_GALLERY !== "1";
      const skipContextLink = wxt.config.browser === "firefox";

      for (const entrypoint of entrypoints) {
        if (skipGallery && entrypoint.name === "gallery") entrypoint.skipped = true;
        if (skipContextLink && entrypoint.name === "context-link") entrypoint.skipped = true;
      }
    },
  },
  manifest: ({ manifestVersion, browser }) =>
    ({
      name: "Remagnet",
      description:
        "Forward magnet links to your self-hosted Remagnet Proxy and stream completed torrents as ZIP archives.",
      homepage_url: "https://remagnet.app",
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
        : {
            optional_host_permissions: ["*://*/*"],
            // Programmatic `chrome.action.openPopup()` from context menu clicks
            // requires Chrome 127+.
            minimum_chrome_version: "127",
          }),
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
                // Permanent AMO add-on ID tied to remagnet.app.
                id: "extension@remagnet.app",
                // 142.0+ supports `data_collection_permissions` across both
                // Firefox Desktop and Firefox for Android (silencing web-ext
                // lint's Android min-version warning).
                strict_min_version: "142.0",
                data_collection_permissions: {
                  required: ["none"],
                },
              },
            },
          }
        : {}),
    }) as UserManifest,
});
