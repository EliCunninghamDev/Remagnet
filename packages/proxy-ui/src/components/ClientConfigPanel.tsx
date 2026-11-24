import type { IssueReportContext } from "@remagnet/ui";
import { createSignal, onMount, Show } from "solid-js";
import {
  type ConfigUpdate,
  type ConnectionHealth,
  fetchConfig,
  fetchHealth,
  ProxyApiError,
  type PublicConfig,
  saveConfig,
} from "../api";
import StatusLine, { type StatusMessage } from "./StatusLine";

type ClientKind = "qbittorrent" | "transmission";

export interface ClientConfigPanelProps {
  /** App-provided config so the panel does not fetch it twice on first paint. */
  initialConfig?: PublicConfig | null;
  /** Called with the latest public config after a load or a successful save. */
  onConfigChange?: (config: PublicConfig) => void;
  /** Called after a successful save so the dashboard can refresh dependent data. */
  onConfigSaved?: () => void;
  /** Called with the connection details after a successful test. */
  onHealthChange?: (health: ConnectionHealth) => void;
  /** Called with redacted diagnostics when the user asks to report a failure. */
  onReportIssue?: (context: IssueReportContext) => void;
}

const QBIT_LOCK_FIELDS = [
  "clientKind",
  "baseUrl",
  "apiKey",
  "username",
  "password",
  "downloadsDir",
  "clientDownloadsDir",
  "defaultCategory",
  "defaultTags",
];

const TRANSMISSION_LOCK_FIELDS = [
  "clientKind",
  "baseUrl",
  "username",
  "password",
  "downloadsDir",
  "clientDownloadsDir",
  "defaultTags",
];

