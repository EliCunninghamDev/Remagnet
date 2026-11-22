import { browser } from "wxt/browser";

/** Convert a Web UI URL into the origin match pattern required by permissions APIs. */
export function getOriginPattern(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    // Match patterns cannot contain ports; host access covers every port.
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Request access to every configured origin in one prompt.
 *
 * Two sequential `permissions.request` calls lose the user gesture on some
 * Firefox versions, so the client and archive origins are combined.
 */
export async function ensureHostPermissions(baseUrls: string[]): Promise<boolean> {
  const origins = [
    ...new Set(
      baseUrls
        .filter((baseUrl) => baseUrl.trim().length > 0)
        .map(getOriginPattern)
        .filter((pattern): pattern is string => pattern !== null),
    ),
  ];
  if (origins.length === 0) return true;

  try {
    // Request directly so the call stays inside the originating user gesture.
    // Already-granted origins resolve without prompting.
    return await browser.permissions.request({ origins });
  } catch (error) {
    console.error("[remagnet] host permission request failed", origins, error);
    return false;
  }
}

// The manifest declares a wildcard (`*://*/*`) optional host permission,
// which lets us request only the configured origins. Two Firefox quirks
// matter here: `<all_urls>` is silently dropped from `optional_permissions`
// (so the request then fails as "not declared"), and the requested pattern
// has to be a subset of the declared wildcard rather than the other way
// around.
export async function ensureHostPermission(baseUrl: string): Promise<boolean> {
  return ensureHostPermissions([baseUrl]);
}
