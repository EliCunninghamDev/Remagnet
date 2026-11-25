/** Upper bound on the readable basename before the `.zip` suffix. */
const MAX_ARCHIVE_BASENAME_LENGTH = 140;

/**
 * Suggested download filename. Keeps the torrent's readable name while
 * removing path separators and characters browsers reject.
 */
export function archiveFilename(name: string): string {
  const cleaned = Array.from(name.normalize("NFC"))
    .map((character) => (character < " " || character === "\x7f" ? "" : character))
    .join("")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim()
    .slice(0, MAX_ARCHIVE_BASENAME_LENGTH)
    .replace(/[.\s]+$/, "");

  return `${/[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "torrent"}.zip`;
}
