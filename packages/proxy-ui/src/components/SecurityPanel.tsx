import type { IssueReportContext } from "@remagnet/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { changePassword, disableTotp, enableTotp, ProxyApiError, setupTotp } from "../api";
import StatusLine, { type StatusMessage } from "./StatusLine";

interface TotpSetupDetails {
  secret: string;
  svg: string;
}

export interface SecurityPanelProps {
  totpEnabled: boolean;
  onTotpChanged: (enabled: boolean) => void;
  onSessionExpired: () => void;
  onReportIssue: (context: IssueReportContext) => void;
}

/** Two-factor authentication and password controls for the administrator. */
export default function SecurityPanel(props: SecurityPanelProps) {
  const [setup, setSetup] = createSignal<TotpSetupDetails>();
  const [verifyCode, setVerifyCode] = createSignal("");
  const [recoveryCodes, setRecoveryCodes] = createSignal<string[]>([]);
  const [copiedRecovery, setCopiedRecovery] = createSignal(false);

  const [starting, setStarting] = createSignal(false);
  const [enabling, setEnabling] = createSignal(false);
  const [disabling, setDisabling] = createSignal(false);
  const [changingPassword, setChangingPassword] = createSignal(false);

  const [status, setStatus] = createSignal<StatusMessage>();
  const [statusContext, setStatusContext] = createSignal<IssueReportContext>();
  const [disableStatus, setDisableStatus] = createSignal<StatusMessage>();
  const [disableContext, setDisableContext] = createSignal<IssueReportContext>();
  const [passwordStatus, setPasswordStatus] = createSignal<StatusMessage>();
  const [passwordContext, setPasswordContext] = createSignal<IssueReportContext>();

  const [disablePassword, setDisablePassword] = createSignal("");
  const [disableCode, setDisableCode] = createSignal("");

  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");

  let verifyInput: HTMLInputElement | undefined;
  let disablePasswordInput: HTMLInputElement | undefined;
  let confirmPasswordInput: HTMLInputElement | undefined;
  let copyTimer: number | undefined;

  onCleanup(() => {
    if (copyTimer !== undefined) window.clearTimeout(copyTimer);
  });

  async function startSetup() {
    if (starting()) return;

    setStarting(true);
    setStatus({ tone: "muted", message: "Preparing two-factor setup…" });
    setStatusContext(undefined);
    try {
      const result = await setupTotp();
      setSetup({ secret: result.secret, svg: result.svg });
      setVerifyCode("");
      setStatus({
        tone: "muted",
        message: "Scan the code, then enter the 6-digit code to verify.",
      });
      queueMicrotask(() => verifyInput?.focus());
    } catch (error) {
      if (expired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContext(error, "Starting two-factor setup"));
    } finally {
      setStarting(false);
    }
  }

  function cancelSetup() {
    setSetup(undefined);
    setVerifyCode("");
    setStatus(undefined);
    setStatusContext(undefined);
  }

  async function verifyAndEnable(event: SubmitEvent) {
    event.preventDefault();
    if (enabling()) return;

    const code = verifyCode().trim();
    if (!/^\d{6}$/.test(code)) {
      setStatus({
        tone: "error",
        message: "Enter the 6-digit code from your authenticator.",
      });
      setStatusContext(undefined);
      verifyInput?.focus();
      return;
    }

    setEnabling(true);
    setStatus({ tone: "muted", message: "Verifying…" });
    setStatusContext(undefined);
    try {
      const result = await enableTotp(code);
      setRecoveryCodes(Array.isArray(result.recoveryCodes) ? result.recoveryCodes : []);
      setSetup(undefined);
      setVerifyCode("");
      props.onTotpChanged(true);
      setStatus({
        tone: "ok",
        message: "Two-factor authentication is enabled. Save your recovery codes now.",
      });
    } catch (error) {
      if (expired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContext(error, "Enabling two-factor authentication"));
    } finally {
      setEnabling(false);
    }
  }

  async function copyRecoveryCodes() {
    const codes = recoveryCodes();
    if (!codes.length) return;

    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopiedRecovery(true);
      setStatus({
        tone: "ok",
        message: "Recovery codes copied to the clipboard.",
      });
      setStatusContext(undefined);

      if (copyTimer !== undefined) window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        copyTimer = undefined;
        setCopiedRecovery(false);
      }, 2000);
    } catch {
      setStatus({
        tone: "error",
        message: "Could not copy automatically. Select the codes to copy them.",
      });
      setStatusContext({ action: "Copying recovery codes", message: "Clipboard write failed." });
    }
  }

  async function disableTwoFactor(event: SubmitEvent) {
    event.preventDefault();
    if (disabling()) return;

    const password = disablePassword();
    const code = disableCode().trim();
    if (!password) {
      setDisableStatus({ tone: "error", message: "Enter your current password." });
      setDisableContext(undefined);
      disablePasswordInput?.focus();
      return;
    }

    setDisabling(true);
    setDisableStatus({ tone: "muted", message: "Disabling…" });
    setDisableContext(undefined);
    try {
      await disableTotp({ password, ...(code ? { code } : {}) });
      props.onTotpChanged(false);
      setRecoveryCodes([]);
      setDisablePassword("");
      setDisableCode("");
      setDisableStatus(undefined);
      setDisableContext(undefined);
      setStatus({ tone: "ok", message: "Two-factor authentication is disabled." });
      setStatusContext(undefined);
    } catch (error) {
      if (expired(error)) return;
      setDisableStatus({
        tone: "error",
        message:
          error instanceof ProxyApiError && error.status === 401
            ? "That two-factor or recovery code is not valid."
            : errorMessage(error),
      });
      setDisableContext(issueContext(error, "Disabling two-factor authentication"));
    } finally {
      setDisabling(false);
    }
  }

  async function submitPassword(event: SubmitEvent) {
    event.preventDefault();
    if (changingPassword()) return;

    const next = newPassword();
    if (next.length < 12) {
      setPasswordStatus({
        tone: "error",
        message: "Use a new password with at least 12 characters.",
      });
      setPasswordContext(undefined);
      return;
    }
    if (next !== confirmPassword()) {
      setPasswordStatus({ tone: "error", message: "The new passwords do not match." });
      setPasswordContext(undefined);
      confirmPasswordInput?.focus();
      return;
    }

    setChangingPassword(true);
    setPasswordStatus({ tone: "muted", message: "Changing password…" });
    setPasswordContext(undefined);
    try {
      await changePassword({ currentPassword: currentPassword(), newPassword: next });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordStatus({
        tone: "ok",
        message: "Password changed. Other sessions were signed out.",
      });
    } catch (error) {
      if (expired(error)) return;
      setPasswordStatus({ tone: "error", message: errorMessage(error) });
      setPasswordContext(issueContext(error, "Changing password"));
    } finally {
      setChangingPassword(false);
    }
  }

  function expired(error: unknown): boolean {
    if (error instanceof ProxyApiError && error.expired) {
      props.onSessionExpired();
      return true;
    }
    return false;
  }

  function reportStatus() {
    const context = statusContext();
    if (context) props.onReportIssue(context);
  }

  function reportDisable() {
    const context = disableContext();
    if (context) props.onReportIssue(context);
  }

  function reportPassword() {
    const context = passwordContext();
    if (context) props.onReportIssue(context);
  }

  return (
    <section class="panel stack">
      <h2>Account & security</h2>

      <section class="subsection stack" aria-labelledby="totpHeading">
        <div class="panel-head">
          <h3 id="totpHeading">Two-factor authentication</h3>
          <Show when={props.totpEnabled}>
            <span class="badge">Enabled</span>
          </Show>
        </div>

        <StatusLine status={status()} onReport={reportStatus} />

        <Show
          when={props.totpEnabled}
          fallback={
            <Show
              when={setup()}
              fallback={
                <div class="stack">
                  <p class="hint">
                    Add a one-time code from an authenticator app when signing in to this admin
                    page.
                  </p>
                  <div class="actions">
                    <button
                      type="button"
                      class="ghost"
                      disabled={starting()}
                      onClick={() => void startSetup()}
                    >
                      Enable 2FA
                    </button>
                  </div>
                </div>
              }
            >
              <div class="stack">
                <p class="hint">
                  Scan this code with your authenticator app, then enter the 6-digit code it shows.
                </p>
                <div class="totp-setup">
                  <div
                    class="qr-code"
                    role="img"
                    aria-label="QR code for two-factor authentication setup"
                    innerHTML={setup()?.svg ?? ""}
                  />
                  <div class="stack">
                    <p class="hint">Can't scan? Enter this secret in the app:</p>
                    <code>{setup()?.secret}</code>
                    <form class="stack" onSubmit={verifyAndEnable}>
                      <label class="field">
                        <span>Verification code</span>
                        <input
                          ref={verifyInput}
                          name="code"
                          type="text"
                          inputmode="numeric"
                          autocomplete="one-time-code"
                          spellcheck={false}
                          maxlength={6}
                          placeholder="123456"
                          value={verifyCode()}
                          onInput={(event) => setVerifyCode(event.currentTarget.value)}
                        />
                      </label>
                      <div class="actions">
                        <button type="submit" disabled={enabling()}>
                          Verify &amp; enable
                        </button>
                        <button type="button" class="ghost" onClick={cancelSetup}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            </Show>
          }
        >
          <div class="stack">
            <p class="hint">
              Two-factor authentication is on. Signing in to this page requires a code; paired
              devices keep working.
            </p>
            <details>
              <summary>Disable two-factor authentication</summary>
              <form class="stack" onSubmit={disableTwoFactor}>
                <label class="field">
                  <span>Current password</span>
                  <input
                    ref={disablePasswordInput}
                    name="password"
                    type="password"
                    autocomplete="current-password"
                    value={disablePassword()}
                    onInput={(event) => setDisablePassword(event.currentTarget.value)}
                  />
                </label>
                <label class="field">
                  <span>Two-factor or recovery code</span>
                  <input
                    name="code"
                    type="text"
                    autocomplete="one-time-code"
                    spellcheck={false}
                    autocapitalize="off"
                    value={disableCode()}
                    onInput={(event) => setDisableCode(event.currentTarget.value)}
                  />
                </label>
                <div class="actions">
                  <button type="submit" class="ghost" disabled={disabling()}>
                    Disable 2FA
                  </button>
                </div>
                <StatusLine status={disableStatus()} onReport={reportDisable} />
              </form>
            </details>
          </div>
        </Show>

        <Show when={recoveryCodes().length > 0}>
          <div class="stack recovery">
            <h3>Save your recovery codes</h3>
            <p class="hint">
              Each code works once if you lose access to your authenticator app. Store them
              somewhere safe now — they will not be shown again.
            </p>
            <div class="recovery-grid">
              <For each={recoveryCodes()}>
                {(code) => <span class="recovery-code">{code}</span>}
              </For>
            </div>
            <div class="actions">
              <button type="button" class="ghost" onClick={() => void copyRecoveryCodes()}>
                {copiedRecovery() ? "Copied" : "Copy recovery codes"}
              </button>
            </div>
          </div>
        </Show>
      </section>

      <details>
        <summary>Change password</summary>
        <form class="stack" onSubmit={submitPassword}>
          <label class="field">
            <span>Current password</span>
            <input
              name="currentPassword"
              type="password"
              autocomplete="current-password"
              value={currentPassword()}
              onInput={(event) => setCurrentPassword(event.currentTarget.value)}
            />
          </label>
          <label class="field">
            <span>New password</span>
            <input
              name="newPassword"
              type="password"
              autocomplete="new-password"
              minlength={12}
              value={newPassword()}
              onInput={(event) => setNewPassword(event.currentTarget.value)}
            />
            <small>At least 12 characters.</small>
          </label>
          <label class="field">
            <span>Confirm new password</span>
            <input
              ref={confirmPasswordInput}
              name="confirmPassword"
              type="password"
              autocomplete="new-password"
              minlength={12}
              value={confirmPassword()}
              onInput={(event) => setConfirmPassword(event.currentTarget.value)}
            />
          </label>
          <div class="actions">
            <button type="submit" disabled={changingPassword()}>
              Change password
            </button>
          </div>
          <StatusLine status={passwordStatus()} onReport={reportPassword} />
        </form>
      </details>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueContext(cause: unknown, action: string): IssueReportContext {
  const context: IssueReportContext = { action, message: errorMessage(cause) };
  if (cause instanceof ProxyApiError) {
    if (cause.code) context.code = cause.code;
    if (cause.status !== undefined) context.status = cause.status;
  }
  return context;
}
