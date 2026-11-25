import {
  createProxyClient,
  createPublicProxyClient,
  normalizeBaseUrl,
  proxyErrorCode,
  proxyErrorMessage,
  toProxyError,
} from "@remagnet/proxy-client";
import {
  errorMessage,
  type IssueReportContext,
  issueContextFromError,
  PageFooter,
  StatusLine,
} from "@remagnet/ui";
import { createSignal, onMount, Show } from "solid-js";
import { browser } from "wxt/browser";
import IssueReportDialog from "../../components/IssueReportDialog";
import Wordmark from "../../components/Wordmark";
import { type ConnectionTestResult, sendBackgroundMessage } from "../../lib/messages";
import { claimPairing, parsePairingLink } from "../../lib/pairing";
import { ensureHostPermission } from "../../lib/permissions";
import {
  DEFAULT_SETTINGS,
  getSettings,
  isProxyConfigured,
  type PublicSettings,
  type Settings,
  savePublicSettings,
  saveSettings,
  type TorrentFileSurface,
  validateProxyBaseUrl,
  validateProxySettings,
} from "../../lib/settings";

interface Status {
  tone: "ok" | "error" | "warn";
  message: string;
}

const defaultDeviceName = import.meta.env.FIREFOX ? "Firefox" : "Chrome";

