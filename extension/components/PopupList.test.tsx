import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, test, vi } from "vitest";
import { clientLabel, popoverTorrents } from "../gallery/fixtures";
import PopupList, { type PopupListProps } from "./PopupList";

function renderList(overrides: Partial<PopupListProps> = {}) {
  const handlers = {
    onRetry: vi.fn(),
    onOpenSettings: vi.fn(),
    onDismissActionError: vi.fn(),
    onAdd: vi.fn(),
    onZip: vi.fn(),
    onRemoveToggle: vi.fn(),
    onRemove: vi.fn(),
    onCancelRemove: vi.fn(),
  };

  render(() => (
    <main class="popup">
      <PopupList
        torrents={popoverTorrents}
        loading={false}
        filterActive
        filterDescription="category 'remagnet'"
        clientLabel={clientLabel}
        serverLabel="https://qbt.example.com"
        archiveReady
        {...handlers}
        {...overrides}
      />
    </main>
  ));

  return handlers;
}

describe("PopupList", () => {
  test("renders the tracked torrents and the count badge", () => {
    renderList();

    expect(screen.getByRole("heading", { name: "Remagnet" })).toBeTruthy();
    expect(screen.getByTitle("debian-13.8.0-amd64-netinst.iso")).toBeTruthy();
    expect(screen.getByTitle("Fedora-Workstation-Live-44-x86_64.iso")).toBeTruthy();
    expect(screen.getByTitle("ubuntu-26.04-desktop-amd64.iso")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.queryByText("Loading torrents…")).toBeNull();
  });

  test("starts the add flow from the header", () => {
    const handlers = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(handlers.onAdd).toHaveBeenCalledOnce();
  });

  test("opens settings from the header", () => {
    const handlers = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(handlers.onOpenSettings).toHaveBeenCalledOnce();
  });

  test("explains the active filter when the list is empty", () => {
    renderList({ torrents: [] });
    expect(screen.getByText(/No Remagnet torrents yet/)).toBeTruthy();
    expect(screen.getByText(/category 'remagnet'/)).toBeTruthy();
  });

  test("uses the plain empty message when filtering is off", () => {
    renderList({ torrents: [], filterActive: false, filterDescription: "" });
    expect(screen.getByText("No torrents in qBittorrent.")).toBeTruthy();
  });

  test("shows a loading line before the first response", () => {
    renderList({ torrents: [], loading: true });
    expect(screen.getByText("Loading torrents…")).toBeTruthy();
  });

  test("replaces the list with a connection error and retries", () => {
    const handlers = renderList({
      torrents: [],
      error: "Could not reach qBittorrent at https://qbt.example.com.",
    });

    expect(
      screen.getByText("Could not reach qBittorrent at https://qbt.example.com."),
    ).toBeTruthy();
    expect(screen.queryByText("debian-13.8.0-amd64-netinst.iso")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(handlers.onRetry).toHaveBeenCalledOnce();
  });

  test("keeps the list when only a row action failed", () => {
    const handlers = renderList({
      actionError: "The Remagnet Proxy could not reach qBittorrent.",
    });

    expect(screen.getByText("The Remagnet Proxy could not reach qBittorrent.")).toBeTruthy();
    expect(screen.getByTitle("debian-13.8.0-amd64-netinst.iso")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(handlers.onDismissActionError).toHaveBeenCalledOnce();
  });
});
