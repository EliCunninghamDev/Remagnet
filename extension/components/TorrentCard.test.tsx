import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, test, vi } from "vitest";
import { type TorrentCase, torrentCase } from "../gallery/fixtures";
import TorrentCard from "./TorrentCard";

function renderCard(item: TorrentCase, overrides: Partial<Parameters<typeof TorrentCard>[0]> = {}) {
  const handlers = {
    onZip: vi.fn(),
    onRemoveToggle: vi.fn(),
    onRemove: vi.fn(),
    onCancelRemove: vi.fn(),
  };

  render(() => (
    <ul>
      <TorrentCard
        torrent={item.torrent}
        zipping={Boolean(item.zipping)}
        removing={Boolean(item.removing)}
        confirming={Boolean(item.confirming)}
        {...handlers}
        {...overrides}
      />
    </ul>
  ));

  return handlers;
}

describe("TorrentCard", () => {
  test("renders a live download with speed, ETA and completed bytes", () => {
    renderCard(torrentCase("downloading"));

    expect(screen.getByTitle("debian-13.8.0-amd64-netinst.iso")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByRole("progressbar").getAttribute("data-phase")).toBe("fetch");
    expect(screen.getByText("Downloading")).toBeTruthy();
    expect(screen.getByText("ETA")).toBeTruthy();
    expect(screen.getByText("12m")).toBeTruthy();
    expect(screen.getByText("7/42")).toBeTruthy();
    expect(screen.queryByText("Download")).toBeNull();
  });

  test("keeps long names whole in the DOM with the full name in a tooltip", () => {
    const item = torrentCase("long-name");
    renderCard(item);

    const name = screen.getByTitle(item.torrent.name);
    expect(name.getAttribute("title")).toBe(item.torrent.name);
    expect(name.querySelector(".torrent-name-head")?.textContent).toBeTruthy();
    expect(name.querySelector(".torrent-name-tail")?.textContent?.endsWith(".iso")).toBe(true);
  });

  test("turns a finished torrent into the Ready state and offers Download", () => {
    const handlers = renderCard(torrentCase("complete"));

    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByRole("progressbar").getAttribute("data-phase")).toBe("done");

    const download = screen.getByText("Download") as HTMLButtonElement;
    expect(download.disabled).toBe(false);

    fireEvent.click(download);
    expect(handlers.onZip).toHaveBeenCalledOnce();
  });

  test("marks stalled torrents amber without an unknown ETA field", () => {
    renderCard(torrentCase("stalled"));
    expect(screen.getByText("Stalled")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("data-phase")).toBe("zip");
    expect(screen.queryByText("ETA")).toBeNull();
  });

  test("reads stopped torrents as Paused with an idle bar", () => {
    renderCard(torrentCase("paused"));
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("data-phase")).toBe("idle");
  });

  test("keeps client errors available to assistive tech", () => {
    renderCard(torrentCase("error"));
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("data-phase")).toBe("idle");
  });

  test("shows Zipping while the archive is prepared", () => {
    renderCard(torrentCase("zipping"));
    expect(screen.getByText("Zipping")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("data-phase")).toBe("zip");
    expect((screen.getByText("Download") as HTMLButtonElement).disabled).toBe(true);
  });

  test("asks how to remove the torrent and forwards the choice", () => {
    const handlers = renderCard(torrentCase("complete"));
    fireEvent.click(screen.getByRole("button", { name: "Remove torrent" }));
    expect(handlers.onRemoveToggle).toHaveBeenCalledOnce();
  });

  test("forwards the keep, delete and cancel choices", () => {
    const handlers = renderCard(torrentCase("confirm"));

    fireEvent.click(screen.getByRole("button", { name: "Delete files" }));
    expect(handlers.onRemove).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handlers.onCancelRemove).toHaveBeenCalledOnce();
  });

  test("states stalled and paused in the Download slot", () => {
    renderCard(torrentCase("stalled"));

    const label = screen.getByText("Stalled");
    expect(label.className).not.toContain("sr-only");
    expect(document.querySelector(".row-actions .torrent-state")).toBe(label);
  });

  test("keeps the downloading word for assistive tech only", () => {
    renderCard(torrentCase("downloading"));
    expect(screen.getByText("Downloading").className).toContain("sr-only");
  });

  test("replaces the stats row with the confirmation", () => {
    renderCard(torrentCase("confirm"));

    expect(screen.getByText("Remove this torrent?")).toBeTruthy();
    expect(document.querySelector(".torrent-footer")).toBeNull();
    expect(document.querySelector(".remove-confirm")).not.toBeNull();
    expect(screen.queryByText("peers")).toBeNull();
  });

  test("disables the remove control while a removal is in flight", () => {
    renderCard(torrentCase("paused"), { removing: true });
    expect(
      (screen.getByRole("button", { name: "Remove torrent" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("pauses an active torrent from its row control", () => {
    const onTogglePause = vi.fn();
    renderCard(torrentCase("downloading"), { onTogglePause });

    const pause = screen.getByRole("button", { name: "Pause torrent" });
    expect(pause.classList.contains("is-paused")).toBe(false);

    fireEvent.click(pause);
    expect(onTogglePause).toHaveBeenCalledOnce();
  });

  test("resumes a stopped torrent and marks the control as paused", () => {
    const onTogglePause = vi.fn();
    renderCard(torrentCase("paused"), { onTogglePause });

    const resume = screen.getByRole("button", { name: "Resume torrent" });
    expect(resume.classList.contains("is-paused")).toBe(true);

    fireEvent.click(resume);
    expect(onTogglePause).toHaveBeenCalledOnce();
  });

  test("disables the pause control while its request is in flight", () => {
    renderCard(torrentCase("downloading"), { onTogglePause: vi.fn(), togglingPause: true });

    expect(
      (screen.getByRole("button", { name: "Pause torrent" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("hides the pause control when no handler is wired", () => {
    renderCard(torrentCase("downloading"));
    expect(screen.queryByRole("button", { name: /Pause torrent|Resume torrent/ })).toBeNull();
  });

  test("toggles the per-file browser from the row action", () => {
    const onToggleFiles = vi.fn();
    renderCard(torrentCase("complete"), { onToggleFiles });

    const toggle = screen.getByRole("button", { name: "Show files" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(onToggleFiles).toHaveBeenCalledOnce();
  });

  test("lists completed and incomplete files when expanded", () => {
    const files = [
      { index: 0, name: "ubuntu.iso", size: 4_000_000_000, progress: 1 },
      { index: 1, name: "extras/notes.txt", size: 2048, progress: 0.5 },
    ];
    renderCard(torrentCase("downloading"), {
      filesOpen: true,
      files,
      onToggleFiles: vi.fn(),
      onDownloadFile: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Hide files" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText("ubuntu.iso")).toBeTruthy();
    expect(screen.getByText("extras/notes.txt")).toBeTruthy();
    expect(screen.getByText(/50%/)).toBeTruthy();
    expect(document.querySelectorAll(".torrent-file-row .download-action")).toHaveLength(1);
  });

  test("downloads a completed file from the expanded list", () => {
    const file = { index: 0, name: "ubuntu.iso", size: 4_000_000_000, progress: 1 };
    const onDownloadFile = vi.fn();
    renderCard(torrentCase("complete"), {
      filesOpen: true,
      files: [file],
      onDownloadFile,
    });

    const download = document.querySelector(".torrent-file-row .download-action");
    if (!(download instanceof HTMLButtonElement)) throw new Error("Expected a file download");
    expect(download.disabled).toBe(false);

    fireEvent.click(download);
    expect(onDownloadFile).toHaveBeenCalledWith(file);
  });

  test("disables a file download while it is in flight", () => {
    const file = { index: 3, name: "ubuntu.iso", size: 4_000_000_000, progress: 1 };
    renderCard(torrentCase("complete"), {
      filesOpen: true,
      files: [file],
      downloadingFileIndex: 3,
      onDownloadFile: vi.fn(),
    });

    const download = document.querySelector(".torrent-file-row .download-action");
    if (!(download instanceof HTMLButtonElement)) throw new Error("Expected a file download");
    expect(download.disabled).toBe(true);
    expect(download.textContent).toBe("…");
  });

  test("shows a loading note while the file list is fetched", () => {
    renderCard(torrentCase("complete"), {
      filesOpen: true,
      filesLoading: true,
      onDownloadFile: vi.fn(),
    });

    expect(screen.getByText("Loading files…")).toBeTruthy();
    expect(screen.queryByText("No files available yet.")).toBeNull();
  });

  test("shows a file list error in place of the list", () => {
    renderCard(torrentCase("complete"), {
      filesOpen: true,
      filesError: "The Remagnet Proxy could not list files.",
      files: [{ index: 0, name: "ubuntu.iso", size: 1, progress: 1 }],
    });

    expect(screen.getByText("The Remagnet Proxy could not list files.")).toBeTruthy();
    expect(screen.queryByText("ubuntu.iso")).toBeNull();
  });

  test("shows an empty note when the torrent has no wanted files", () => {
    renderCard(torrentCase("complete"), { filesOpen: true, files: [] });

    expect(screen.getByText("No files available yet.")).toBeTruthy();
  });
});