export default function App() {
  const [settings, setSettings] = createSignal<Settings>({ ...DEFAULT_SETTINGS });
  const [loaded, setLoaded] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // Sign-in form. The password and second factor only ever live in memory.
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [deviceName, setDeviceName] = createSignal("");
  const [totpCode, setTotpCode] = createSignal("");
  const [totpRequired, setTotpRequired] = createSignal(false);
  const [signInBusy, setSignInBusy] = createSignal(false);
  const [signInStatus, setSignInStatus] = createSignal<Status>();
  const [signInContext, setSignInContext] = createSignal<IssueReportContext>();
  const [connectedStatus, setConnectedStatus] = createSignal<Status>();
  const [connectedContext, setConnectedContext] = createSignal<IssueReportContext>();

  const [pairingLink, setPairingLink] = createSignal("");
  const [pairingStatus, setPairingStatus] = createSignal<Status>();
  const [pairingContext, setPairingContext] = createSignal<IssueReportContext>();
  const [pairingBusy, setPairingBusy] = createSignal(false);

  const [manualStatus, setManualStatus] = createSignal<Status>();
  const [manualContext, setManualContext] = createSignal<IssueReportContext>();

  const [preferenceStatus, setPreferenceStatus] = createSignal<string>();

  // One shared dialog: the trigger passes the context for the status it sits
  // beside, while the footer opens it with no context at all.
  const [reportOpen, setReportOpen] = createSignal(false);
  const [reportContext, setReportContext] = createSignal<IssueReportContext>();
  // Kept separate so typing an unsaved token does not flip the page into the
  // Connected state before the user saves it.
  const [manualToken, setManualToken] = createSignal("");

  onMount(() => {
    void getSettings().then((value) => {
      setSettings(value);
      setManualToken(value.proxyToken);
      setLoaded(true);
    });
  });

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  /** Public preferences save on their own; the encrypted token never moves. */
  async function savePreference(partial: Partial<PublicSettings>) {
    const previous = settings();
    setSettings({ ...previous, ...partial });
    setPreferenceStatus(undefined);
    try {
      setSettings(await savePublicSettings(partial));
    } catch (error) {
      setSettings(previous);
      setPreferenceStatus(errorMessage(error));
    }
  }

  function openReport(context?: IssueReportContext) {
    setReportContext(context);
    setReportOpen(true);
  }

  /** A backend label only: the dialog must never receive a proxy URL. */
  const backendLabel = () => (isProxyConfigured(settings()) ? "Remagnet Proxy" : undefined);

  /**
   * Normalize bare fetch failures into the same guidance the status line
   * shows, then keep the proxy's code/status and backend label for reporting.
   */
  function issueContextFor(cause: unknown, action: string, baseUrl?: string): IssueReportContext {
    const backend = backendLabel();
    return issueContextFromError(
      toProxyError(cause, baseUrl),
      action,
      backend ? { backend } : undefined,
    );
  }

  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    if (signInBusy() || pairingBusy() || busy()) return;

    const baseUrl = normalizeBaseUrl(settings().proxyBaseUrl);
    const user = username().trim();
    const pass = password();
    const code = totpCode().trim();

    setSignInBusy(true);
    setSignInStatus(undefined);
    setSignInContext(undefined);
    try {
      const urlError = validateProxyBaseUrl(baseUrl);
      if (urlError) throw new Error(urlError);
      if (!user) throw new Error("Enter your Remagnet Proxy username.");
      if (!pass) throw new Error("Enter your Remagnet Proxy password.");

      const granted = await ensureHostPermission(baseUrl);
      if (!granted) {
        throw new Error(`Host access to ${baseUrl} is required to sign in.`);
      }

      const { data, error, response } = await createPublicProxyClient(baseUrl).POST(
        "/api/auth/device",
        {
          body: {
            username: user,
            password: pass,
            ...(code ? { totpCode: code } : {}),
            deviceName: deviceName().trim() || defaultDeviceName,
          },
        },
      );

      if (response.status === 401 && proxyErrorCode(error) === "totp_required") {
        setTotpRequired(true);
        setSignInStatus({
          tone: "warn",
          message: "Enter the 6-digit code from your authenticator app or a recovery code.",
        });
        return;
      }

      if (error || !data?.token) throw new Error(proxyErrorMessage(response, error));

      const values = normalize({
        ...settings(),
        proxyBaseUrl: baseUrl,
        proxyToken: data.token,
      });
      const validationError = validateProxySettings(values);
      if (validationError) throw new Error(validationError);

      // Only the minted device token is saved. The password and second factor
      // are cleared from state so they do not linger in the page.
      await saveSettings(values);
      setSettings(values);
      setManualToken(values.proxyToken);
      setPassword("");
      setTotpCode("");
      setTotpRequired(false);
      setSignInStatus(undefined);

      try {
        const result = await sendBackgroundMessage<ConnectionTestResult>({
          type: "connection:test",
        });
        setConnectedStatus({ tone: "ok", message: signedInMessage(result) });
        setConnectedContext(undefined);
      } catch (error) {
        setConnectedStatus({
          tone: "error",
          message: `Signed in and saved, but the connection test failed: ${errorMessage(error)}`,
        });
        setConnectedContext(issueContextFor(error, "Testing connection after sign-in"));
      }
    } catch (error) {
      // Normalize transport failures so the user never sees a bare
      // "Failed to fetch" from the browser.
      const normalized = toProxyError(error, baseUrl);
      setSignInStatus({ tone: "error", message: normalized.message });
      setSignInContext(issueContextFor(error, "Signing in", baseUrl));
    } finally {
      setSignInBusy(false);
    }
  }

  async function pairWithLink() {
    const input = pairingLink().trim();
    if (!input || pairingBusy() || signInBusy() || busy()) return;

    setPairingBusy(true);
    setPairingStatus(undefined);
    setPairingContext(undefined);
    try {
      const link = parsePairingLink(input);
      const granted = await ensureHostPermission(link.baseUrl);
      if (!granted) {
        throw new Error(`Host access to ${link.baseUrl} is required to claim the pairing link.`);
      }

      const paired = await claimPairing(link, defaultDeviceName);
      const values = normalize({
        ...settings(),
        proxyBaseUrl: paired.proxyBaseUrl,
        proxyToken: paired.proxyToken,
      });
      const validationError = validateProxySettings(values);
      if (validationError) throw new Error(validationError);

      // Pairing is the whole setup: persist immediately, then check that the
      // proxy can reach the torrent client before claiming success.
      await saveSettings(values);
      setSettings(values);
      setManualToken(values.proxyToken);
      setPairingLink("");
      setPassword("");
      setTotpCode("");
      setTotpRequired(false);
      setSignInStatus(undefined);

      try {
        const result = await sendBackgroundMessage<ConnectionTestResult>({
          type: "connection:test",
        });
        setConnectedStatus({
          tone: "ok",
          message: `Paired and connected to ${result.clientLabel} ${result.appVersion} via Remagnet Proxy.`,
        });
        setConnectedContext(undefined);
      } catch (error) {
        setConnectedStatus({
          tone: "error",
          message: `Paired and saved, but the connection test failed: ${errorMessage(error)}`,
        });
        setConnectedContext(issueContextFor(error, "Testing connection after pairing"));
      }
    } catch (error) {
      setPairingStatus({ tone: "error", message: errorMessage(error) });
      setPairingContext(issueContextFor(error, "Pairing with a link"));
    } finally {
      setPairingBusy(false);
    }
  }

  async function testSavedConnection() {
    setBusy(true);
    setConnectedStatus(undefined);
    setConnectedContext(undefined);
    try {
      const result = await sendBackgroundMessage<ConnectionTestResult>({
        type: "connection:test",
      });
      setConnectedStatus({ tone: "ok", message: connectedMessage(result) });
    } catch (error) {
      setConnectedStatus({ tone: "error", message: errorMessage(error) });
      setConnectedContext(issueContextFor(error, "Testing connection"));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setConnectedStatus(undefined);
    setConnectedContext(undefined);
    setSignInStatus(undefined);
    try {
      // Best effort: revoke this device on the proxy before dropping the token.
      // Offline proxies and already-revoked tokens must not block a local
      // disconnect, so every failure is deliberately ignored.
      const current = settings();
      if (current.proxyBaseUrl && current.proxyToken) {
        try {
          await createProxyClient({
            baseUrl: current.proxyBaseUrl,
            token: current.proxyToken,
          }).DELETE("/api/devices/current");
        } catch {
          // The token stays only long enough to clear it below.
        }
      }

      // Keep the proxy URL so signing back in only needs credentials.
      const values = normalize({
        ...settings(),
        proxyBaseUrl: settings().proxyBaseUrl,
        proxyToken: "",
      });
      await saveSettings(values);
      setSettings(values);
      setManualToken("");
      setPassword("");
      setTotpCode("");
      setTotpRequired(false);
      setSignInStatus({
        tone: "ok",
        message: "Disconnected. The proxy URL is still filled in for your next sign-in.",
      });
    } catch (error) {
      setConnectedStatus({ tone: "error", message: errorMessage(error) });
      setConnectedContext(issueContextFor(error, "Disconnecting"));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setManualStatus(undefined);
    setManualContext(undefined);
    try {
      const saved = await persistSettings();
      if (saved) {
        setManualStatus({ tone: "ok", message: "Settings saved." });
      }
    } catch (error) {
      setManualStatus({ tone: "error", message: errorMessage(error) });
      setManualContext(issueContextFor(error, "Saving settings"));
    } finally {
      setBusy(false);
    }
  }

  async function saveAndTestConnection() {
    setBusy(true);
    setManualStatus(undefined);
    setManualContext(undefined);
    try {
      const saved = await persistSettings();
      if (!saved) return;

      const result = await sendBackgroundMessage<ConnectionTestResult>({
        type: "connection:test",
      });
      setManualStatus({ tone: "ok", message: connectedMessage(result) });
    } catch (error) {
      setManualStatus({ tone: "error", message: errorMessage(error) });
      setManualContext(issueContextFor(error, "Testing connection after saving"));
    } finally {
      setBusy(false);
    }
  }

  async function persistSettings(): Promise<Settings | null> {
    const values = normalize({ ...settings(), proxyToken: manualToken() });
    const validationError = validateProxySettings(values);
    if (validationError) {
      setManualStatus({ tone: "error", message: validationError });
      setManualContext({ action: "Saving settings", message: validationError });
      return null;
    }

    const granted = await ensureHostPermission(values.proxyBaseUrl);
    if (!granted) {
      const message = `Host access is required to talk to the Remagnet Proxy at ${values.proxyBaseUrl}. Grant it and try again.`;
      setManualStatus({ tone: "error", message });
      setManualContext({ action: "Saving settings", message });
      return null;
    }

    await saveSettings(values);
    setSettings(values);
    setManualToken(values.proxyToken);
    return values;
  }

  return (
    <main class="options">
      <header class="options-header">
        <Wordmark as="p" size="lg" surface="Settings" />
      </header>

      <Show when={loaded()} fallback={<p class="muted">Loading settings…</p>}>
        <Show
          when={isProxyConfigured(settings())}
          fallback={
            <form class="panel stack" onSubmit={signIn}>
              <h2>Sign in to Remagnet Proxy</h2>

              <label class="field">
                <span>Proxy URL</span>
                <input
                  type="url"
                  autocomplete="url"
                  spellcheck={false}
                  placeholder="https://remagnet.example.com"
                  value={settings().proxyBaseUrl}
                  onInput={(event) => update("proxyBaseUrl", event.currentTarget.value)}
                />
                <small>The address shown on your Remagnet Proxy page.</small>
              </label>

              <label class="field">
                <span>Username</span>
                <input
                  type="text"
                  autocomplete="username"
                  spellcheck={false}
                  value={username()}
                  onInput={(event) => setUsername(event.currentTarget.value)}
                />
              </label>

              <label class="field">
                <span>Password</span>
                <input
                  type="password"
                  autocomplete="current-password"
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                />
              </label>

              <label class="field">
                <span>Device name (optional)</span>
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={defaultDeviceName}
                  value={deviceName()}
                  onInput={(event) => setDeviceName(event.currentTarget.value)}
                />
                <small>Shown in the proxy's device list so you can revoke it later.</small>
              </label>

              <Show when={totpRequired()}>
                <label class="field">
                  <span>Two-factor code</span>
                  <input
                    type="text"
                    autocomplete="one-time-code"
                    spellcheck={false}
                    placeholder="123456 or recovery code"
                    value={totpCode()}
                    onInput={(event) => setTotpCode(event.currentTarget.value)}
                  />
                  <small>6-digit authenticator code or a recovery code.</small>
                </label>
              </Show>

              <p class="muted">
                Use the administrator credentials for your Remagnet Proxy. Your password is only
                used to mint a device token and is never stored. If two-factor authentication is
                enabled, you will be asked for a code.
              </p>

              <div class="actions">
                <button type="submit" disabled={busy() || pairingBusy() || signInBusy()}>
                  {signInBusy() ? "Signing in…" : "Sign in"}
                </button>
              </div>

              <Show when={signInStatus()}>
                {(current) => (
                  <StatusLine
                    status={current()}
                    onReport={
                      current().tone === "error" ? () => openReport(signInContext()) : undefined
                    }
                  />
                )}
              </Show>
            </form>
          }
        >
          <section class="panel stack">
            <h2>Connected</h2>
            <div class="field">
              <span>Proxy URL</span>
              <span class="mono">{settings().proxyBaseUrl}</span>
            </div>
            <div class="actions">
              <button
                type="button"
                disabled={busy() || signInBusy() || pairingBusy()}
                onClick={() => void testSavedConnection()}
              >
                {busy() ? "Testing…" : "Test connection"}
              </button>
              <button
                class="ghost"
                type="button"
                disabled={busy() || signInBusy() || pairingBusy()}
                onClick={() => void disconnect()}
              >
                Disconnect
              </button>
            </div>
            <Show when={connectedStatus()}>
              {(current) => (
                <StatusLine
                  status={current()}
                  onReport={
                    current().tone === "error" ? () => openReport(connectedContext()) : undefined
                  }
                />
              )}
            </Show>
          </section>
        </Show>

        <Show when={!isProxyConfigured(settings())}>
          <section class="panel stack">
            <h2>Pair with a link</h2>
            <label class="field">
              <span>Pairing link</span>
              <div class="field-inline">
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="remagnet://pair?…"
                  value={pairingLink()}
                  onInput={(event) => setPairingLink(event.currentTarget.value)}
                />
                <button
                  type="button"
                  disabled={busy() || pairingBusy() || signInBusy() || !pairingLink().trim()}
                  onClick={() => void pairWithLink()}
                >
                  {pairingBusy() ? "Pairing…" : "Pair"}
                </button>
              </div>
              <small>
                Pairing links from your Remagnet Proxy page connect without a password or 2FA code.
                Open the page, choose Show QR code or Copy pairing link, then paste it here. The
                link fills in the proxy URL and device token and saves them for you.
              </small>
            </label>

            <Show when={pairingStatus()}>
              {(current) => (
                <StatusLine
                  status={current()}
                  onReport={
                    current().tone === "error" ? () => openReport(pairingContext()) : undefined
                  }
                />
              )}
            </Show>
          </section>
        </Show>

        <section class="panel stack">
          <h2>Preferences</h2>

          <label class="field">
            <span>.torrent file uploader</span>
            <select
              value={settings().torrentFileSurface}
              onChange={(event) =>
                void savePreference({
                  torrentFileSurface: event.currentTarget.value as TorrentFileSurface,
                })
              }
            >
              <option value="popup-window">Popup window</option>
              <option value="tab">Browser tab</option>
            </select>
            <small>
              Where Remagnet opens the file uploader when choosing a .torrent file from the toolbar
              popover.
            </small>
          </label>

          <div class="field">
            <label class="check">
              <input
                type="checkbox"
                checked={settings().downloadNotifications}
                onChange={(event) =>
                  void savePreference({ downloadNotifications: event.currentTarget.checked })
                }
              />
              Notify when downloads complete
            </label>
            <small>Show a browser notification when a Remagnet torrent finishes downloading.</small>
          </div>

          <Show when={preferenceStatus()}>
            {(message) => <p class="status error">Could not save preference: {message()}</p>}
          </Show>
        </section>

        <details class="panel stack">
          <summary>Manual device token</summary>
          <form class="stack" onSubmit={save}>
            <p class="muted">
              For advanced or automated setups. Most people should sign in or pair with a link
              instead.
            </p>

            <label class="field">
              <span>Proxy URL</span>
              <input
                type="url"
                autocomplete="url"
                spellcheck={false}
                placeholder="https://remagnet.example.com"
                value={settings().proxyBaseUrl}
                onInput={(event) => update("proxyBaseUrl", event.currentTarget.value)}
              />
            </label>

            <label class="field">
              <span>Device token</span>
              <input
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder="rmg_…"
                value={manualToken()}
                onInput={(event) => setManualToken(event.currentTarget.value)}
              />
              <small>
                A per-device token from your Remagnet Proxy. It is encrypted before it is saved in
                extension storage.
              </small>
            </label>

            <div class="actions">
              <button type="submit" disabled={busy() || pairingBusy() || signInBusy()}>
                {busy() ? "Saving…" : "Save"}
              </button>
              <button
                class="ghost"
                type="button"
                disabled={busy() || pairingBusy() || signInBusy()}
                onClick={() => void saveAndTestConnection()}
              >
                Save &amp; test
              </button>
            </div>

            <Show when={manualStatus()}>
              {(current) => (
                <StatusLine
                  status={current()}
                  onReport={
                    current().tone === "error" ? () => openReport(manualContext()) : undefined
                  }
                />
              )}
            </Show>
          </form>
        </details>
      </Show>

      <PageFooter
        class="options-footer"
        label="Remagnet"
        version={browser.runtime.getManifest().version}
        onReport={() => openReport()}
      />

      <IssueReportDialog
        open={reportOpen()}
        context={reportContext()}
        backend={backendLabel()}
        onClose={() => setReportOpen(false)}
      />
    </main>
  );
}

function normalize(values: Settings): Settings {
  return {
    proxyBaseUrl: normalizeBaseUrl(values.proxyBaseUrl),
    proxyToken: values.proxyToken.trim(),
    torrentFileSurface: values.torrentFileSurface,
    downloadNotifications: values.downloadNotifications,
  };
}

function connectedMessage(result: ConnectionTestResult): string {
  return `Connected to ${result.clientLabel} ${result.appVersion} via Remagnet Proxy.`;
}

function signedInMessage(result: ConnectionTestResult): string {
  return `Signed in and connected to ${result.clientLabel} ${result.appVersion} via Remagnet Proxy.`;
}
