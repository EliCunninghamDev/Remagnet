import { createMemo, createSignal, onMount, Show } from "solid-js";
import { browser } from "wxt/browser";
import { getTorrentClientDefinition } from "../lib/clients/catalog";
import { isMagnetLink, type MagnetLink, magnetLabel, parseMagnet } from "../lib/magnet";
import {
  type AddTorrentsResult,
  sendBackgroundMessage,
  type TorrentLookupResult,
} from "../lib/messages";
import { DEFAULT_SETTINGS, getSettings, type Settings } from "../lib/settings";
import type { TorrentSummary } from "../lib/torrents";
import AddedSummary from "./AddedSummary";
import type { FlowStatus } from "./flow-status";
import MagnetForm from "./MagnetForm";
import MagnetReview from "./MagnetReview";
import Wordmark from "./Wordmark";

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
  const [status, setStatus] = createSignal<FlowStatus>();
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
    <Show when={!loading()} fallback={<p class="muted">Loading…</p>}>
      <Show
        when={added()}
        fallback={
          <Show
            when={!editing() && magnet()}
            fallback={
              <MagnetForm
                draft={draft()}
                status={status()}
                canCancel={Boolean(magnetUri())}
                onDraftChange={setDraft}
                onSubmit={applyDraft}
                onCancel={() => setEditing(false)}
              />
            }
          >
            {(link) => (
              <MagnetReview
                link={link()}
                clientLabel={definition().label}
                capabilities={capabilities()}
                existing={existing()}
                paused={paused()}
                busy={busy()}
                status={status()}
                onEdit={editMagnet}
                onSubmit={submit}
                onPausedChange={setPaused}
                onOpenClient={openClient}
              />
            )}
          </Show>
        }
      >
        {(result) => (
          <AddedSummary
            name={result().name}
            category={result().category}
            tags={result().tags}
            clientLabel={definition().label}
            embedded={Boolean(props.embedded)}
            onOpenClient={openClient}
            onAddAnother={reset}
            onClose={props.onClose}
          />
        )}
      </Show>
    </Show>
  );

  if (props.embedded) {
    return <section class="add-flow stack">{body}</section>;
  }

  return (
    <main class="add">
      <header class="add-header">
        <div class="header-text">
          <Wordmark as="p" size="lg" surface="Add torrent" />
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
