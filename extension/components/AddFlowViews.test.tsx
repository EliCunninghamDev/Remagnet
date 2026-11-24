import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, test, vi } from "vitest";
import {
  existingTorrent,
  galleryMagnet,
  galleryMagnetUri,
  galleryTorrentFile,
} from "../gallery/fixtures";
import type { ParsedTorrentFile } from "../lib/torrent-file";
import AddedSummary from "./AddedSummary";
import type { FlowStatus } from "./flow-status";
import MagnetForm from "./MagnetForm";
import MagnetReview from "./MagnetReview";
import TorrentFileUpload from "./TorrentFileUpload";

function FormHarness(props: {
  status?: FlowStatus;
  canCancel?: boolean;
  embedded?: boolean;
  onFileSelect?: (file: File) => void;
  onOpenFilePickerSurface?: () => void;
}) {
  const [draft, setDraft] = createSignal("");
  return (
    <MagnetForm
      draft={draft()}
      status={props.status}
      canCancel={Boolean(props.canCancel)}
      embedded={Boolean(props.embedded)}
      onDraftChange={setDraft}
      onSubmit={(event) => event.preventDefault()}
      onCancel={() => setDraft("")}
      onFileSelect={props.onFileSelect}
      onOpenFilePickerSurface={props.onOpenFilePickerSurface}
    />
  );
}

function ReviewHarness(props: {
  existing?: boolean;
  busy?: boolean;
  status?: FlowStatus;
  file?: ParsedTorrentFile;
  onPausedChange?: (paused: boolean) => void;
}) {
  const [paused, setPaused] = createSignal(false);
  return (
    <MagnetReview
      link={props.file ? undefined : galleryMagnet}
      file={props.file}
      existing={props.existing ? existingTorrent : undefined}
      paused={paused()}
      busy={Boolean(props.busy)}
      status={props.status}
      onEdit={() => undefined}
      onSubmit={(event) => event.preventDefault()}
      onPausedChange={(value) => {
        setPaused(value);
        props.onPausedChange?.(value);
      }}
    />
  );
}

