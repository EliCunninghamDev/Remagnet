import { render, screen } from "@solidjs/testing-library";
import { describe, expect, test } from "vitest";
import { torrentCases } from "../gallery/fixtures";
import Torrents from "../gallery/Torrents";

describe("gallery torrent section", () => {
  test("renders one specimen for every fixture", () => {
    render(() => <Torrents />);

    for (const entry of torrentCases) {
      expect(screen.getAllByText(entry.label).length).toBeGreaterThan(0);
      expect(screen.getByTitle(entry.torrent.name)).toBeTruthy();
    }

    // A confirming specimen swaps the row controls out for the confirmation,
    // so only the rest carry a remove button.
    expect(screen.getAllByRole("button", { name: "Remove torrent" })).toHaveLength(
      torrentCases.filter((entry) => !entry.confirming).length,
    );
  });
});
