import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { browser } from "wxt/browser";
import { getTorrentClientDefinition } from "../lib/clients/catalog";
import { formatBytes, formatPercent, stateLabel } from "../lib/format";
import {
  isMagnetLink,
  type MagnetLink,
  magnetLabel,
  parseMagnet,
  trackerHosts,
} from "../lib/magnet";
import {
  type AddTorrentsResult,
  sendBackgroundMessage,
  type TorrentLookupResult,
} from "../lib/messages";
import { DEFAULT_SETTINGS, getSettings, type Settings } from "../lib/settings";
import type { TorrentSummary } from "../lib/torrents";

interface Status {
  tone: "ok" | "error" | "warn";
  message: string;
}

interface AddedState extends AddTorrentsResult {
  name: string;
  category: string;
  tags: string[];
}

export interface AddTorrentProps {
  /** Magnet to show immediately, usually handed over by the protocol handler. */
  initialMagnet?: string;
  /** Compact layout for the toolbar popover instead of a full page. */
  embedded?: boolean;
  /** Return to the torrent list, or close the add page. */
  onClose: () => void;
  /**
   * Called after a successful add. The popover uses this to return straight to
   * its torrent list; without it the flow shows the "Added" summary instead.
   */
  onAdded?: () => void;
}

/**
 * The magnet review and submit flow.
 *
 * It is shared by the toolbar popover (the normal surface) and `add.html`,
 * which stays as the protocol-handler fallback for browsers or cases where the
 * popover cannot be opened.
 */
