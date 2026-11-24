import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import solid from "vite-plugin-solid";

const packageDir = fileURLToPath(new URL(".", import.meta.url));
const proxyTarget = "http://127.0.0.1:8080";

/**
 * The HTML entry is named `ui.html` and the output directory is the proxy
 * crate, so Vite writes `proxy/src/ui.html` directly. `emptyOutDir` stays off
 * because that directory also holds the Rust sources and static assets.
 */
export default defineConfig({
  plugins: [solid(), viteSingleFile()],
  build: {
    outDir: fileURLToPath(new URL("../../proxy/src", import.meta.url)),
    emptyOutDir: false,
    rollupOptions: {
      input: fileURLToPath(new URL("ui.html", import.meta.url)),
    },
    target: "es2022",
  },
  server: {
    proxy: {
      "/api": { target: proxyTarget, changeOrigin: false },
      "/archive": { target: proxyTarget, changeOrigin: false },
      "/healthz": { target: proxyTarget, changeOrigin: false },
      "/icon.svg": { target: proxyTarget, changeOrigin: false },
      "/assets": { target: proxyTarget, changeOrigin: false },
    },
  },
  root: packageDir,
});
