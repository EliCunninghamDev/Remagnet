import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, test, vi } from "vitest";
import { popoverTorrents, proxyBaseUrl } from "../gallery/fixtures";
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
        configured
        serverLabel={proxyBaseUrl}
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

  test("names the proxy in the wordmark tooltip", () => {
    renderList();

    expect(screen.getByRole("heading", { name: "Remagnet" }).getAttribute("title")).toBe(
      `Remagnet Proxy · ${proxyBaseUrl}`,
    );
  });

  test("starts the add flow from the header", () => {
    const handlers = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(handlers.onAdd).toHaveBeenCalledOnce();
  });

  test("names both add sources in the header tooltip", () => {
    renderList();

    expect(screen.getByRole("button", { name: "Add" }).getAttribute("title")).toBe(
      "Add a magnet or .torrent file",
    );
  });

  test("opens settings from the header", () => {
    const handlers = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(handlers.onOpenSettings).toHaveBeenCalledOnce();
  });

  test("shows the get started panel when the proxy is not configured", () => {
    const handlers = renderList({ configured: false, torrents: [], loading: false });

    expect(screen.getByRole("heading", { name: "Get started" })).toBeTruthy();
    expect(screen.getByText(/Remagnet connects through your Remagnet Proxy/)).toBeTruthy();
    expect(
      screen.queryByText("No Remagnet torrents yet. Add a magnet or .torrent file to see it here."),
    ).toBeNull();
    expect(screen.queryByText("Loading torrents…")).toBeNull();

    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(handlers.onOpenSettings).toHaveBeenCalledOnce();
  });

  test("keeps the empty list text concise", () => {
    renderList({ torrents: [] });
    expect(
      screen.getByText("No Remagnet torrents yet. Add a magnet or .torrent file to see it here."),
    ).toBeTruthy();
  });

  test("shows a loading line before the first response", () => {
    renderList({ torrents: [], loading: true });
    expect(screen.getByText("Loading torrents…")).toBeTruthy();
  });

  test("replaces the list with a connection error and retries", () => {
    const handlers = renderList({
      torrents: [],
      error: "Could not reach the Remagnet Proxy at https://remagnet.example.com.",
    });

    expect(
      screen.getByText("Could not reach the Remagnet Proxy at https://remagnet.example.com."),
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
