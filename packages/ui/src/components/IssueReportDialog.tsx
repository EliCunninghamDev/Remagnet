import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { COPY_FEEDBACK_MS, copyText } from "../lib/clipboard";
import { buildIssueReport, type IssueReportContext } from "../lib/issue-report";

export interface IssueReportDialogProps {
  open: boolean;
  context?: IssueReportContext;
  /** Last known backend label (e.g. "qBittorrent 5.0"), never a URL. */
  backend?: string;
  /** Product label shown in the report, e.g. "Chrome extension" or "Proxy". */
  component?: string;
  /** Product version shown in the report. */
  version?: string;
  onClose: () => void;
}

type CopyState = "idle" | "copied" | "failed";

/**
 * Pure opt-in bug report surface.
 *
 * The report is built locally from redacted diagnostics. The dialog never
 * sends anything by itself: the user has to open GitHub, open a mail draft, or
 * copy the text before anything leaves the browser.
 */
export default function IssueReportDialog(props: IssueReportDialogProps) {
  const [copyState, setCopyState] = createSignal<CopyState>("idle");
  let copyTimer: number | undefined;

  const report = createMemo(() =>
    buildIssueReport({
      component: props.component ?? "Remagnet",
      version: props.version ?? "dev",
      platform: platformSummary(),
      context: { ...props.context, backend: props.context?.backend ?? props.backend },
    }),
  );

  createEffect(() => {
    if (!props.open) {
      clearCopyTimer();
      setCopyState("idle");
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onClose();
    };

    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  onCleanup(clearCopyTimer);

  function clearCopyTimer() {
    if (copyTimer !== undefined) {
      window.clearTimeout(copyTimer);
      copyTimer = undefined;
    }
  }

  function flash(state: CopyState) {
    clearCopyTimer();
    setCopyState(state);
    copyTimer = window.setTimeout(() => {
      copyTimer = undefined;
      setCopyState("idle");
    }, COPY_FEEDBACK_MS);
  }

  async function copyDiagnostics() {
    const copied = await copyText(report().diagnostics);
    flash(copied ? "copied" : "failed");
  }

  const copyLabel = () => {
    if (copyState() === "copied") return "Copied";
    if (copyState() === "failed") return "Copy blocked";
    return "Copy diagnostics";
  };

  return (
    <Show when={props.open}>
      <div class="report-backdrop">
        <section
          class="report-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-dialog-title"
        >
          <header class="report-head">
            <h2 id="report-dialog-title">Report an issue</h2>
            <button
              class="ghost report-close"
              type="button"
              aria-label="Close"
              title="Close"
              onClick={() => props.onClose()}
            >
              Close
            </button>
          </header>

          <p class="muted report-notice">
            Nothing is sent automatically. Review the redacted diagnostics below before choosing how
            to report.
          </p>

          <pre class="diagnostics-preview">{report().diagnostics}</pre>

          <div class="report-actions">
            <a class="button" href={report().githubUrl} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>
            <a class="button ghost" href={report().mailtoUrl}>
              Email report
            </a>
            <button class="ghost" type="button" onClick={() => void copyDiagnostics()}>
              {copyLabel()}
            </button>
          </div>
        </section>
      </div>
    </Show>
  );
}

/** OS-level platform label only; never the full user agent string. */
function platformSummary(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return (nav.userAgentData?.platform || nav.platform || "").trim();
}
