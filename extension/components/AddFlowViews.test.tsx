import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, test, vi } from "vitest";
import { existingTorrent, galleryMagnet, galleryMagnetUri } from "../gallery/fixtures";
import AddedSummary from "./AddedSummary";
import type { FlowStatus } from "./flow-status";
import MagnetForm from "./MagnetForm";
import MagnetReview from "./MagnetReview";

function FormHarness(props: { status?: FlowStatus; canCancel?: boolean }) {
  const [draft, setDraft] = createSignal("");
  return (
    <MagnetForm
      draft={draft()}
      status={props.status}
      canCancel={Boolean(props.canCancel)}
      onDraftChange={setDraft}
      onSubmit={(event) => event.preventDefault()}
      onCancel={() => setDraft("")}
    />
  );
}

function ReviewHarness(props: {
  existing?: boolean;
  busy?: boolean;
  status?: FlowStatus;
  onPausedChange?: (paused: boolean) => void;
}) {
  const [paused, setPaused] = createSignal(false);
  return (
    <MagnetReview
      link={galleryMagnet}
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
