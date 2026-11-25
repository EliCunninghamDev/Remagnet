import { browser } from "wxt/browser";
import { getPublicSettings, type TorrentFileSurface } from "./settings";

export type { TorrentFileSurface };

/** Where the full add surface opens: a regular tab or a compact window. */
export type AddSurfaceMode = TorrentFileSurface;

export const DEFAULT_ADD_SURFACE_MODE: AddSurfaceMode = "popup-window";

/** Compact window size for the `.torrent` file picker surface. */
const ADD_FILE_WINDOW_WIDTH = 460;
const ADD_FILE_WINDOW_HEIGHT = 560;

/**
 * Open the full add page for choosing `.torrent` files.
 *
 * A native file picker closes the toolbar popover as soon as it takes focus, so
 * the popup hands the job to a page that can stay open for the whole selection.
 */
export async function openTorrentFileSurface(mode?: AddSurfaceMode): Promise<void> {
  const surface =
    mode ?? (await getPublicSettings()).torrentFileSurface ?? DEFAULT_ADD_SURFACE_MODE;
  const url = browser.runtime.getURL("/add.html?source=file");

  if (surface === "popup-window" && browser.windows?.create) {
    await browser.windows.create({
      url,
      type: "popup",
      width: ADD_FILE_WINDOW_WIDTH,
      height: ADD_FILE_WINDOW_HEIGHT,
    });
    return;
  }

  await browser.tabs.create({ url });
}
