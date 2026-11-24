import { browser } from "wxt/browser";

/** Where the full add surface opens: a regular tab or a compact window. */
export type AddSurfaceMode = "tab" | "popup-window";

export const DEFAULT_ADD_SURFACE_MODE: AddSurfaceMode = "tab";

/**
 * Open the full add page for choosing `.torrent` files.
 *
 * A native file picker closes the toolbar popover as soon as it takes focus, so
 * the popup hands the job to a page that can stay open for the whole selection.
 */
export async function openTorrentFileSurface(
  mode: AddSurfaceMode = DEFAULT_ADD_SURFACE_MODE,
): Promise<void> {
  const url = browser.runtime.getURL("/add.html?source=file");

  if (mode === "popup-window" && browser.windows?.create) {
    await browser.windows.create({ url, type: "popup", width: 460, height: 640 });
    return;
  }

  await browser.tabs.create({ url });
}