describe("MagnetForm", () => {
  test("keeps Continue disabled until there is text", () => {
    render(() => <FormHarness />);
    const submit = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.input(screen.getByRole("textbox"), { target: { value: galleryMagnetUri } });
    expect(submit.disabled).toBe(false);
  });

  test("shows a validation message and Cancel when a previous magnet exists", () => {
    render(() => (
      <FormHarness
        canCancel
        status={{
          tone: "error",
          message: "That magnet link has no usable BitTorrent info hash.",
        }}
      />
    ));

    expect(screen.getByText("That magnet link has no usable BitTorrent info hash.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  test("passes a chosen .torrent file to onFileSelect and clears the input", () => {
    const onFileSelect = vi.fn();
    const { container } = render(() => <FormHarness onFileSelect={onFileSelect} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["dummy"], "sample.torrent", {
      type: "application/x-bittorrent",
    });

    expect(input.accept).toBe(".torrent,application/x-bittorrent");
    fireEvent.change(input, { target: { files: [file] } });

    expect(onFileSelect).toHaveBeenCalledOnce();
    expect(onFileSelect).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });

  test("accepts a dropped .torrent file", () => {
    const onFileSelect = vi.fn();
    const { container } = render(() => <FormHarness onFileSelect={onFileSelect} />);
    const dropzone = container.querySelector(".dropzone") as HTMLElement;
    const file = new File(["dummy"], "dropped.torrent");

    fireEvent.dragOver(dropzone, { dataTransfer: { files: [file] } });
    expect(dropzone.classList.contains("dropzone-active")).toBe(true);

    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    expect(dropzone.classList.contains("dropzone-active")).toBe(false);
    expect(onFileSelect).toHaveBeenCalledOnce();
    expect(onFileSelect).toHaveBeenCalledWith(file);
  });

  test("hands file picking to the full page when embedded", () => {
    const onFileSelect = vi.fn();
    const onOpenFilePickerSurface = vi.fn();
    const { container } = render(() => (
      <FormHarness
        embedded
        onFileSelect={onFileSelect}
        onOpenFilePickerSurface={onOpenFilePickerSurface}
      />
    ));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, "click");

    fireEvent.click(screen.getByRole("button", { name: "Choose .torrent file…" }));

    expect(onOpenFilePickerSurface).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
    expect(onFileSelect).not.toHaveBeenCalled();
  });
});

describe("TorrentFileUpload", () => {
  function UploadHarness(props: {
    status?: FlowStatus;
    canCancel?: boolean;
    onFileSelect?: (file: File) => void;
    onCancel?: () => void;
  }) {
    return (
      <TorrentFileUpload
        status={props.status}
        canCancel={Boolean(props.canCancel)}
        onFileSelect={props.onFileSelect ?? (() => undefined)}
        onCancel={props.onCancel}
      />
    );
  }

  test("renders the upload prompt, hint and file-up icon", () => {
    const { container } = render(() => <UploadHarness />);

    expect(screen.getByText("Drag and drop a file to upload or click")).toBeTruthy();
    expect(screen.getByText(".torrent files up to 10 MiB")).toBeTruthy();

    const icon = container.querySelector(".upload-icon svg");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(icon?.querySelectorAll("path")).toHaveLength(4);
  });

  test("passes a chosen .torrent file to onFileSelect and clears the input", () => {
    const onFileSelect = vi.fn();
    const { container } = render(() => <UploadHarness onFileSelect={onFileSelect} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["dummy"], "sample.torrent", {
      type: "application/x-bittorrent",
    });

    expect(input.accept).toBe(".torrent,application/x-bittorrent");
    fireEvent.change(input, { target: { files: [file] } });

    expect(onFileSelect).toHaveBeenCalledOnce();
    expect(onFileSelect).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });

  test("accepts a dropped .torrent file and toggles the active drag state", () => {
    const onFileSelect = vi.fn();
    const { container } = render(() => <UploadHarness onFileSelect={onFileSelect} />);
    const zone = container.querySelector(".upload-zone") as HTMLButtonElement;
    const file = new File(["dummy"], "dropped.torrent");

    fireEvent.dragEnter(zone, { dataTransfer: { files: [file] } });
    expect(zone.classList.contains("upload-zone-active")).toBe(true);
    expect(screen.getByText("Drop .torrent file to upload")).toBeTruthy();

    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(zone.classList.contains("upload-zone-active")).toBe(false);
    expect(screen.getByText("Drag and drop a file to upload or click")).toBeTruthy();
    expect(onFileSelect).toHaveBeenCalledOnce();
    expect(onFileSelect).toHaveBeenCalledWith(file);
  });

  test("shows a status error and Cancel when a previous file can be restored", () => {
    const onCancel = vi.fn();
    render(() => (
      <UploadHarness
        canCancel
        onCancel={onCancel}
        status={{ tone: "error", message: "That file is not a valid .torrent." }}
      />
    ));

    expect(screen.getByText("That file is not a valid .torrent.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("MagnetReview", () => {
  test("summarizes the parsed magnet", () => {
    render(() => <ReviewHarness />);

    expect(screen.getByRole("heading", { name: "debian-13.8.0-amd64-netinst.iso" })).toBeTruthy();
    expect(screen.getByText("e75a1a6b922815d64cfa9b8904208d3a85143495")).toBeTruthy();
    expect(screen.getByText("635 MB")).toBeTruthy();
    expect(screen.getByText(/2 · tracker\.example\.org, tracker\.example\.net/)).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to Remagnet Proxy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });

  test("disables sending when the proxy already has the hash", () => {
    render(() => <ReviewHarness existing />);

    expect(screen.getByText(/Already in Remagnet Proxy/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to Remagnet Proxy" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  test("shows the metadata a .torrent file adds beyond a magnet", () => {
    render(() => <ReviewHarness file={galleryTorrentFile} />);

    expect(screen.getByRole("heading", { name: "ubuntu-26.04-live-server-amd64" })).toBeTruthy();
    expect(screen.getByText(galleryTorrentFile.infoHash)).toBeTruthy();
    expect(screen.getByText("2 GB")).toBeTruthy();
    expect(screen.getByText("12 files")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText(/2 · tracker\.example\.org, tracker\.example\.net/)).toBeTruthy();
    expect(screen.getByText("Show tracker URLs")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to Remagnet Proxy" })).toBeTruthy();
  });

  test("reports progress and errors on the submit action", () => {
    const { unmount } = render(() => <ReviewHarness busy />);
    expect(screen.getByRole("button", { name: "Sending…" })).toHaveProperty("disabled", true);
    unmount();

    render(() => (
      <ReviewHarness
        status={{ tone: "error", message: "The Remagnet Proxy could not reach qBittorrent." }}
      />
    ));
    expect(screen.getByText("The Remagnet Proxy could not reach qBittorrent.")).toBeTruthy();
  });

  test("offers Pause and forwards the choice", () => {
    const onPausedChange = vi.fn();
    render(() => <ReviewHarness onPausedChange={onPausedChange} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Add paused" }));
    expect(onPausedChange).toHaveBeenCalledWith(true);
  });
});

describe("AddedSummary", () => {
  test("names the torrent, category and tags", () => {
    render(() => (
      <AddedSummary
        name="debian-13.8.0-amd64-netinst.iso"
        category="remagnet"
        tags={["remagnet", "linux"]}
        embedded
        onAddAnother={() => undefined}
        onClose={() => undefined}
      />
    ));

    expect(screen.getByText(/Added “debian-13.8.0-amd64-netinst.iso”/)).toBeTruthy();
    expect(screen.getByText(/Category: remagnet/)).toBeTruthy();
    expect(screen.getByText(/Tags: remagnet, linux/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "View downloads" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });

  test("uses the page label outside the popover", () => {
    render(() => (
      <AddedSummary
        name="debian-13.8.0-amd64-netinst.iso"
        category=""
        tags={[]}
        embedded={false}
        onAddAnother={() => undefined}
        onClose={() => undefined}
      />
    ));

    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByText(/Category:/)).toBeNull();
  });
});
