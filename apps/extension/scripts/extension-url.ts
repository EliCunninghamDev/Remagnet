/**
 * Print direct URLs for the development extension's popup, add and options
 * pages.
 *
 * Firefox maps each extension ID to a random `moz-extension://<uuid>` origin
 * and stores the mapping in the profile's prefs.js. Reusing a profile keeps the
 * UUID stable, so this is a reliable shortcut for opening the pages in a tab
 * (which is much easier to automate than clicking the toolbar button).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "remagnet@localhost";
const prefsPath = fileURLToPath(new URL("../.dev/firefox-profile/prefs.js", import.meta.url));

if (!existsSync(prefsPath)) {
  console.error(`No dev profile found at ${prefsPath}.`);
  console.error("Run `bun run dev:firefox` once so Firefox creates it.");
  process.exit(1);
}

const prefs = readFileSync(prefsPath, "utf8");
const match = prefs.match(/user_pref\("extensions\.webextensions\.uuids",\s*"((?:[^"\\]|\\.)*)"\)/);

if (!match?.[1]) {
  console.error("Could not read extensions.webextensions.uuids from prefs.js.");
  console.error("Start Firefox with `bun run dev:firefox`, then try again.");
  process.exit(1);
}

// The pref value is a JS string literal that contains JSON.
const uuids = JSON.parse(JSON.parse(`"${match[1]}"`)) as Record<string, string>;
const uuid = uuids[EXTENSION_ID];

if (!uuid) {
  console.error(`Extension ${EXTENSION_ID} is not in the dev profile.`);
  console.error("Start Firefox with `bun run dev:firefox`, then try again.");
  process.exit(1);
}

const base = `moz-extension://${uuid}`;
console.log(`popup    ${base}/popup.html`);
console.log(`add      ${base}/add.html`);
console.log(`options  ${base}/options.html`);
