import { createSignal, onMount, Show } from "solid-js";
import { browser } from "wxt/browser";
import Wordmark from "../../components/Wordmark";
import { type ConnectionTestResult, sendBackgroundMessage } from "../../lib/messages";
import { claimPairing, parsePairingLink } from "../../lib/pairing";
import { ensureHostPermission } from "../../lib/permissions";
import {
  DEFAULT_SETTINGS,
  getSettings,
  type Settings,
  saveSettings,
  validateProxySettings,
} from "../../lib/settings";

interface Status {
  tone: "ok" | "error";
  message: string;
}

export default function App() {
  const [settings, setSettings] = createSignal<Settings>({ ...DEFAULT_SETTINGS });
  const [loaded, setLoaded] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [manualStatus, setManualStatus] = createSignal<Status>();
  const [pairingLink, setPairingLink] = createSignal("");
  const [pairingStatus, setPairingStatus] = createSignal<Status>();
  const [pairingBusy, setPairingBusy] = createSignal(false);

  onMount(() => {
    void getSettings().then((value) => {
      setSettings(value);
      setLoaded(true);
    });
  });

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function pairWithLink() {
    const input = pairingLink().trim();
    if (!input || pairingBusy() || busy()) return;

    setPairingBusy(true);
    setPairingStatus(undefined);
    try {
      const link = parsePairingLink(input);
      const granted = await ensureHostPermission(link.baseUrl);
      if (!granted) {
        throw new Error(`Host access to ${link.baseUrl} is required to claim the pairing link.`);
      }

      const paired = await claimPairing(link);
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
      setPairingLink("");

      try {
        const result = await sendBackgroundMessage<ConnectionTestResult>({
          type: "connection:test",
        });
        setPairingStatus({
          tone: "ok",
          message: `Paired and connected to ${result.clientLabel} ${result.appVersion} via Remagnet Proxy.`,
        });
      } catch (error) {
        setPairingStatus({
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

  async function testConnection() {
    setBusy(true);
    setManualStatus(undefined);
    try {
      const saved = await persistSettings();
      if (!saved) return;

      const result = await sendBackgroundMessage<ConnectionTestResult>({
        type: "connection:test",
      });
      setManualStatus({
        tone: "ok",
        message: `Connected to ${result.clientLabel} ${result.appVersion} via Remagnet Proxy.`,
      });
    } catch (error) {
      setManualStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function persistSettings(): Promise<Settings | null> {
    const values = normalize(settings());
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
    return values;
  }

  return (
    <main class="options">
      <header class="options-header">
        <Wordmark as="p" size="lg" surface="Settings" />
      </header>

      <Show when={loaded()} fallback={<p class="muted">Loading settings…</p>}>
        <section class="panel stack">
          <h2>Pair with Remagnet Proxy</h2>
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
                disabled={busy() || pairingBusy() || !pairingLink().trim()}
                onClick={() => void pairWithLink()}
              >
                {pairingBusy() ? "Pairing…" : "Pair"}
              </button>
            </div>
            <small>
              Open your Remagnet Proxy page, choose Show QR code or Copy pairing link, then paste it
              here. The link fills in the proxy URL and token and saves them for you.
            </small>
          </label>

          <Show when={pairingStatus()}>
            {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
          </Show>
        </section>

        <form class="panel stack" onSubmit={save}>
          <h2>Manual connection</h2>
          <label class="field">
            <span>Proxy URL</span>
            <input
              type="url"
              spellcheck={false}
              placeholder="https://remagnet.example.com"
              value={settings().proxyBaseUrl}
              onInput={(event) => update("proxyBaseUrl", event.currentTarget.value)}
            />
            <small>
              The address of your Remagnet Proxy. The extension only needs host access to this
              origin.
            </small>
          </label>

          <label class="field">
            <span>Token</span>
            <input
              type="password"
              autocomplete="off"
              spellcheck={false}
              placeholder="BRIDGE_TOKEN"
              value={settings().proxyToken}
              onInput={(event) => update("proxyToken", event.currentTarget.value)}
            />
            <small>Copy the token from your Remagnet Proxy settings page.</small>
          </label>

          <div class="actions">
            <button type="submit" disabled={busy() || pairingBusy()}>
              {busy() ? "Saving…" : "Save"}
            </button>
            <button
              class="ghost"
              type="button"
              disabled={busy() || pairingBusy()}
              onClick={() => void testConnection()}
            >
              Save &amp; test connection
            </button>
          </div>

          <Show when={manualStatus()}>
            {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
          </Show>
        </form>
      </Show>

      <footer class="options-footer">
        <span>Remagnet {browser.runtime.getManifest().version}</span>
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
        <a
          href="https://github.com/EliCunninghamDev/Remagnet/blob/main/PRIVACY.md"
          target="_blank"
          rel="noreferrer"
        >
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
