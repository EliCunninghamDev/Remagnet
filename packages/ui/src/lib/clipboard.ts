/** How long a "Copied" label stays visible after a successful copy. */
export const COPY_FEEDBACK_MS = 2_000;

/**
 * Copy text to the clipboard, reporting whether it worked.
 *
 * The async clipboard API is preferred, but it can be missing or reject when
 * the document is not focused or permission was denied. The textarea fallback
 * still gives the user a way to copy in those cases.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
