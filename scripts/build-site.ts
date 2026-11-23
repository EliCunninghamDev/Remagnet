/**
 * Assemble the static landing site into `site/dist/` without duplicating
 * fonts, icons, demo media, or `proxy/openapi.yaml` in git.
 *
 * Run from the repository root with `bun run site:build`.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const srcDir = join(root, "site");
const distDir = join(srcDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(join(distDir, "assets/fonts"), { recursive: true });
await mkdir(join(distDir, "assets/icon"), { recursive: true });

for (const page of ["index.html", "privacy.html", "api.html", "styles.css"]) {
  await cp(join(srcDir, page), join(distDir, page));
}

const fonts = [
  "departure-mono-regular.woff2",
  "geist-mono-latin-400-normal.woff2",
  "geist-mono-latin-500-normal.woff2",
  "geist-mono-latin-600-normal.woff2",
];
for (const font of fonts) {
  await cp(join(root, "extension/public/fonts", font), join(distDir, "assets/fonts", font));
}

for (const icon of ["remagnet.svg", "remagnet-small.svg"]) {
  await cp(join(root, "extension/public/icon", icon), join(distDir, "assets/icon", icon));
}

for (const media of ["remagnet-demo.gif", "remagnet-demo.mp4"]) {
  await cp(join(root, "docs", media), join(distDir, "assets", media));
}

await cp(join(root, "proxy/openapi.yaml"), join(distDir, "openapi.yaml"));

console.log(`Built static site into ${distDir}`);
