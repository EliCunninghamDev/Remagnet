/**
 * Builds `promo/dist/screens.js` and `promo/dist/screens.css` from Remagnet's
 * real SolidJS extension components (`PopupList`, `SquareBar`, `MagnetReview`,
 * `Wordmark`) using the workspace's installed Vite + `vite-plugin-solid`.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const proxyUiReq = createRequire(resolve(root, "packages/proxy-ui/package.json"));
const { build } = (await import(proxyUiReq.resolve("vite"))) as typeof import("vite");
const solidMod = (await import(proxyUiReq.resolve("vite-plugin-solid"))) as {
  default: () => unknown;
};

await build({
  configFile: false,
  root: resolve(root, "packages/proxy-ui"),
  plugins: [solidMod.default() as never],
  build: {
    outDir: resolve(root, "promo/dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(root, "promo/screens.tsx"),
      formats: ["es"],
      fileName: () => "screens.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) return "screens.css";
          return "[name][extname]";
        },
      },
    },
  },
});
