import { isLoopbackHost } from "@remagnet/proxy-client";
import {
  COPY_FEEDBACK_MS,
  copyText,
  errorMessage,
  type IssueReportContext,
  issueContextFromError,
} from "@remagnet/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  createPairing,
  isSessionExpired,
  type PairingSession,
  revokePairing as revokePairingRequest,
} from "../api";
import StatusLine, { type StatusMessage } from "./StatusLine";

interface ActivePairing {
  id: string;
  uri: string;
  svg: string;
  expiresAt: number;
}

interface CopiedPairing {
  id: string;
  uri: string;
}

/**
 * The dashboard keeps a handle to the active pairing so signing out can revoke
 * the code before the page switches back to the sign-in view. Both a plain
 * callback ref and a mutable ref object are accepted.
 */
export type PairingRevokeRef =
  | ((revoke: (() => void) | undefined) => void)
  | { current?: () => void };

export interface PairingPanelProps {
  /** Receives a function that revokes and hides the active pairing session. */
  revokeRef?: PairingRevokeRef;
  /** Called with redacted diagnostics when the user asks to report a failure. */
  onReportIssue?: (context: IssueReportContext) => void;
}

const ROTATE_AT_SECONDS = 5;
const COUNTDOWN_TICK_MS = 1_000;

/** One-time QR pairing for the Android app and browser extension. */
export default function PairingPanel(props: PairingPanelProps) {
  const [session, setSession] = createSignal<ActivePairing>();
  const [copiedSession, setCopiedSession] = createSignal<CopiedPairing>();
  const [remaining, setRemaining] = createSignal<number>();
  const [linkVisible, setLinkVisible] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<StatusMessage>();
  const [statusContext, setStatusContext] = createSignal<IssueReportContext>();

  let countdownTimer: number | undefined;
  let copyFeedbackTimer: number | undefined;

  const fallbackUri = () => session()?.uri ?? copiedSession()?.uri;

  onMount(() => {
    const onPageHide = () => {
      const current = session();
      if (current) void revokePairingRequest(current.id);
    };
    window.addEventListener("pagehide", onPageHide);
    onCleanup(() => window.removeEventListener("pagehide", onPageHide));
  });

  onCleanup(() => {
    stopCountdown();
    clearCopyFeedback();
    const current = session();
    if (current) void revokePairingRequest(current.id);
    setRevokeRef(undefined);
  });

  function setRevokeRef(revoke: (() => void) | undefined) {
    const ref = props.revokeRef;
    if (!ref) return;
    if (typeof ref === "function") ref(revoke);
    else ref.current = revoke;
  }

  function syncRevokeRef() {
    setRevokeRef(session() || copiedSession() ? revokeActive : undefined);
  }

  function pairingAllowed(): boolean {
    if (location.protocol === "https:") return true;
    return isLoopbackHost(location.hostname);
  }

  function stopCountdown() {
    if (countdownTimer !== undefined) {
      window.clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
  }

  function clearCopyFeedback() {
    if (copyFeedbackTimer !== undefined) {
      window.clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = undefined;
    }
  }

  function resetCopied() {
    clearCopyFeedback();
    setCopied(false);
  }

  function flashCopied() {
    clearCopyFeedback();
    setCopied(true);
    copyFeedbackTimer = window.setTimeout(() => {
      copyFeedbackTimer = undefined;
      setCopied(false);
    }, COPY_FEEDBACK_MS);
  }

  function startCountdown() {
    stopCountdown();
    const tick = () => {
      const current = session();
      if (!current) return;

      const seconds = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds <= ROTATE_AT_SECONDS) void rotatePairing(current);
    };
    tick();
    countdownTimer = window.setInterval(tick, COUNTDOWN_TICK_MS);
  }

  function showPairing(created: PairingSession) {
    setSession({
      id: created.id,
      uri: created.uri,
      svg: created.svg,
      expiresAt: Date.now() + created.expiresIn * 1000,
    });
    setRemaining(Math.max(0, Math.ceil(created.expiresIn)));
    resetCopied();
    setLinkVisible(false);
    setStatus(undefined);
    setStatusContext(undefined);
    syncRevokeRef();
    startCountdown();
  }

  function clearPairing(revoke: boolean) {
    const current = session();
    setSession(undefined);
    setRemaining(undefined);
    resetCopied();
    setLinkVisible(false);
    stopCountdown();
    if (revoke && current) void revokePairingRequest(current.id);
    syncRevokeRef();
  }

  function revokeActive() {
    const copiedCurrent = copiedSession();
    setCopiedSession(undefined);
    clearPairing(true);
    if (copiedCurrent) void revokePairingRequest(copiedCurrent.id);
    setStatus(undefined);
    setStatusContext(undefined);
  }

  async function startPairing() {
    if (busy()) return;
    if (!pairingAllowed()) {
      setStatus({
        tone: "error",
        message:
          "Pairing needs an HTTPS Remagnet Proxy URL. Put this page behind HTTPS and try again.",
      });
      setStatusContext(undefined);
      return;
    }

    setBusy(true);
    setStatus({ tone: "muted", message: "Creating a one-time code…" });
    setStatusContext(undefined);
    try {
      showPairing(await createPairing(location.origin));
    } catch (error) {
      if (isSessionExpired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContextFromError(error, "Pairing device"));
    } finally {
      setBusy(false);
    }
  }

  async function rotatePairing(previous: ActivePairing) {
    if (busy() || !session()) return;

    setBusy(true);
    try {
      const created = await createPairing(location.origin);
      if (!session()) {
        // The panel was hidden while the new code was being minted.
        void revokePairingRequest(created.id);
        return;
      }
      showPairing(created);
      void revokePairingRequest(previous.id);
    } catch (error) {
      if (isSessionExpired(error)) return;
      clearPairing(false);
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContextFromError(error, "Pairing device"));
    } finally {
      setBusy(false);
    }
  }

  function togglePairing() {
    if (session()) {
      clearPairing(true);
      setStatus(undefined);
      setStatusContext(undefined);
    } else {
      void startPairing();
    }
  }

  async function copyLink() {
    if (busy()) return;

    const current = session();
    if (current) {
      if (await copyText(current.uri)) {
        flashCopied();
        setLinkVisible(false);
        setStatus(undefined);
        setStatusContext(undefined);
      } else {
        resetCopied();
        setLinkVisible(true);
        setStatus({
          tone: "error",
          message: "Could not copy. Select the link below instead.",
        });
        setStatusContext({ action: "Copying pairing link", message: "Clipboard write failed." });
      }
      return;
    }

    if (!pairingAllowed()) {
      setStatus({
        tone: "error",
        message:
          "Pairing needs an HTTPS Remagnet Proxy URL. Put this page behind HTTPS and try again.",
      });
      setStatusContext(undefined);
      return;
    }

    setBusy(true);
    resetCopied();
    setLinkVisible(false);
    setStatus({ tone: "muted", message: "Creating a one-time link…" });
    setStatusContext(undefined);
    try {
      const created = await createPairing(location.origin);
      const previous = copiedSession();
      if (previous) void revokePairingRequest(previous.id);
      setCopiedSession({ id: created.id, uri: created.uri });
      syncRevokeRef();

      if (await copyText(created.uri)) {
        const seconds = Math.max(0, Math.ceil(created.expiresIn));
        flashCopied();
        setLinkVisible(false);
        setStatus({
          tone: "ok",
          message: `Copied a one-time pairing link. Expires in ${seconds}s.`,
        });
        setStatusContext(undefined);
      } else {
        resetCopied();
        setLinkVisible(true);
        setStatus({
          tone: "error",
          message: "Could not copy. Select the link below instead.",
        });
        setStatusContext({ action: "Copying pairing link", message: "Clipboard write failed." });
      }
    } catch (error) {
      if (isSessionExpired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContextFromError(error, "Pairing device"));
    } finally {
      setBusy(false);
    }
  }

  function reportIssue() {
    const context = statusContext();
    if (context) props.onReportIssue?.(context);
  }

  return (
    <section class="panel stack">
      <h2>Pair a device</h2>
      <p class="hint">
        Use this origin as the Remagnet Proxy URL in the extension or Android settings:
      </p>
      <code>{location.origin}</code>
      <p class="hint">
        Scan the one-time QR code or copy the link and open it on the device. Pairing links that
        browser or phone directly and never asks for your two-factor code. You can also sign in
        directly from the extension or app with your username and password. The code rotates every
        minute, works once, and is revoked when you hide it.
      </p>
      <div class="actions">
        <button type="button" class="ghost" disabled={busy()} onClick={togglePairing}>
          {session() ? "Hide QR code" : "Show QR code"}
        </button>
        <button type="button" class="ghost" disabled={busy()} onClick={() => void copyLink()}>
          {copied() ? "Copied" : "Copy link"}
        </button>
      </div>

      <StatusLine status={status()} onReport={props.onReportIssue ? reportIssue : undefined} />

      <Show when={linkVisible() && fallbackUri()}>
        {(uri) => <code class="pairing-link">{uri()}</code>}
      </Show>

      <Show when={session()}>
        <div class="qr-pair">
          <div
            class="qr-code"
            role="img"
            aria-label="QR code for pairing a Remagnet device"
            innerHTML={session()?.svg ?? ""}
          />
          <small>
            New code in {remaining() ?? 0}s. Single use — scan it only on your own device.
          </small>
        </div>
      </Show>
    </section>
  );
}
