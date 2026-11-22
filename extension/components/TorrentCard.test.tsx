import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, test, vi } from "vitest";
import { clientLabel, type TorrentCase, torrentCase } from "../gallery/fixtures";
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
        archiveReady={Boolean(item.archiveReady)}
        clientLabel={clientLabel}
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

    fireEvent.click(screen.getByText("Download"));
    expect(handlers.onZip).toHaveBeenCalledOnce();
  });

  test("disables Download when the Remagnet Proxy is not configured", () => {
    renderCard(torrentCase("complete-no-proxy"));

    const download = screen.getByText("Download") as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    expect(download.title).toBe(
      "Configure Remagnet Proxy in settings to download completed torrents",
    );
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

    expect(screen.getByText("Remove from qBittorrent?")).toBeTruthy();
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
});
