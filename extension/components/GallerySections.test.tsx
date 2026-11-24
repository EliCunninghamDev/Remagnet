import { render, screen } from "@solidjs/testing-library";
import { describe, expect, test } from "vitest";
import AddFlow from "../gallery/AddFlow";
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

describe("gallery add flow section", () => {
  test("includes the .torrent file specimen with its extra metadata", () => {
    render(() => <AddFlow />);

    expect(screen.getByText("Torrent file")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ubuntu-26.04-live-server-amd64" })).toBeTruthy();
    expect(screen.getByText("12 files")).toBeTruthy();
    expect(screen.getAllByText("Yes").length).toBeGreaterThan(0);
  });
});
