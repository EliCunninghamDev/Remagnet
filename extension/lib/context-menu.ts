import { browser } from "wxt/browser";
import { openToolbarPopup } from "./action-popup";
import { isContextLinkMessage } from "./context-link";
import { isMagnetLink, magnetFromText } from "./magnet";
import { pendingMagnetItem } from "./pending-magnet";

const MENU_ID = "remagnet-add-magnet";
/** Earlier releases registered an always-visible item under this id. */
const LEGACY_MENU_IDS = ["remagnet-add-link"];
const MENU_TITLE = "Add to Remagnet";

/**
 * Chrome has no extension protocol handlers, so a link context menu item is
 * the closest equivalent to Firefox's `magnet:` handler.
 *
 * Chrome cannot inspect the click before the menu renders (no `onShown` event,
 * and match patterns do not cover the `magnet:` scheme), so the item starts
 * hidden and a content script reports links as the pointer moves over them.
 * Hover matters: the menu is built before a sleeping service worker can wake,
 * so the state must already be right when the right-click happens. The click
 * handler validates again because the reported state can be stale on pages
 * where the content script does not run.
 */
export function startContextMenu(): void {
  if (import.meta.env.FIREFOX) return;

  const menus = browser.contextMenus;
  if (!menus) return;

  // Menu items survive service-worker restarts, so create once and swallow the
  // duplicate-id error on later wakeups. Never reset visibility here: a wakeup
  // is often the context-menu click itself, and hiding the item afterwards
  // would race with the visitor's right-click.
  for (const id of LEGACY_MENU_IDS) {
    menus.remove(id, () => {
      void browser.runtime.lastError;
    });
  }
  menus.create({ id: MENU_ID, title: MENU_TITLE, contexts: ["link"], visible: false }, () => {
    void browser.runtime.lastError;
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== browser.runtime.id) return;
    if (!isContextLinkMessage(message)) return;
    menus.update(MENU_ID, { visible: isMagnetLink(message.href) }, () => {
      void browser.runtime.lastError;
    });
  });

  menus.onClicked.addListener((info) => {
    if (info.menuItemId !== MENU_ID) return;

    const magnet = magnetFromText(info.linkUrl);
    if (magnet) {
      void addMagnet(magnet);
    } else {
      void explainNotAMagnet();
    }
  });
}

/** Store the magnet, then show it in the same popover as the Add button. */
async function addMagnet(magnet: string): Promise<void> {
  await pendingMagnetItem.setValue(magnet);

  try {
    await openToolbarPopup();
  } catch (error) {
    // The next manual popover open still finds the pending magnet.
    console.warn("[remagnet] could not open the toolbar popover", error);
  }
}

async function explainNotAMagnet(): Promise<void> {
  try {
    await browser.notifications.create("remagnet-not-a-magnet", {
      type: "basic",
      iconUrl: browser.runtime.getURL("/icon/128.png"),
      title: "Not a magnet link",
      message: "Right-click a magnet link to send it to Remagnet.",
      contextMessage: "Remagnet",
    });
  } catch (error) {
    console.warn("[remagnet] could not show a notification", error);
  }
}
