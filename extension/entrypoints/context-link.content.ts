import { browser } from "wxt/browser";
import { CONTEXT_LINK_MESSAGE } from "../lib/context-link";

function linkHref(target: EventTarget | null): string | null {
  const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
  return link?.href ?? null;
}

/**
 * Chrome cannot register a `magnet:` protocol handler and its context menu API
 * has no `onShown` event, so the background item stays hidden until a page
 * reports what the pointer is over.
 *
 * Reporting on hover rather than only on `contextmenu` matters: the menu is
 * built before a suspended service worker can wake up, so the state has to be
 * set before the right-click. An item left visible or hidden by the previous
 * hover is already correct for the link under the pointer.
 *
 * This runs only in the Chrome build; Firefox uses the protocol handler and
 * gets no all-sites content script.
 */
export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  main() {
    let hovered: string | null = null;

    const report = (href: string) => {
      void browser.runtime.sendMessage({ type: CONTEXT_LINK_MESSAGE, href }).catch(() => {});
    };

    document.addEventListener(
      "pointerover",
      (event) => {
        const href = linkHref(event.target);
        if (href === null || href === hovered) return;
        hovered = href;
        report(href);
      },
      // Capture so page handlers that stop propagation cannot hide the state.
      true,
    );

    document.addEventListener(
      "contextmenu",
      (event) => {
        const href = linkHref(event.target);
        hovered = href;
        // Always report: a previous menu click deliberately hid the item while
        // the pointer stayed on the same link.
        report(href ?? "");
      },
      true,
    );
  },
});
