import { storage } from "wxt/utils/storage";

/**
 * A magnet handed from the protocol-handler page to the toolbar popover.
 *
 * Firefox cannot open an extension popover directly from a `magnet:` click, so
 * `add.html` stores the link here, opens the popover, and then gets out of the
 * way. The popover consumes the value exactly once.
 */
export const pendingMagnetItem = storage.defineItem<string | null>("local:pending-magnet", {
  fallback: null,
});
