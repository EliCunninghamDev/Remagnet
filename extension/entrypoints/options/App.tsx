import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { validateArchiveSettings } from "../../lib/archive";
import { getTorrentClientDefinition, TORRENT_CLIENT_LIST } from "../../lib/clients/catalog";
import type { AuthMode, ClientKind } from "../../lib/clients/types";
import {
  type ArchiveTestResult,
  type ConnectionTestResult,
  sendBackgroundMessage,
} from "../../lib/messages";
import { ensureHostPermissions } from "../../lib/permissions";
import { DEFAULT_SETTINGS, getSettings, type Settings, settingsItem } from "../../lib/settings";

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

  const definition = createMemo(() => getTorrentClientDefinition(settings().client));

  onMount(() => {
    void getSettings().then((value) => {
      setSettings(value);
      setLoaded(true);
    });
  });

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
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
        message: `Archive bridge connected to qBittorrent ${result.appVersion} (Web API ${result.webApiVersion}).`,
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
        message: `Host access is required to talk to ${definition().label} or the archive bridge. Grant it and try again.`,
      });
      return null;
    }

    await settingsItem.setValue(values);
    setSettings(values);
    return values;
  }

  return (
    <main class="options">
      <header class="options-header">
        <p class="eyebrow">Remagnet</p>
        <h1>Torrent client</h1>
        <p class="muted">
          Point the extension at your torrent client's Web UI. API keys are preferred; username and
          password login is supported where the client offers it.
        </p>
      </header>

      <Show when={loaded()} fallback={<p class="muted">Loading settings…</p>}>
        <form class="panel stack" onSubmit={save}>
          <label class="field">
            <span>Client</span>
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
            <small>Include the scheme and port. A reverse-proxy path (e.g. /qbt) works too.</small>
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
              <small>{definition().apiKeyHelp ?? "Sent as a Bearer token."}</small>
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
                <small>Blank adds without a category.</small>
              </label>

              <label class="field">
                <span>Tags</span>
                <input
                  type="text"
                  spellcheck={false}
                  placeholder="remagnet, linux"
                  value={settings().defaultTags}
                  onInput={(event) => update("defaultTags", event.currentTarget.value)}
                />
                <small>Comma-separated. Blank adds without tags.</small>
              </label>
            </div>
          </fieldset>

          <fieldset class="field">
            <legend>Archive downloads</legend>
            <p class="muted">
              Optional. Adds a <strong>ZIP</strong> button to completed torrents. The bridge runs
              beside qBittorrent and streams files from its Web API.
            </p>
            <label class="field">
              <span>Bridge URL</span>
              <input
                type="url"
                spellcheck={false}
                placeholder="https://remagnet.example.com"
                value={settings().archiveBaseUrl}
                onInput={(event) => update("archiveBaseUrl", event.currentTarget.value)}
              />
              <small>Leave both archive fields blank to disable ZIP downloads.</small>
            </label>
            <label class="field">
              <span>Bridge token</span>
              <input
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder="BRIDGE_TOKEN"
                value={settings().archiveToken}
                onInput={(event) => update("archiveToken", event.currentTarget.value)}
              />
              <small>
                Send the token over HTTPS. It is stored with the other extension settings.
              </small>
            </label>
            <div class="actions">
              <button
                class="ghost"
                type="button"
                disabled={busy() || !settings().archiveBaseUrl.trim()}
                onClick={() => void testArchive()}
              >
                Save &amp; test archive
              </button>
            </div>
          </fieldset>

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

      <section class="panel note">
        <h2>Magnet links</h2>
        <Show
          when={import.meta.env.FIREFOX}
          fallback={
            <p>
              Use the <strong>Add</strong> button in the popup to paste a magnet link, or
              right-click a magnet link on a page and choose <strong>Add to Remagnet</strong>
              (the item only appears for magnet links). Chrome does not support extension protocol
              handlers, so magnet links cannot open Remagnet automatically.
            </p>
          }
        >
          <p>
            In Firefox, Remagnet registers itself as a <code>magnet:</code> handler. The first time
            you open a magnet link, choose <strong>Remagnet</strong> and tick “Always use this
            application”. You can change the choice later under Firefox Settings → Applications.
          </p>
        </Show>
      </section>

      <section class="panel note">
        <h2>How it works</h2>
        <p>
          The background worker is the only context that talks to the configured client. Popup, add
          and settings pages send typed messages to it; credentials and sessions stay in{" "}
          <code>browser.storage.local</code> and the background worker. Use a dedicated account or
          an API key where possible.
        </p>
      </section>
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
