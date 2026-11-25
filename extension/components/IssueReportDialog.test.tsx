import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import IssueReportDialog, { type IssueReportDialogProps } from "./IssueReportDialog";

const context = {
  action: "Listing torrents",
  message: "Could not reach https://proxy.example.com using Bearer rmg_secret",
  code: "proxy_unreachable",
  status: 502,
};

function renderDialog(overrides: Partial<IssueReportDialogProps> = {}) {
  const onClose = vi.fn();
  render(() => (
    <IssueReportDialog
      open
      context={context}
      backend="qBittorrent 5.0"
      onClose={onClose}
      {...overrides}
    />
  ));
  return { onClose };
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(writeText) },
  });
}

describe("IssueReportDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
  });

  test("explains that nothing is sent until the user acts", () => {
    renderDialog();

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Report an issue" })).toBeTruthy();
    expect(
      screen.getByText(
        "Nothing is sent automatically. Review the redacted diagnostics below before choosing how to report.",
      ),
    ).toBeTruthy();
  });

  test("shows the redacted diagnostics and structured context", () => {
    renderDialog();

    const preview = document.querySelector(".diagnostics-preview");
    expect(preview).toBeTruthy();
    const text = preview?.textContent ?? "";
    const component = import.meta.env.FIREFOX ? "Firefox extension" : "Chrome extension";

    expect(text).toContain(`Component: ${component}`);
    expect(text).toContain("Backend: qBittorrent 5.0");
    expect(text).toContain("Action: Listing torrents");
    expect(text).toContain("HTTP status: 502");
    expect(text).toContain("Error code: proxy_unreachable");
    expect(text).toContain("Error message: Could not reach [redacted-url] using Bearer [redacted]");
    expect(text).not.toContain("proxy.example.com");
    expect(text).not.toContain("rmg_secret");
  });

  test("offers GitHub and mail links as explicit opt-in actions", () => {
    renderDialog();

    const github = screen.getByRole("link", { name: "Open on GitHub" });
    expect(
      github
        .getAttribute("href")
        ?.startsWith("https://github.com/EliCunninghamDev/Remagnet/issues/new?"),
    ).toBe(true);
    expect(github.getAttribute("target")).toBe("_blank");
    expect(github.getAttribute("rel")).toBe("noreferrer");

    const mail = screen.getByRole("link", { name: "Email report" });
    expect(mail.getAttribute("href")?.startsWith("mailto:contact@elijahcunningham.dev?")).toBe(
      true,
    );
  });

  test("copies diagnostics and confirms for two seconds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain("Action: Listing torrents");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

    vi.advanceTimersByTime(2000);
    expect(screen.getByRole("button", { name: "Copy diagnostics" })).toBeTruthy();
  });

  test("fails gracefully when the clipboard is blocked", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("Not allowed")));
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByRole("button", { name: "Copy blocked" })).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("closes with the Close button and Escape", () => {
    const { onClose } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("renders nothing while closed", () => {
    renderDialog({ open: false });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Report an issue")).toBeNull();
  });
});
