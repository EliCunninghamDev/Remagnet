import { browser } from "wxt/browser";

/**
 * Open the toolbar popover, the panel the browser shows when the extension
 * icon is clicked.
 *
 * MV3 exposes it as `browser.action`; MV2 (Firefox) uses `browserAction`. The
 * call rejects when the browser cannot open the panel, for example when the
 * window is not focused.
 */
export async function openToolbarPopup(): Promise<void> {
  const actions = browser as unknown as {
    action?: { openPopup?: () => Promise<void> };
    browserAction?: { openPopup?: () => Promise<void> };
  };
  const action = actions.action ?? actions.browserAction;
  if (!action?.openPopup) {
    throw new Error("This browser cannot open the extension popover programmatically.");
  }
  await action.openPopup();
}