export default function AddTorrent(props: AddTorrentProps) {
  const initialMagnet = props.initialMagnet?.trim() ?? "";
  const [settings, setSettings] = createSignal<Settings>({ ...DEFAULT_SETTINGS });
  const [magnetUri, setMagnetUri] = createSignal(initialMagnet);
  const [draft, setDraft] = createSignal(initialMagnet);
  const [editing, setEditing] = createSignal(parseMagnet(initialMagnet) === null);
  const [paused, setPaused] = createSignal(false);
  const [existing, setExisting] = createSignal<TorrentSummary | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<Status>();
  const [added, setAdded] = createSignal<AddedState>();

  let lookupToken = 0;

  const magnet = createMemo<MagnetLink | null>(() => {
    const uri = magnetUri().trim();
    return uri ? parseMagnet(uri) : null;
  });

  const definition = createMemo(() => getTorrentClientDefinition(settings().client));
  const capabilities = createMemo(() => definition().capabilities);

  onMount(() => {
    void initialize();
  });

  /** Validate and show a magnet URI, or report why it cannot be used. */
  function loadMagnet(uri: string): boolean {
    const link = parseMagnet(uri);
    if (!link) {
      setStatus({
        tone: "error",
        message: isMagnetLink(uri)
          ? "That magnet link has no usable BitTorrent info hash."
          : "Paste a magnet link that starts with magnet:?.",
      });
      return false;
    }

    setMagnetUri(link.uri);
    setDraft(link.uri);
    setEditing(false);
    setAdded(undefined);
    setStatus(undefined);
    setExisting(null);
    void lookup(link.infoHash);
    return true;
  }

  async function initialize() {
    setLoading(true);
    try {
      setSettings(await getSettings());
    } catch {
      // Keep the defaults; the add request will report a real failure.
    }

    const link = magnet();
    if (link?.infoHash) void lookup(link.infoHash);
    setLoading(false);
  }

  async function lookup(hash: string | null) {
    const token = ++lookupToken;
    if (!hash) {
      setExisting(null);
      return;
    }

    try {
      const result = await sendBackgroundMessage<TorrentLookupResult>({
        type: "torrents:get",
        hash,
      });
      if (token === lookupToken) setExisting(result.torrent);
    } catch {
      // A lookup failure usually means the connection is not configured yet.
      // Let the add request surface the real error.
      if (token === lookupToken) setExisting(null);
    }
  }

  function applyDraft(event: SubmitEvent) {
    event.preventDefault();
    loadMagnet(draft());
  }

  function editMagnet() {
    setDraft(magnetUri());
    setEditing(true);
    setStatus(undefined);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const link = magnet();
    if (!link || existing()) return;

    setBusy(true);
    setStatus(undefined);
    const current = settings();
    const chosenCategory = capabilities().categories ? current.defaultCategory.trim() : "";
    const chosenTags = capabilities().tags ? splitTags(current.defaultTags) : [];

    try {
      const result = await sendBackgroundMessage<AddTorrentsResult>({
        type: "torrents:add",
        urls: [link.uri],
        ...(chosenCategory ? { category: chosenCategory } : {}),
        ...(chosenTags.length > 0 ? { tags: chosenTags } : {}),
        ...(paused() ? { paused: true } : {}),
      });
      if (props.onAdded) {
        props.onAdded();
        return;
      }
      const name = magnetLabel(link);
      setAdded({ ...result, name, category: chosenCategory, tags: chosenTags });
      setStatus({ tone: "ok", message: `Sent “${name}” to ${definition().label}.` });
    } catch (error) {
      setStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setAdded(undefined);
    setMagnetUri("");
    setDraft("");
    setEditing(true);
    setExisting(null);
    setStatus(undefined);
  }

  function openClient() {
    void browser.tabs.create({ url: settings().baseUrl || definition().defaultBaseUrl });
  }

  const body = (
    <>
      <Show when={!loading()} fallback={<p class="muted">Loading…</p>}>
        <Show when={added()}>
          {(result) => (
            <section class="panel stack">
              <p class="status ok">
                Added “{result().name}” to {definition().label}.
              </p>
              <p class="muted">
                <Show when={result().category}>Category: {result().category}. </Show>
                <Show when={result().tags.length > 0}>Tags: {result().tags.join(", ")}. </Show>
                Metadata and file names arrive shortly.
              </p>
              <div class="actions">
                <button type="button" onClick={openClient}>
                  Open {definition().label}
                </button>
                <button type="button" class="ghost" onClick={reset}>
                  Add another
                </button>
                <button type="button" class="ghost" onClick={() => props.onClose()}>
                  {props.embedded ? "View downloads" : "Close"}
                </button>
              </div>
            </section>
          )}
        </Show>

        <Show when={!added()}>
          <Show
            when={!editing() && magnet()}
            fallback={
              <form class="panel stack" onSubmit={applyDraft}>
                <label class="field">
                  <span>Magnet link</span>
                  <textarea
                    rows={3}
                    spellcheck={false}
                    placeholder="magnet:?xt=urn:btih:…"
                    value={draft()}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                  />
                  <small>
                    Click a magnet link in Firefox and it opens here, or paste one above.
                  </small>
                </label>
                <div class="actions">
                  <button type="submit" disabled={!draft().trim()}>
                    Continue
                  </button>
                  <Show when={magnetUri()}>
                    <button class="ghost" type="button" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  </Show>
                </div>
                <Show when={status()}>
                  {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
                </Show>
              </form>
            }
          >
            {(link) => (
              <div class="stack">
                <section class="panel magnet-card">
                  <div class="magnet-head">
                    <h2>{magnetLabel(link())}</h2>
                    <button class="ghost" type="button" onClick={editMagnet}>
                      Edit
                    </button>
                  </div>

                  <dl class="kv">
                    <Show when={link().infoHash}>
                      {(hash) => (
                        <div>
                          <dt>Info hash</dt>
                          <dd class="mono">{hash()}</dd>
                        </div>
                      )}
                    </Show>
                    <Show when={link().size !== null}>
                      <div>
                        <dt>Size</dt>
                        <dd>{formatBytes(link().size ?? 0)}</dd>
                      </div>
                    </Show>
                    <Show when={link().trackers.length > 0}>
                      <div>
                        <dt>Trackers</dt>
                        <dd>
                          {link().trackers.length}
                          {trackerHosts(link()).length > 0
                            ? ` · ${trackerHosts(link()).join(", ")}`
                            : ""}
                        </dd>
                      </div>
                    </Show>
                    <Show when={link().webSeeds.length > 0}>
                      <div>
                        <dt>Web seeds</dt>
                        <dd>{link().webSeeds.length}</dd>
                      </div>
                    </Show>
                  </dl>

                  <Show when={link().trackers.length > 0}>
                    <details class="trackers">
                      <summary>Show tracker URLs</summary>
                      <ul>
                        <For each={link().trackers}>
                          {(tracker) => <li class="mono">{tracker}</li>}
                        </For>
                      </ul>
                    </details>
                  </Show>
                </section>

                <Show when={existing()}>
                  {(torrent) => (
                    <p class="status warn">
                      Already in {definition().label}: <strong>{torrent().name}</strong> (
                      {stateLabel(torrent().state)} · {formatPercent(torrent().progress)}).
                    </p>
                  )}
                </Show>

                <form class="panel stack" onSubmit={submit}>
                  <div class="submit-row">
                    <div class="submit-main">
                      <button type="submit" disabled={busy() || Boolean(existing()) || !magnet()}>
                        {busy() ? "Sending…" : `Send to ${definition().label}`}
                      </button>
                      <Show when={capabilities().pauseOnAdd}>
                        <label
                          class="check compact"
                          title={`Add stopped, and start it manually in ${definition().label}`}
                        >
                          <input
                            type="checkbox"
                            checked={paused()}
                            onChange={(event) => setPaused(event.currentTarget.checked)}
                          />
                          <span>Add paused</span>
                        </label>
                      </Show>
                    </div>

                    <button type="button" class="client-link" onClick={openClient}>
                      Open {definition().label}
                    </button>
                  </div>

                  <Show when={status()}>
                    {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
                  </Show>
                </form>
              </div>
            )}
          </Show>
        </Show>
      </Show>
    </>
  );

  if (props.embedded) {
    return <section class="add-flow stack">{body}</section>;
  }

  return (
    <main class="add">
      <header class="add-header">
        <div class="header-text">
          <p class="eyebrow">Remagnet</p>
          <h1>Send to {definition().label}</h1>
          <p class="muted mono">{settings().baseUrl || definition().defaultBaseUrl}</p>
        </div>
        <button class="ghost" type="button" onClick={() => props.onClose()}>
          Close
        </button>
      </header>
      {body}
    </main>
  );
}

function splitTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
