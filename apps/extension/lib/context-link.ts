/**
 * Message a page's content script sends just before the browser shows its
 * context menu, so the background can show the menu item only on magnet links.
 *
 * Kept in its own module so the content script does not pull in client code.
 */
export const CONTEXT_LINK_MESSAGE = "context:link";

export interface ContextLinkMessage {
  type: typeof CONTEXT_LINK_MESSAGE;
  /** The right-clicked link target, or an empty string for non-link targets. */
  href: string;
}

export function isContextLinkMessage(value: unknown): value is ContextLinkMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; href?: unknown };
  return candidate.type === CONTEXT_LINK_MESSAGE && typeof candidate.href === "string";
}
