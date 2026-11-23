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
    .slice(0, 140)
    .replace(/[.\s]+$/, "");

  return `${/[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "torrent"}.zip`;
}