/** Torrent client connection settings shared by qBittorrent and Transmission. */
export default function ClientConfigPanel(props: ClientConfigPanelProps) {
  const [clientKind, setClientKind] = createSignal<ClientKind>("qbittorrent");

  const [qbitUrl, setQbitUrl] = createSignal("");
  const [apiKey, setApiKey] = createSignal("");
  const [clearApiKey, setClearApiKey] = createSignal(false);
  const [qbitUsername, setQbitUsername] = createSignal("");
  const [qbitPassword, setQbitPassword] = createSignal("");
  const [clearQbitPassword, setClearQbitPassword] = createSignal(false);
  const [qbitDownloadsDir, setQbitDownloadsDir] = createSignal("");
  const [qbitClientDownloadsDir, setQbitClientDownloadsDir] = createSignal("");

  const [transmissionUrl, setTransmissionUrl] = createSignal("");
  const [transmissionUsername, setTransmissionUsername] = createSignal("");
  const [transmissionPassword, setTransmissionPassword] = createSignal("");
  const [clearTransmissionPassword, setClearTransmissionPassword] = createSignal(false);
  const [transmissionDownloadsDir, setTransmissionDownloadsDir] = createSignal("");
  const [transmissionClientDownloadsDir, setTransmissionClientDownloadsDir] = createSignal("");

  const [category, setCategory] = createSignal("");
  const [tags, setTags] = createSignal("");

  const [hasApiKey, setHasApiKey] = createSignal(false);
  const [hasPassword, setHasPassword] = createSignal(false);

  const [loadedConfig, setLoadedConfig] = createSignal<PublicConfig>();
  const [saving, setSaving] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [status, setStatus] = createSignal<StatusMessage>({
    tone: "muted",
    message: "Loading saved settings…",
  });
  const [statusContext, setStatusContext] = createSignal<IssueReportContext>();

  const transmission = () => clientKind() === "transmission";
  const envLocked = () => new Set(loadedConfig()?.envLocked ?? []);
  const isLocked = (field: string) => envLocked().has(field);
  const allFieldsLocked = () =>
    (transmission() ? TRANSMISSION_LOCK_FIELDS : QBIT_LOCK_FIELDS).every((field) =>
      isLocked(field),
    );

  onMount(() => {
    if (props.initialConfig) {
      applyConfig(props.initialConfig);
      setStatus({
        tone: "muted",
        message: "Saved secrets are never sent back to this page.",
      });
      return;
    }
    void loadConfig();
  });

  function splitTags(value: string): string[] {
    const seen = new Set<string>();
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => {
        if (!tag || seen.has(tag)) return false;
        seen.add(tag);
        return true;
      });
  }

  function applyConfig(config: PublicConfig) {
    setLoadedConfig(config);

    const kind: ClientKind = config.clientKind === "transmission" ? "transmission" : "qbittorrent";
    setClientKind(kind);

    const baseUrl = config.baseUrl || config.qbitBaseUrl || "";
    setQbitUrl(baseUrl);
    setTransmissionUrl(baseUrl);

    const username = config.username || config.qbitUsername || "";
    setQbitUsername(username);
    setTransmissionUsername(username);

    const downloadsDir = config.downloadsDir || "";
    setQbitDownloadsDir(downloadsDir);
    setTransmissionDownloadsDir(downloadsDir);

    const clientDownloadsDir = config.clientDownloadsDir || "";
    setQbitClientDownloadsDir(clientDownloadsDir);
    setTransmissionClientDownloadsDir(clientDownloadsDir);

    setCategory(config.defaultCategory || "");
    setTags((config.defaultTags || []).join(", "));

    // Saved secrets never travel back through the API; clear the drafts so a
    // blank field really means "keep what is stored".
    setApiKey("");
    setQbitPassword("");
    setTransmissionPassword("");
    setClearApiKey(false);
    setClearQbitPassword(false);
    setClearTransmissionPassword(false);

    setHasApiKey(config.hasApiKey);
    setHasPassword(config.hasPassword);
  }

  async function loadConfig() {
    setStatus({ tone: "muted", message: "Loading saved settings…" });
    setStatusContext(undefined);
    try {
      const config = await fetchConfig();
      applyConfig(config);
      props.onConfigChange?.(config);
      setStatus({
        tone: "muted",
        message: "Saved secrets are never sent back to this page.",
      });
    } catch (error) {
      if (isExpired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContext(error, "Loading settings"));
    }
  }

  function payload(): ConfigUpdate {
    const body: ConfigUpdate = {};
    const kind: ClientKind = transmission() ? "transmission" : "qbittorrent";

    if (!isLocked("clientKind")) body.clientKind = kind;

    if (!isLocked("baseUrl")) {
      body.baseUrl = (transmission() ? transmissionUrl() : qbitUrl()).trim();
    }
    if (!isLocked("username")) {
      body.username = (transmission() ? transmissionUsername() : qbitUsername()).trim();
    }
    if (!isLocked("downloadsDir")) {
      body.downloadsDir = (transmission() ? transmissionDownloadsDir() : qbitDownloadsDir()).trim();
    }
    if (!isLocked("clientDownloadsDir")) {
      body.clientDownloadsDir = (
        transmission() ? transmissionClientDownloadsDir() : qbitClientDownloadsDir()
      ).trim();
    }
    if (!isLocked("defaultCategory")) body.defaultCategory = category().trim();
    if (!isLocked("defaultTags")) body.defaultTags = splitTags(tags());

    if (transmission()) {
      if (!isLocked("password")) {
        const password = transmissionPassword();
        if (password) body.password = password;
        if (clearTransmissionPassword()) body.password = "";
      }
      return body;
    }

    if (!isLocked("apiKey")) {
      const key = apiKey().trim();
      if (key) body.apiKey = key;
      if (clearApiKey()) body.apiKey = "";
    }
    if (!isLocked("password")) {
      const password = qbitPassword();
      if (password) body.password = password;
      if (clearQbitPassword()) body.password = "";
    }
    return body;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving() || testing()) return;

    setSaving(true);
    setStatus({ tone: "muted", message: "Saving…" });
    setStatusContext(undefined);
    try {
      const saved = await saveConfig(payload());
      applyConfig(saved);
      props.onConfigChange?.(saved);
      setStatus({ tone: "ok", message: "Saved." });
      props.onConfigSaved?.();
    } catch (error) {
      if (isExpired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContext(error, "Saving settings"));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    if (testing() || saving()) return;

    setTesting(true);
    setStatus({ tone: "muted", message: "Testing…" });
    setStatusContext(undefined);
    try {
      const health = await fetchHealth();
      props.onHealthChange?.(health);

      let message =
        `Connected to ${health.clientLabel} ${health.appVersion} ` +
        `(API ${health.webApiVersion}).`;
      if (!health.capabilities?.archiveDownload) {
        message += " — ZIP downloads disabled until DOWNLOADS_DIR is configured.";
      }
      const defaults: string[] = [];
      if (health.defaultCategory) defaults.push(`category ${health.defaultCategory}`);
      if (health.defaultTags?.length) defaults.push(`tags ${health.defaultTags.join(", ")}`);
      if (defaults.length) message += ` Defaults: ${defaults.join(" · ")}.`;

      setStatus({ tone: "ok", message });
    } catch (error) {
      if (isExpired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContext(error, "Testing connection"));
    } finally {
      setTesting(false);
    }
  }

  function reportIssue() {
    const context = statusContext();
    if (context) props.onReportIssue?.(context);
  }

  return (
    <form class="panel stack" onSubmit={save}>
      <h2>Torrent client</h2>

      <label class="field">
        <span class="field-label">
          <span>Client</span>
          <Show when={isLocked("clientKind")}>
            <span class="env-badge" title="Managed by an environment variable">
              Env
            </span>
          </Show>
        </span>
        <select
          name="clientKind"
          value={clientKind()}
          disabled={isLocked("clientKind")}
          onChange={(event) => setClientKind(event.currentTarget.value as ClientKind)}
        >
          <option value="qbittorrent">qBittorrent</option>
          <option value="transmission">Transmission</option>
        </select>
        <small>Choose the client this proxy connects to. You can switch at any time.</small>
      </label>

      <Show
        when={!transmission()}
        fallback={
          <div class="stack">
            <label class="field">
              <span class="field-label">
                <span>RPC URL</span>
                <Show when={isLocked("baseUrl")}>
                  <span class="env-badge" title="Managed by an environment variable">
                    Env
                  </span>
                </Show>
              </span>
              <input
                name="transmissionUrl"
                type="url"
                spellcheck={false}
                required
                disabled={isLocked("baseUrl")}
                placeholder="http://transmission:9091"
                value={transmissionUrl()}
                onInput={(event) => setTransmissionUrl(event.currentTarget.value)}
              />
              <small>
                Where Remagnet Proxy reaches Transmission's RPC endpoint, usually port 9091.
              </small>
            </label>

            <label class="field">
              <span class="field-label">
                <span>Username</span>
                <Show when={isLocked("username")}>
                  <span class="env-badge" title="Managed by an environment variable">
                    Env
                  </span>
                </Show>
              </span>
              <input
                name="transmissionUsername"
                type="text"
                autocomplete="username"
                spellcheck={false}
                disabled={isLocked("username")}
                value={transmissionUsername()}
                onInput={(event) => setTransmissionUsername(event.currentTarget.value)}
              />
              <small>
                Optional. Transmission can run without authentication on a private network.
              </small>
            </label>

            <label class="field">
              <span class="field-label">
                <span>Password</span>
                <Show when={isLocked("password")}>
                  <span class="env-badge" title="Managed by an environment variable">
                    Env
                  </span>
                </Show>
              </span>
              <input
                name="transmissionPassword"
                type="password"
                autocomplete="current-password"
                disabled={isLocked("password")}
                value={transmissionPassword()}
                onInput={(event) => setTransmissionPassword(event.currentTarget.value)}
              />
              <small>
                {hasPassword()
                  ? "Optional. A password is saved; leave blank to keep it."
                  : "Optional. Transmission can run without authentication on a private network."}
              </small>
            </label>
            <label class="check">
              <input
                type="checkbox"
                checked={clearTransmissionPassword()}
                disabled={isLocked("password")}
                onChange={(event) => setClearTransmissionPassword(event.currentTarget.checked)}
              />
              Remove the saved password
            </label>

            <label class="field">
              <span class="field-label">
                <span>Downloads directory</span>
                <Show when={isLocked("downloadsDir")}>
                  <span class="env-badge" title="Managed by an environment variable">
                    Env
                  </span>
                </Show>
              </span>
              <input
                name="transmissionDownloadsDir"
                type="text"
                spellcheck={false}
                disabled={isLocked("downloadsDir")}
                placeholder="/downloads"
                value={transmissionDownloadsDir()}
                onInput={(event) => setTransmissionDownloadsDir(event.currentTarget.value)}
              />
              <small>
                Mount Transmission's downloads volume read-only here to stream completed torrents as
                ZIP archives.
              </small>
            </label>

            <label class="field">
              <span class="field-label">
                <span>Client downloads path</span>
                <Show when={isLocked("clientDownloadsDir")}>
                  <span class="env-badge" title="Managed by an environment variable">
                    Env
                  </span>
                </Show>
              </span>
              <input
                name="transmissionClientDownloadsDir"
                type="text"
                spellcheck={false}
                disabled={isLocked("clientDownloadsDir")}
                placeholder="/data/torrents"
                value={transmissionClientDownloadsDir()}
                onInput={(event) => setTransmissionClientDownloadsDir(event.currentTarget.value)}
              />
              <small>
                Optional prefix of save paths as Transmission reports them, for example{" "}
                <code>/data/torrents</code>.
              </small>
            </label>
          </div>
        }
      >
        <div class="stack">
          <label class="field">
            <span class="field-label">
              <span>Web UI URL</span>
              <Show when={isLocked("baseUrl")}>
                <span class="env-badge" title="Managed by an environment variable">
                  Env
                </span>
              </Show>
            </span>
            <input
              name="qbitUrl"
              type="url"
              spellcheck={false}
              required
              disabled={isLocked("baseUrl")}
              placeholder="http://gluetun:8080"
              value={qbitUrl()}
              onInput={(event) => setQbitUrl(event.currentTarget.value)}
            />
            <small>
              Where Remagnet Proxy reaches qBittorrent. The default is the container network name.
            </small>
          </label>

          <label class="field">
            <span class="field-label">
              <span>API key</span>
              <Show when={isLocked("apiKey")}>
                <span class="env-badge" title="Managed by an environment variable">
                  Env
                </span>
              </Show>
            </span>
            <input
              name="apiKey"
              type="password"
              autocomplete="off"
              spellcheck={false}
              disabled={isLocked("apiKey")}
              placeholder={hasApiKey() ? "Saved key — leave blank to keep" : "qbt_…"}
              value={apiKey()}
              onInput={(event) => setApiKey(event.currentTarget.value)}
            />
            <small>
              {hasApiKey()
                ? "An API key is saved. Leave the field blank to keep it."
                : "No API key saved. Add one, or use username and password below."}
            </small>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={clearApiKey()}
              disabled={isLocked("apiKey")}
              onChange={(event) => setClearApiKey(event.currentTarget.checked)}
            />
            Remove the saved API key
          </label>

          <details>
            <summary>Username and password fallback</summary>
            <div class="stack">
              <label class="field">
                <span class="field-label">
                  <span>Username</span>
                  <Show when={isLocked("username")}>
                    <span class="env-badge" title="Managed by an environment variable">
                      Env
                    </span>
                  </Show>
                </span>
                <input
                  name="qbitUsername"
                  type="text"
                  autocomplete="username"
                  spellcheck={false}
                  disabled={isLocked("username")}
                  value={qbitUsername()}
                  onInput={(event) => setQbitUsername(event.currentTarget.value)}
                />
              </label>

              <label class="field">
                <span class="field-label">
                  <span>Password</span>
                  <Show when={isLocked("password")}>
                    <span class="env-badge" title="Managed by an environment variable">
                      Env
                    </span>
                  </Show>
                </span>
                <input
                  name="qbitPassword"
                  type="password"
                  autocomplete="current-password"
                  disabled={isLocked("password")}
                  value={qbitPassword()}
                  onInput={(event) => setQbitPassword(event.currentTarget.value)}
                />
                <small>
                  {hasPassword()
                    ? "A password is saved. Leave the field blank to keep it."
                    : "Leave blank to keep the saved password."}
                </small>
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  checked={clearQbitPassword()}
                  disabled={isLocked("password")}
                  onChange={(event) => setClearQbitPassword(event.currentTarget.checked)}
                />
                Remove the saved password
              </label>
            </div>
          </details>

          <details>
            <summary>Downloads volume (qBittorrent 4.x fallback)</summary>
            <div class="stack">
              <label class="field">
                <span class="field-label">
                  <span>Downloads directory</span>
                  <Show when={isLocked("downloadsDir")}>
                    <span class="env-badge" title="Managed by an environment variable">
                      Env
                    </span>
                  </Show>
                </span>
                <input
                  name="qbitDownloadsDir"
                  type="text"
                  spellcheck={false}
                  disabled={isLocked("downloadsDir")}
                  placeholder="/downloads"
                  value={qbitDownloadsDir()}
                  onInput={(event) => setQbitDownloadsDir(event.currentTarget.value)}
                />
                <small>
                  Mount qBittorrent's downloads volume read-only here to stream completed torrents
                  as ZIP archives.
                </small>
              </label>

              <label class="field">
                <span class="field-label">
                  <span>Client downloads path</span>
                  <Show when={isLocked("clientDownloadsDir")}>
                    <span class="env-badge" title="Managed by an environment variable">
                      Env
                    </span>
                  </Show>
                </span>
                <input
                  name="qbitClientDownloadsDir"
                  type="text"
                  spellcheck={false}
                  disabled={isLocked("clientDownloadsDir")}
                  placeholder="/data/torrents"
                  value={qbitClientDownloadsDir()}
                  onInput={(event) => setQbitClientDownloadsDir(event.currentTarget.value)}
                />
                <small>
                  Optional prefix of save paths as qBittorrent reports them. Leave blank when it
                  matches the mount.
                </small>
              </label>
            </div>
          </details>

          <label class="field">
            <span class="field-label">
              <span>Category</span>
              <Show when={isLocked("defaultCategory")}>
                <span class="env-badge" title="Managed by an environment variable">
                  Env
                </span>
              </Show>
            </span>
            <input
              name="category"
              type="text"
              spellcheck={false}
              disabled={isLocked("defaultCategory")}
              placeholder="remagnet"
              value={category()}
              onInput={(event) => setCategory(event.currentTarget.value)}
            />
            <small>
              Applied to every magnet added through the proxy. Leave blank to skip categorizing.
            </small>
          </label>
        </div>
      </Show>

      <label class="field">
        <span class="field-label">
          <span>{transmission() ? "Labels (tags)" : "Tags"}</span>
          <Show when={isLocked("defaultTags")}>
            <span class="env-badge" title="Managed by an environment variable">
              Env
            </span>
          </Show>
        </span>
        <input
          name="tags"
          type="text"
          spellcheck={false}
          disabled={isLocked("defaultTags")}
          placeholder="remagnet"
          value={tags()}
          onInput={(event) => setTags(event.currentTarget.value)}
        />
        <small>
          {transmission()
            ? "Comma-separated labels applied to every magnet added through the proxy. " +
              "Transmission exposes tags as labels. Leave blank to expose every torrent."
            : "Comma-separated. The proxy uses these tags, and the category above, to decide " +
              "which torrents belong to Remagnet. Leave both blank to expose every torrent."}
        </small>
      </label>

      <div class="actions">
        <button type="submit" disabled={saving() || testing() || allFieldsLocked()}>
          Save
        </button>
        <button
          type="button"
          class="ghost"
          disabled={saving() || testing()}
          onClick={() => void testConnection()}
        >
          Test connection
        </button>
      </div>

      <Show when={allFieldsLocked()}>
        <p class="hint muted">
          All settings for this client are managed via environment variables. Update them in your
          deployment, then restart the proxy to change them.
        </p>
      </Show>

      <StatusLine status={status()} onReport={props.onReportIssue ? reportIssue : undefined} />
    </form>
  );
}

function isExpired(error: unknown): boolean {
  return error instanceof ProxyApiError && error.expired;
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
