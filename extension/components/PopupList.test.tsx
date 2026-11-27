import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, test, vi } from "vitest";
import { popoverTorrents, proxyBaseUrl, torrentCase } from "../gallery/fixtures";
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

function visibleNames() {
  return screen
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".torrent-name")?.getAttribute("title"));
}

function chooseSort(value: string) {
  fireEvent.change(screen.getByRole("combobox", { name: "Sort torrents" }), {
    target: { value },
  });
}

describe("PopupList", () => {
  test("renders the tracked torrents and the count badge", () => {
    renderList();

    expect(screen.getByRole("heading", { name: "Remagnet" })).toBeTruthy();
    expect(screen.getByTitle("debian-13.8.0-amd64-netinst.iso")).toBeTruthy();
    expect(screen.getByTitle("Fedora-Workstation-Live-44-x86_64.iso")).toBeTruthy();
    expect(screen.getByTitle("ubuntu-26.04-desktop-amd64.iso")).toBeTruthy();
    expect(screen.getByText("3", { selector: ".count-badge" })).toBeTruthy();
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

  test("forwards a per-row pause request for an active torrent", () => {
    const onTogglePause = vi.fn();
    renderList({ onTogglePause });

    const [pause] = screen.getAllByRole("button", { name: "Pause torrent" });
    if (!pause) throw new Error("Expected a pause control");
    fireEvent.click(pause);
    expect(onTogglePause).toHaveBeenCalledWith(popoverTorrents[0]);
  });

  test("forwards a per-row resume request for a stopped torrent", () => {
    const paused = torrentCase("paused").torrent;
    const onTogglePause = vi.fn();
    renderList({ torrents: [paused], onTogglePause });

    fireEvent.click(screen.getByRole("button", { name: "Resume torrent" }));
    expect(onTogglePause).toHaveBeenCalledWith(paused);
  });

  test("shows Pause all for an active list and forwards the click", () => {
    const onPauseAll = vi.fn();
    renderList({ onPauseAll });

    const pauseAll = screen.getByRole("button", {
      name: "Pause all torrents",
    }) as HTMLButtonElement;
    expect(pauseAll.disabled).toBe(false);

    fireEvent.click(pauseAll);
    expect(onPauseAll).toHaveBeenCalledOnce();
  });

  test("shows Resume all for a paused list and forwards the click", () => {
    const onResumeAll = vi.fn();
    renderList({ torrents: [torrentCase("paused").torrent], onResumeAll });

    fireEvent.click(screen.getByRole("button", { name: "Resume all torrents" }));
    expect(onResumeAll).toHaveBeenCalledOnce();
  });

  test("hides the bulk controls when no callbacks are wired", () => {
    renderList();

    expect(screen.queryByRole("button", { name: "Pause all torrents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume all torrents" })).toBeNull();
  });

  test("only offers Pause all while an active torrent remains", () => {
    renderList({
      torrents: [torrentCase("paused").torrent],
      onPauseAll: vi.fn(),
      onResumeAll: vi.fn(),
    });

    expect(screen.queryByRole("button", { name: "Pause all torrents" })).toBeNull();
    expect(screen.getByRole("button", { name: "Resume all torrents" })).toBeTruthy();
  });

  test("only offers Resume all while a paused torrent remains", () => {
    renderList({ onPauseAll: vi.fn(), onResumeAll: vi.fn() });

    expect(screen.getByRole("button", { name: "Pause all torrents" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume all torrents" })).toBeNull();
  });

  test("disables both bulk controls while an action is in flight", () => {
    renderList({
      torrents: [torrentCase("downloading").torrent, torrentCase("paused").torrent],
      onPauseAll: vi.fn(),
      onResumeAll: vi.fn(),
      bulkAction: "pause",
    });

    expect(
      (screen.getByRole("button", { name: "Pause all torrents" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Resume all torrents" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("filters the list by name and hash as the user types", () => {
    renderList();
    const search = screen.getByRole("searchbox", { name: "Search torrents" });

    fireEvent.input(search, { target: { value: "debian" } });
    expect(visibleNames()).toEqual(["debian-13.8.0-amd64-netinst.iso"]);

    fireEvent.input(search, { target: { value: "b2" } });
    expect(visibleNames()).toEqual(["Fedora-Workstation-Live-44-x86_64.iso"]);

    fireEvent.input(search, { target: { value: "" } });
    expect(visibleNames()).toHaveLength(3);
  });

  test("filters by status tab and shows a count on each bucket", () => {
    renderList();

    const tab = (label: string) => screen.getByRole("tab", { name: new RegExp(`^${label}`) });

    expect(tab("All").textContent).toContain("3");
    expect(tab("Active").textContent).toContain("2");
    expect(tab("Ready").textContent).toContain("1");
    expect(tab("Paused").textContent).toBe("Paused");

    fireEvent.click(tab("Active"));
    expect(tab("Active").getAttribute("aria-selected")).toBe("true");
    expect(visibleNames()).toEqual([
      "debian-13.8.0-amd64-netinst.iso",
      "Fedora-Workstation-Live-44-x86_64.iso",
    ]);

    fireEvent.click(tab("Ready"));
    expect(visibleNames()).toEqual(["ubuntu-26.04-desktop-amd64.iso"]);

    fireEvent.click(tab("Paused"));
    expect(screen.getByText("No torrents match your filter.")).toBeTruthy();

    fireEvent.click(tab("All"));
    expect(visibleNames()).toHaveLength(3);
  });

  test("reorders rows from the sort dropdown", () => {
    const base = torrentCase("downloading").torrent;
    const torrents = [
      {
        ...base,
        hash: "b2".padEnd(40, "0"),
        name: "Beta.iso",
        progress: 0.9,
        size: 100,
        downloadSpeed: 300,
      },
      {
        ...base,
        hash: "c3".padEnd(40, "0"),
        name: "Gamma.iso",
        progress: 0.5,
        size: 200,
        downloadSpeed: 200,
      },
      {
        ...base,
        hash: "a1".padEnd(40, "0"),
        name: "Alpha.iso",
        progress: 0.2,
        size: 300,
        downloadSpeed: 100,
      },
    ];
    renderList({ torrents });

    expect(visibleNames()).toEqual(["Beta.iso", "Gamma.iso", "Alpha.iso"]);

    chooseSort("name");
    expect(visibleNames()).toEqual(["Alpha.iso", "Beta.iso", "Gamma.iso"]);

    chooseSort("progress");
    expect(visibleNames()).toEqual(["Beta.iso", "Gamma.iso", "Alpha.iso"]);

    chooseSort("size");
    expect(visibleNames()).toEqual(["Alpha.iso", "Gamma.iso", "Beta.iso"]);

    chooseSort("speed");
    expect(visibleNames()).toEqual(["Beta.iso", "Gamma.iso", "Alpha.iso"]);

    chooseSort("added");
    expect(visibleNames()).toEqual(["Beta.iso", "Gamma.iso", "Alpha.iso"]);
  });

  test("clears the search and status filter from the empty state", () => {
    renderList();
    const search = screen.getByRole("searchbox", { name: "Search torrents" }) as HTMLInputElement;

    fireEvent.input(search, { target: { value: "no such torrent" } });
    expect(screen.getByText("No torrents match your filter.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(search.value).toBe("");
    expect(visibleNames()).toHaveLength(3);

    fireEvent.click(screen.getByRole("tab", { name: /^Paused/ }));
    expect(screen.getByText("No torrents match your filter.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(visibleNames()).toHaveLength(3);
    expect(screen.getByRole("tab", { name: /^All/ }).getAttribute("aria-selected")).toBe("true");
  });

  test("hides the controls for a single torrent with no active query", () => {
    renderList({ torrents: [torrentCase("downloading").torrent] });

    expect(screen.queryByRole("searchbox", { name: "Search torrents" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Sort torrents" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Filter torrents" })).toBeNull();
    expect(screen.getByTitle("debian-13.8.0-amd64-netinst.iso")).toBeTruthy();
  });

  test("forwards the per-row files toggle", () => {
    const torrent = torrentCase("complete").torrent;
    const onToggleFiles = vi.fn();
    renderList({ torrents: [torrent], onToggleFiles });

    fireEvent.click(screen.getByRole("button", { name: "Show files" }));
    expect(onToggleFiles).toHaveBeenCalledWith(torrent);
  });

  test("renders expanded files and forwards a per-file download", () => {
    const torrent = torrentCase("complete").torrent;
    const files = [
      { index: 0, name: "ubuntu.iso", size: 4_000_000_000, progress: 1 },
      { index: 1, name: "extras/notes.txt", size: 2048, progress: 0.5 },
    ];
    const onDownloadFile = vi.fn();
    renderList({
      torrents: [torrent],
      expandedHash: torrent.hash,
      filesByHash: { [torrent.hash]: files },
      onToggleFiles: vi.fn(),
      onDownloadFile,
    });

    expect(screen.getByRole("button", { name: "Hide files" })).toBeTruthy();
    expect(screen.getByText("ubuntu.iso")).toBeTruthy();
    expect(screen.getByText("extras/notes.txt")).toBeTruthy();

    const download = document.querySelector(".torrent-file-row .download-action");
    if (!(download instanceof HTMLButtonElement)) throw new Error("Expected a file download");
    fireEvent.click(download);
    expect(onDownloadFile).toHaveBeenCalledWith(torrent, files[0]);
  });

  test("shows the file loading state for the expanded torrent", () => {
    const torrent = torrentCase("complete").torrent;
    renderList({
      torrents: [torrent],
      expandedHash: torrent.hash,
      filesLoadingHash: torrent.hash,
      onToggleFiles: vi.fn(),
    });

    expect(screen.getByText("Loading files…")).toBeTruthy();
  });

  test("shows a file list error when the torrent is expanded", () => {
    const torrent = torrentCase("complete").torrent;
    const message = "The Remagnet Proxy could not list files.";
    renderList({
      torrents: [torrent],
      expandedHash: torrent.hash,
      filesError: message,
      onToggleFiles: vi.fn(),
    });

    expect(screen.getByText(message)).toBeTruthy();
  });

  test("hides the file list error while the torrent is collapsed", () => {
    const torrent = torrentCase("complete").torrent;
    const message = "The Remagnet Proxy could not list files.";
    renderList({ torrents: [torrent], filesError: message, onToggleFiles: vi.fn() });

    expect(screen.queryByText(message)).toBeNull();
  });

  test("shows an empty file list note", () => {
    const torrent = torrentCase("complete").torrent;
    renderList({
      torrents: [torrent],
      expandedHash: torrent.hash,
      filesByHash: { [torrent.hash]: [] },
      onToggleFiles: vi.fn(),
    });

    expect(screen.getByText("No files available yet.")).toBeTruthy();
  });
});
