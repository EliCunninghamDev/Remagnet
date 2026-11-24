import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { browser } from "wxt/browser";
import AddTorrent from "../../components/AddTorrent";
import { openToolbarPopup } from "../../lib/action-popup";
import { pendingMagnetItem } from "../../lib/pending-magnet";

/**
 * Protocol-handler target for `magnet:` links, and the page the toolbar
 * popover opens to choose `.torrent` files (`?source=file`).
 *
 * The toolbar popover is the normal place to add torrents, but Firefox can
 * only navigate a handler to a page. So this page stores the magnet, opens the
 * popover and then returns the tab to where it came from (or closes the tab
 * Firefox opened for it). If the popover cannot be opened, the full add page
 * stays available as a fallback.
 */
export default function App() {
  const [magnet, setMagnet] = createSignal(readMagnet());
  const fileSource = readSource() === "file";

  onMount(() => {
    const handleHashChange = () => setMagnet(readMagnet());
    window.addEventListener("hashchange", handleHashChange);
    onCleanup(() => window.removeEventListener("hashchange", handleHashChange));

    void handOff(magnet());
  });

  return (
    <Show
      when={magnet()}
      keyed
      fallback={
        <AddTorrent
          initialMagnet=""
          fileOnly={fileSource}
          autoFocusFile={fileSource}
          onClose={() => void closePage()}
        />
      }
    >
      {(uri) => <AddTorrent initialMagnet={uri} onClose={() => void closePage()} />}
    </Show>
  );
}

/** Give the magnet to the popover, then leave the page the way we found it. */
async function handOff(magnet: string): Promise<void> {
  if (!magnet) return;

  await pendingMagnetItem.setValue(magnet);

  try {
    await openToolbarPopup();
  } catch (error) {
    // Older browsers, or a window that is not focused. Keep the full add page
    // visible instead of leaving a magnet nobody consumes.
    console.warn("[remagnet] could not open the toolbar popover", error);
    await pendingMagnetItem.setValue(null);
    return;
  }

  if (history.length > 1) {
    history.back();
    return;
  }

  await closePage();
}

async function closePage(): Promise<void> {
  try {
    const tab = await browser.tabs.getCurrent();
    if (tab?.id !== undefined) {
      await browser.tabs.remove(tab.id);
      return;
    }
  } catch {
    // Fall back to window.close below.
  }
  window.close();
}

function readMagnet(): string {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** `?source=file` means the popover handed off its `.torrent` file chooser. */
function readSource(): string | null {
  return new URLSearchParams(location.search).get("source");
}
