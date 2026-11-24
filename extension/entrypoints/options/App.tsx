import {
  createProxyClient,
  createPublicProxyClient,
  proxyErrorCode,
  proxyErrorMessage,
} from "@remagnet/proxy-client";
import { createSignal, onMount, Show } from "solid-js";
import { browser } from "wxt/browser";
import Wordmark from "../../components/Wordmark";
import { type ConnectionTestResult, sendBackgroundMessage } from "../../lib/messages";
import { claimPairing, parsePairingLink } from "../../lib/pairing";
import { ensureHostPermission } from "../../lib/permissions";
import {
  DEFAULT_SETTINGS,
  getSettings,
  isProxyConfigured,
  type Settings,
  saveSettings,
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
  const [connectedStatus, setConnectedStatus] = createSignal<Status>();

  const [pairingLink, setPairingLink] = createSignal("");
  const [pairingStatus, setPairingStatus] = createSignal<Status>();
  const [pairingBusy, setPairingBusy] = createSignal(false);

  const [manualStatus, setManualStatus] = createSignal<Status>();
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

  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    if (signInBusy() || pairingBusy() || busy()) return;

    const baseUrl = settings().proxyBaseUrl.trim().replace(/\/+$/, "");
    const user = username().trim();
    const pass = password();
    const code = totpCode().trim();

    setSignInBusy(true);
    setSignInStatus(undefined);
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

      const values = normalize({ proxyBaseUrl: baseUrl, proxyToken: data.token });
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
      } catch (error) {
        setConnectedStatus({
          tone: "error",
          message: `Signed in and saved, but the connection test failed: ${errorMessage(error)}`,
        });
      }
    } catch (error) {
      setSignInStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setSignInBusy(false);
    }
  }

  async function pairWithLink() {
    const input = pairingLink().trim();
    if (!input || pairingBusy() || signInBusy() || busy()) return;

    setPairingBusy(true);
    setPairingStatus(undefined);
    try {
      const link = parsePairingLink(input);
      const granted = await ensureHostPermission(link.baseUrl);
      if (!granted) {
        throw new Error(`Host access to ${link.baseUrl} is required to claim the pairing link.`);
      }

      const paired = await claimPairing(link, defaultDeviceName);
      const values = normalize({
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
      } catch (error) {
        setConnectedStatus({
          tone: "error",
          message: `Paired and saved, but the connection test failed: ${errorMessage(error)}`,
        });
      }
    } catch (error) {
      setPairingStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setPairingBusy(false);
    }
  }

  async function testSavedConnection() {
    setBusy(true);
    setConnectedStatus(undefined);
    try {
      const result = await sendBackgroundMessage<ConnectionTestResult>({
        type: "connection:test",
      });
      setConnectedStatus({ tone: "ok", message: connectedMessage(result) });
    } catch (error) {
      setConnectedStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setConnectedStatus(undefined);
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
      const values = normalize({ proxyBaseUrl: settings().proxyBaseUrl, proxyToken: "" });
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
    } finally {
      setBusy(false);
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setManualStatus(undefined);
    try {
      const saved = await persistSettings();
      if (saved) {
        setManualStatus({ tone: "ok", message: "Settings saved." });
      }
    } catch (error) {
      setManualStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function saveAndTestConnection() {
    setBusy(true);
    setManualStatus(undefined);
    try {
      const saved = await persistSettings();
      if (!saved) return;

      const result = await sendBackgroundMessage<ConnectionTestResult>({
        type: "connection:test",
      });
      setManualStatus({ tone: "ok", message: connectedMessage(result) });
    } catch (error) {
      setManualStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function persistSettings(): Promise<Settings | null> {
    const values = normalize({ ...settings(), proxyToken: manualToken() });
    const validationError = validateProxySettings(values);
    if (validationError) {
      setManualStatus({ tone: "error", message: validationError });
      return null;
    }

    const granted = await ensureHostPermission(values.proxyBaseUrl);
    if (!granted) {
      setManualStatus({
        tone: "error",
        message: `Host access is required to talk to the Remagnet Proxy at ${values.proxyBaseUrl}. Grant it and try again.`,
      });
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
                {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
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
              {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
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
              {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
            </Show>
          </section>
        </Show>

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
              {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
            </Show>
          </form>
        </details>
      </Show>

      <footer class="options-footer">
        <span>Remagnet {browser.runtime.getManifest().version}</span>
        <span class="sep" aria-hidden="true">
          ·
        </span>
        <a href="https://remagnet.app" target="_blank" rel="noreferrer">
          Website
        </a>
        <span class="sep" aria-hidden="true">
          ·
        </span>
        <a href="https://github.com/EliCunninghamDev/Remagnet" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <span class="sep" aria-hidden="true">
          ·
        </span>
        <a
          href="https://github.com/EliCunninghamDev/Remagnet/issues"
          target="_blank"
          rel="noreferrer"
        >
          Report an issue
        </a>
        <span class="sep" aria-hidden="true">
          ·
        </span>
        <a href="https://remagnet.app/privacy.html" target="_blank" rel="noreferrer">
          Privacy
        </a>
        <span class="sep" aria-hidden="true">
          ·
        </span>
        <a href="https://ko-fi.com/elijahcunninghamdev" target="_blank" rel="noreferrer">
          Support on Ko-fi
        </a>
      </footer>
    </main>
  );
}

function normalize(values: Settings): Settings {
  return {
    proxyBaseUrl: values.proxyBaseUrl.trim().replace(/\/+$/, ""),
    proxyToken: values.proxyToken.trim(),
  };
}

function connectedMessage(result: ConnectionTestResult): string {
  return `Connected to ${result.clientLabel} ${result.appVersion} via Remagnet Proxy.`;
}

function signedInMessage(result: ConnectionTestResult): string {
  return `Signed in and connected to ${result.clientLabel} ${result.appVersion} via Remagnet Proxy.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
