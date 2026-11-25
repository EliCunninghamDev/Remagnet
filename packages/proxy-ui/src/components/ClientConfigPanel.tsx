import { errorMessage, type IssueReportContext, issueContextFromError } from "@remagnet/ui";
import { createSignal, Match, onMount, Show, Switch } from "solid-js";
import {
  type ConfigUpdate,
  type ConnectionHealth,
  fetchConfig,
  fetchHealth,
  isSessionExpired,
  type PublicConfig,
  saveConfig,
} from "../api";
import StatusLine, { type StatusMessage } from "./StatusLine";

type ClientKind = PublicConfig["clientKind"];

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

const DELUGE_LOCK_FIELDS = [
  "clientKind",
  "baseUrl",
  "password",
  "downloadsDir",
  "clientDownloadsDir",
  "defaultCategory",
];

const RTORRENT_LOCK_FIELDS = [
  "clientKind",
  "baseUrl",
  "username",
  "password",
  "downloadsDir",
  "clientDownloadsDir",
  "defaultCategory",
];

/** Torrent client connection settings shared by qBittorrent, Transmission, Deluge and rTorrent. */
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

  const [delugeUrl, setDelugeUrl] = createSignal("");
  const [delugePassword, setDelugePassword] = createSignal("");
  const [clearDelugePassword, setClearDelugePassword] = createSignal(false);
  const [delugeDownloadsDir, setDelugeDownloadsDir] = createSignal("");
  const [delugeClientDownloadsDir, setDelugeClientDownloadsDir] = createSignal("");

  const [rtorrentUrl, setRtorrentUrl] = createSignal("");
  const [rtorrentUsername, setRtorrentUsername] = createSignal("");
  const [rtorrentPassword, setRtorrentPassword] = createSignal("");
  const [clearRtorrentPassword, setClearRtorrentPassword] = createSignal(false);
  const [rtorrentDownloadsDir, setRtorrentDownloadsDir] = createSignal("");
  const [rtorrentClientDownloadsDir, setRtorrentClientDownloadsDir] = createSignal("");

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

  const envLocked = () => new Set(loadedConfig()?.envLocked ?? []);
  const isLocked = (field: string) => envLocked().has(field);

  const lockFields = (kind: ClientKind) => {
    switch (kind) {
      case "transmission":
        return TRANSMISSION_LOCK_FIELDS;
      case "deluge":
        return DELUGE_LOCK_FIELDS;
      case "rtorrent":
        return RTORRENT_LOCK_FIELDS;
      default:
        return QBIT_LOCK_FIELDS;
    }
  };
  const allFieldsLocked = () => lockFields(clientKind()).every((field) => isLocked(field));

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
    setClientKind(config.clientKind);

    const baseUrl = config.baseUrl || "";
    setQbitUrl(baseUrl);
    setTransmissionUrl(baseUrl);
    setDelugeUrl(baseUrl);
    setRtorrentUrl(baseUrl);

    const username = config.username || "";
    setQbitUsername(username);
    setTransmissionUsername(username);
    setRtorrentUsername(username);

    const downloadsDir = config.downloadsDir || "";
    setQbitDownloadsDir(downloadsDir);
    setTransmissionDownloadsDir(downloadsDir);
    setDelugeDownloadsDir(downloadsDir);
    setRtorrentDownloadsDir(downloadsDir);

    const clientDownloadsDir = config.clientDownloadsDir || "";
    setQbitClientDownloadsDir(clientDownloadsDir);
    setTransmissionClientDownloadsDir(clientDownloadsDir);
    setDelugeClientDownloadsDir(clientDownloadsDir);
    setRtorrentClientDownloadsDir(clientDownloadsDir);

    setCategory(config.defaultCategory || "");
    setTags((config.defaultTags || []).join(", "));

    // Saved secrets never travel back through the API; clear the drafts so a
    // blank field really means "keep what is stored".
    setApiKey("");
    setQbitPassword("");
    setTransmissionPassword("");
    setDelugePassword("");
    setRtorrentPassword("");
    setClearApiKey(false);
    setClearQbitPassword(false);
    setClearTransmissionPassword(false);
    setClearDelugePassword(false);
    setClearRtorrentPassword(false);

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
      if (isSessionExpired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContextFromError(error, "Loading settings"));
    }
  }

  function baseUrlFor(kind: ClientKind): string {
    switch (kind) {
      case "transmission":
        return transmissionUrl();
      case "deluge":
        return delugeUrl();
      case "rtorrent":
        return rtorrentUrl();
      default:
        return qbitUrl();
    }
  }

  function usernameFor(kind: ClientKind): string {
    switch (kind) {
      case "transmission":
        return transmissionUsername();
      case "rtorrent":
        return rtorrentUsername();
      default:
        return qbitUsername();
    }
  }

  function payload(): ConfigUpdate {
    const kind = clientKind();
    const body: ConfigUpdate = {};

    if (!isLocked("clientKind")) body.clientKind = kind;

    if (!isLocked("baseUrl")) body.baseUrl = baseUrlFor(kind).trim();
    // Deluge authenticates with a password only; it has no username field.
    if (kind !== "deluge" && !isLocked("username")) {
      body.username = usernameFor(kind).trim();
    }
    if (!isLocked("downloadsDir")) {
      switch (kind) {
        case "transmission":
          body.downloadsDir = transmissionDownloadsDir().trim();
          break;
        case "deluge":
          body.downloadsDir = delugeDownloadsDir().trim();
          break;
        case "rtorrent":
          body.downloadsDir = rtorrentDownloadsDir().trim();
          break;
        default:
          body.downloadsDir = qbitDownloadsDir().trim();
      }
    }
    if (!isLocked("clientDownloadsDir")) {
      switch (kind) {
        case "transmission":
          body.clientDownloadsDir = transmissionClientDownloadsDir().trim();
          break;
        case "deluge":
          body.clientDownloadsDir = delugeClientDownloadsDir().trim();
          break;
        case "rtorrent":
          body.clientDownloadsDir = rtorrentClientDownloadsDir().trim();
          break;
        default:
          body.clientDownloadsDir = qbitClientDownloadsDir().trim();
      }
    }
    if (!isLocked("defaultCategory")) body.defaultCategory = category().trim();
    if (!isLocked("defaultTags")) {
      // Deluge and rTorrent filter by their single category/label field, so an
      // empty list is what exposes every torrent.
      body.defaultTags = kind === "deluge" || kind === "rtorrent" ? [] : splitTags(tags());
    }

    switch (kind) {
      case "transmission": {
        if (!isLocked("password")) {
          const password = transmissionPassword();
          if (password) body.password = password;
          if (clearTransmissionPassword()) body.password = "";
        }
        break;
      }
      case "deluge": {
        if (!isLocked("password")) {
          const password = delugePassword();
          if (password) body.password = password;
          if (clearDelugePassword()) body.password = "";
        }
        break;
      }
      case "rtorrent": {
        if (!isLocked("password")) {
          const password = rtorrentPassword();
          if (password) body.password = password;
          if (clearRtorrentPassword()) body.password = "";
        }
        break;
      }
      default: {
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
      }
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
      if (isSessionExpired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContextFromError(error, "Saving settings"));
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
      if (isSessionExpired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContextFromError(error, "Testing connection"));
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
        <FieldLabel label="Client" locked={isLocked("clientKind")} />
        <select
          name="clientKind"
          value={clientKind()}
          disabled={isLocked("clientKind")}
          onChange={(event) => setClientKind(event.currentTarget.value as ClientKind)}
        >
          <option value="qbittorrent">qBittorrent</option>
          <option value="transmission">Transmission</option>
          <option value="deluge">Deluge</option>
          <option value="rtorrent">rTorrent / ruTorrent</option>
        </select>
        <small>Choose the client this proxy connects to. You can switch at any time.</small>
      </label>

      <Switch
        fallback={
          <div class="stack">
            <label class="field">
              <FieldLabel label="Web UI URL" locked={isLocked("baseUrl")} />
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
              <FieldLabel label="API key" locked={isLocked("apiKey")} />
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
                  <FieldLabel label="Username" locked={isLocked("username")} />
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
                  <FieldLabel label="Password" locked={isLocked("password")} />
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
                  <FieldLabel label="Downloads directory" locked={isLocked("downloadsDir")} />
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
                  <FieldLabel
                    label="Client downloads path"
                    locked={isLocked("clientDownloadsDir")}
                  />
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
              <FieldLabel label="Category" locked={isLocked("defaultCategory")} />
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
        }
      >
        <Match when={clientKind() === "transmission"}>
          <div class="stack">
            <label class="field">
              <FieldLabel label="RPC URL" locked={isLocked("baseUrl")} />
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
              <FieldLabel label="Username" locked={isLocked("username")} />
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
              <FieldLabel label="Password" locked={isLocked("password")} />
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
              <FieldLabel label="Downloads directory" locked={isLocked("downloadsDir")} />
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
              <FieldLabel label="Client downloads path" locked={isLocked("clientDownloadsDir")} />
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
        </Match>

        <Match when={clientKind() === "deluge"}>
          <div class="stack">
            <label class="field">
              <FieldLabel label="Web UI URL" locked={isLocked("baseUrl")} />
              <input
                name="delugeUrl"
                type="url"
                spellcheck={false}
                required
                disabled={isLocked("baseUrl")}
                placeholder="http://deluge:8112"
                value={delugeUrl()}
                onInput={(event) => setDelugeUrl(event.currentTarget.value)}
              />
              <small>Where Remagnet Proxy reaches Deluge's Web UI, usually port 8112.</small>
            </label>

            <label class="field">
              <FieldLabel label="Password" locked={isLocked("password")} />
              <input
                name="delugePassword"
                type="password"
                autocomplete="current-password"
                disabled={isLocked("password")}
                value={delugePassword()}
                onInput={(event) => setDelugePassword(event.currentTarget.value)}
              />
              <small>
                {hasPassword()
                  ? "A password is saved; leave blank to keep it."
                  : "Deluge Web UI password (default is deluge on a fresh install)."}
              </small>
            </label>
            <label class="check">
              <input
                type="checkbox"
                checked={clearDelugePassword()}
                disabled={isLocked("password")}
                onChange={(event) => setClearDelugePassword(event.currentTarget.checked)}
              />
              Remove the saved password
            </label>

            <label class="field">
              <FieldLabel label="Downloads directory" locked={isLocked("downloadsDir")} />
              <input
                name="delugeDownloadsDir"
                type="text"
                spellcheck={false}
                disabled={isLocked("downloadsDir")}
                placeholder="/downloads"
                value={delugeDownloadsDir()}
                onInput={(event) => setDelugeDownloadsDir(event.currentTarget.value)}
              />
              <small>
                Mount Deluge's downloads volume read-only here to stream completed torrents as ZIP
                archives.
              </small>
            </label>

            <label class="field">
              <FieldLabel label="Client downloads path" locked={isLocked("clientDownloadsDir")} />
              <input
                name="delugeClientDownloadsDir"
                type="text"
                spellcheck={false}
                disabled={isLocked("clientDownloadsDir")}
                placeholder="/downloads"
                value={delugeClientDownloadsDir()}
                onInput={(event) => setDelugeClientDownloadsDir(event.currentTarget.value)}
              />
              <small>Optional prefix of save paths as Deluge reports them.</small>
            </label>

            <label class="field">
              <FieldLabel label="Label" locked={isLocked("defaultCategory")} />
              <input
                name="delugeLabel"
                type="text"
                spellcheck={false}
                disabled={isLocked("defaultCategory")}
                placeholder="remagnet"
                value={category()}
                onInput={(event) => setCategory(event.currentTarget.value)}
              />
              <small>
                Label applied via Deluge's Label plugin to every torrent added through the proxy.
                Leave blank to expose every torrent.
              </small>
            </label>
          </div>
        </Match>

        <Match when={clientKind() === "rtorrent"}>
          <div class="stack">
            <label class="field">
              <FieldLabel label="XML-RPC URL" locked={isLocked("baseUrl")} />
              <input
                name="rtorrentUrl"
                type="url"
                spellcheck={false}
                required
                disabled={isLocked("baseUrl")}
                placeholder="http://rtorrent:8000"
                value={rtorrentUrl()}
                onInput={(event) => setRtorrentUrl(event.currentTarget.value)}
              />
              <small>
                Where Remagnet Proxy reaches rTorrent's XML-RPC endpoint (/RPC2 or ruTorrent's
                /plugins/rpc/rpc.php).
              </small>
            </label>

            <label class="field">
              <FieldLabel label="Username" locked={isLocked("username")} />
              <input
                name="rtorrentUsername"
                type="text"
                autocomplete="username"
                spellcheck={false}
                disabled={isLocked("username")}
                value={rtorrentUsername()}
                onInput={(event) => setRtorrentUsername(event.currentTarget.value)}
              />
              <small>
                Optional. Leave blank when XML-RPC runs without HTTP Basic Auth on a private
                network.
              </small>
            </label>

            <label class="field">
              <FieldLabel label="Password" locked={isLocked("password")} />
              <input
                name="rtorrentPassword"
                type="password"
                autocomplete="current-password"
                disabled={isLocked("password")}
                value={rtorrentPassword()}
                onInput={(event) => setRtorrentPassword(event.currentTarget.value)}
              />
              <small>
                Optional. Leave blank when XML-RPC runs without HTTP Basic Auth on a private
                network.
              </small>
            </label>
            <label class="check">
              <input
                type="checkbox"
                checked={clearRtorrentPassword()}
                disabled={isLocked("password")}
                onChange={(event) => setClearRtorrentPassword(event.currentTarget.checked)}
              />
              Remove the saved password
            </label>

            <label class="field">
              <FieldLabel label="Downloads directory" locked={isLocked("downloadsDir")} />
              <input
                name="rtorrentDownloadsDir"
                type="text"
                spellcheck={false}
                disabled={isLocked("downloadsDir")}
                placeholder="/downloads"
                value={rtorrentDownloadsDir()}
                onInput={(event) => setRtorrentDownloadsDir(event.currentTarget.value)}
              />
              <small>
                Mount rTorrent's downloads volume read-only here to stream completed torrents as ZIP
                archives.
              </small>
            </label>

            <label class="field">
              <FieldLabel label="Client downloads path" locked={isLocked("clientDownloadsDir")} />
              <input
                name="rtorrentClientDownloadsDir"
                type="text"
                spellcheck={false}
                disabled={isLocked("clientDownloadsDir")}
                placeholder="/downloads"
                value={rtorrentClientDownloadsDir()}
                onInput={(event) => setRtorrentClientDownloadsDir(event.currentTarget.value)}
              />
              <small>Optional prefix of save paths as rTorrent reports them.</small>
            </label>

            <label class="field">
              <FieldLabel label="Label" locked={isLocked("defaultCategory")} />
              <input
                name="rtorrentLabel"
                type="text"
                spellcheck={false}
                disabled={isLocked("defaultCategory")}
                placeholder="remagnet"
                value={category()}
                onInput={(event) => setCategory(event.currentTarget.value)}
              />
              <small>
                ruTorrent label (custom1) applied to every torrent added through the proxy. Leave
                blank to expose every torrent.
              </small>
            </label>
          </div>
        </Match>
      </Switch>

      <Show when={clientKind() === "qbittorrent" || clientKind() === "transmission"}>
        <label class="field">
          <FieldLabel
            label={clientKind() === "transmission" ? "Labels (tags)" : "Tags"}
            locked={isLocked("defaultTags")}
          />
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
            {clientKind() === "transmission"
              ? "Comma-separated labels applied to every magnet added through the proxy. " +
                "Transmission exposes tags as labels. Leave blank to expose every torrent."
              : "Comma-separated. The proxy uses these tags, and the category above, to decide " +
                "which torrents belong to Remagnet. Leave both blank to expose every torrent."}
          </small>
        </label>
      </Show>

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

function FieldLabel(props: { label: string; locked: boolean }) {
  return (
    <span class="field-label">
      <span>{props.label}</span>
      <Show when={props.locked}>
        <span class="env-badge" title="Managed by an environment variable">
          Env
        </span>
      </Show>
    </span>
  );
}
