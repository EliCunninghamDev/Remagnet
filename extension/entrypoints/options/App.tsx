import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { browser } from "wxt/browser";
import Wordmark from "../../components/Wordmark";
import { validateArchiveSettings } from "../../lib/archive";
import { getTorrentClientDefinition, TORRENT_CLIENT_LIST } from "../../lib/clients/catalog";
import type { AuthMode, ClientKind } from "../../lib/clients/types";
import {
  type ArchiveTestResult,
  type ConnectionTestResult,
  sendBackgroundMessage,
} from "../../lib/messages";
import { claimPairing, parsePairingLink } from "../../lib/pairing";
import { ensureHostPermissions } from "../../lib/permissions";
import { DEFAULT_SETTINGS, getSettings, type Settings, saveSettings } from "../../lib/settings";

interface Status {
  tone: "ok" | "error";
  message: string;
}

const AUTH_MODE_LABELS: Record<AuthMode, string> = {
  apiKey: "API key",
  password: "Username & password",
};

export default function App() {
  const [settings, setSettings] = createSignal<Settings>({ ...DEFAULT_SETTINGS });
  const [loaded, setLoaded] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<Status>();
  const [pairingCode, setPairingCode] = createSignal("");
  const [pairingBusy, setPairingBusy] = createSignal(false);

  const definition = createMemo(() => getTorrentClientDefinition(settings().client));
  const proxyConfigured = createMemo(() =>
    Boolean(settings().archiveBaseUrl.trim() && settings().archiveToken.trim()),
  );

  onMount(() => {
    void getSettings().then((value) => {
      setSettings(value);
      setLoaded(true);
    });
  });

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function pairWithCode() {
    const input = pairingCode().trim();
    if (!input || pairingBusy()) return;

    setPairingBusy(true);
    setStatus(undefined);
    try {
      const link = parsePairingLink(input);
      const granted = await ensureHostPermissions([link.baseUrl]);
      if (!granted) {
        throw new Error(`Host access to ${link.baseUrl} is required to claim the pairing code.`);
      }

      const paired = await claimPairing(link);
      setSettings((current) => ({
        ...current,
        baseUrl: paired.qbitBaseUrl,
        authMode: paired.authMode,
        apiKey: paired.apiKey ?? "",
        username: paired.username ?? current.username,
        password: paired.password ?? "",
        archiveBaseUrl: paired.proxyBaseUrl,
        archiveToken: paired.proxyToken,
      }));
      setPairingCode("");
      setStatus({
        tone: "ok",
        message: "Paired with Remagnet Proxy. Review the values, then save.",
      });
    } catch (error) {
      setStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setPairingBusy(false);
    }
  }

  function selectClient(kind: ClientKind) {
    const next = getTorrentClientDefinition(kind);
    setSettings((current) => ({
      ...current,
      client: kind,
      baseUrl: current.baseUrl.trim() ? current.baseUrl : next.defaultBaseUrl,
      authMode: next.authModes.includes(current.authMode)
        ? current.authMode
        : (next.authModes[0] ?? "apiKey"),
    }));
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(undefined);
    try {
      const saved = await persistSettings();
      if (saved) {
        setStatus({ tone: "ok", message: "Settings saved." });
      }
    } catch (error) {
      setStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setStatus(undefined);
    try {
      const saved = await persistSettings();
      if (!saved) return;

      const result = await sendBackgroundMessage<ConnectionTestResult>({
        type: "connection:test",
      });
      const auth = AUTH_MODE_LABELS[result.authMode].toLowerCase();
      const api = result.apiVersion ? `, Web API ${result.apiVersion}` : "";
      setStatus({
        tone: "ok",
        message: `Connected to ${result.clientLabel} ${result.version} (${auth}${api}).`,
      });
    } catch (error) {
      setStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function testArchive() {
    setBusy(true);
    setStatus(undefined);
    try {
      const saved = await persistSettings();
      if (!saved) return;

      const result = await sendBackgroundMessage<ArchiveTestResult>({ type: "archive:test" });
      setStatus({
        tone: "ok",
        message: `Remagnet Proxy connected to qBittorrent ${result.appVersion} (Web API ${result.webApiVersion}).`,
      });
    } catch (error) {
      setStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function persistSettings(): Promise<Settings | null> {
    const values = normalize(settings());
    const validationError = getTorrentClientDefinition(values.client).validate(values);
    if (validationError) {
      setStatus({ tone: "error", message: validationError });
      return null;
    }

    const archiveError = validateArchiveSettings(values);
    if (archiveError) {
      setStatus({ tone: "error", message: archiveError });
      return null;
    }

    const granted = await ensureHostPermissions([values.baseUrl, values.archiveBaseUrl]);
    if (!granted) {
      setStatus({
        tone: "error",
        message: `Host access is required to talk to ${definition().label} or the Remagnet Proxy. Grant it and try again.`,
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
        <form class="stack" onSubmit={save}>
          <section class="panel stack">
            <h2>Client</h2>
            <label class="field">
              <span class="sr-only">Client</span>
              <select
                value={settings().client}
                onChange={(event) => selectClient(event.currentTarget.value as ClientKind)}
              >
                <For each={TORRENT_CLIENT_LIST}>
                  {(client) => <option value={client.kind}>{client.label}</option>}
                </For>
              </select>
              <small>{definition().description}</small>
            </label>

            <label class="field">
              <span>Web UI URL</span>
              <input
                type="url"
                required
                spellcheck={false}
                placeholder={definition().defaultBaseUrl}
                value={settings().baseUrl}
                onInput={(event) => update("baseUrl", event.currentTarget.value)}
              />
              <small>
                Include the scheme and port. A reverse-proxy path (e.g. /qbt) works too.
              </small>
            </label>

            <fieldset class="field">
              <legend>Authentication</legend>
              <div class="radio-row">
                <For each={definition().authModes}>
                  {(mode, index) => (
                    <label class="radio">
                      <input
                        type="radio"
                        name="authMode"
                        checked={settings().authMode === mode}
                        onChange={() => update("authMode", mode)}
                      />
                      <span>
                        {AUTH_MODE_LABELS[mode]}
                        <Show when={index() === 0}>
                          <span class="badge">recommended</span>
                        </Show>
                      </span>
                    </label>
                  )}
                </For>
              </div>
            </fieldset>

            <Show
              when={settings().authMode === "apiKey"}
              fallback={
                <div class="stack-tight">
                  <label class="field">
                    <span>Username</span>
                    <input
                      type="text"
                      autocomplete="username"
                      spellcheck={false}
                      value={settings().username}
                      onInput={(event) => update("username", event.currentTarget.value)}
                    />
                  </label>
                  <label class="field">
                    <span>Password</span>
                    <input
                      type="password"
                      autocomplete="current-password"
                      value={settings().password}
                      onInput={(event) => update("password", event.currentTarget.value)}
                    />
                  </label>
                </div>
              }
            >
              <label class="field">
                <span>API key</span>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={definition().apiKeyPlaceholder ?? "API key"}
                  value={settings().apiKey}
                  onInput={(event) => update("apiKey", event.currentTarget.value)}
                />
                <Show when={!settings().apiKey.trim()}>
                  <small>{definition().apiKeyHelp}</small>
                </Show>
              </label>
            </Show>

            <fieldset class="field">
              <legend>Magnet defaults</legend>
              <div class="field-row">
                <label class="field">
                  <span>Category</span>
                  <input
                    type="text"
                    spellcheck={false}
                    placeholder="remagnet"
                    value={settings().defaultCategory}
                    onInput={(event) => update("defaultCategory", event.currentTarget.value)}
                  />
                </label>

                <label class="field">
                  <span>Tags - Comma separated</span>
                  <input
                    type="text"
                    spellcheck={false}
                    placeholder="remagnet, linux"
                    value={settings().defaultTags}
                    onInput={(event) => update("defaultTags", event.currentTarget.value)}
                  />
                </label>
              </div>
            </fieldset>
          </section>

          <section class="panel stack">
            <h2>Remagnet Proxy</h2>
            <label class="field">
              <span>URL</span>
              <input
                type="url"
                spellcheck={false}
                placeholder="https://remagnet.example.com"
                value={settings().archiveBaseUrl}
                onInput={(event) => update("archiveBaseUrl", event.currentTarget.value)}
              />
              <small>Leave this and the token blank to disable ZIP downloads.</small>
            </label>
            <label class="field">
              <span>Token</span>
              <div class="field-inline">
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="BRIDGE_TOKEN"
                  value={settings().archiveToken}
                  onInput={(event) => update("archiveToken", event.currentTarget.value)}
                />
                <button
                  class="ghost"
                  type="button"
                  aria-label="Test Remagnet Proxy"
                  disabled={busy() || !settings().archiveBaseUrl.trim()}
                  onClick={() => void testArchive()}
                >
                  Test
                </button>
              </div>
            </label>
            <label class="field">
              <span>Pairing code</span>
              <div class="field-inline">
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="remagnet://pair?…"
                  value={pairingCode()}
                  onInput={(event) => setPairingCode(event.currentTarget.value)}
                />
                <button
                  class="ghost"
                  type="button"
                  disabled={busy() || pairingBusy() || !pairingCode().trim()}
                  onClick={() => void pairWithCode()}
                >
                  {pairingBusy() ? "Pairing…" : "Pair"}
                </button>
              </div>
              <small>
                Open your Remagnet Proxy page, choose Show QR code, then Copy link and paste it
                here. It fills these fields from the proxy's saved connection.
              </small>
            </label>
          </section>

          <section class="panel stack">
            <h2>Android</h2>
            <p class="hint">
              Pair the phone from your Remagnet Proxy page. Open the proxy, choose Show QR code, and
              scan it with the app. The phone receives the proxy's saved qBittorrent connection and
              token; the code rotates every minute and works once.
            </p>
            <Show
              when={proxyConfigured()}
              fallback={
                <small>Configure Remagnet Proxy above, then open its page to pair a phone.</small>
              }
            >
              <div class="actions">
                <a
                  class="button-link"
                  href={settings().archiveBaseUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Remagnet Proxy page
                </a>
              </div>
            </Show>
          </section>

          <div class="actions">
            <button type="submit" disabled={busy()}>
              {busy() ? "Saving…" : "Save"}
            </button>
            <button
              class="ghost"
              type="button"
              disabled={busy()}
              onClick={() => void testConnection()}
            >
              Save &amp; test connection
            </button>
          </div>

          <Show when={status()}>
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
    ...values,
    baseUrl: values.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: values.apiKey.trim(),
    username: values.username.trim(),
    defaultCategory: values.defaultCategory.trim(),
    defaultTags: values.defaultTags.trim(),
    archiveBaseUrl: values.archiveBaseUrl.trim().replace(/\/+$/, ""),
    archiveToken: values.archiveToken.trim(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
