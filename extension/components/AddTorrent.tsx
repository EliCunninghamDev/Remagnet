import { createMemo, createSignal, onMount, Show } from "solid-js";
import { openTorrentFileSurface } from "../lib/add-surface";
import type { IssueReportContext } from "../lib/issue-report";
import { isMagnetLink, type MagnetLink, magnetLabel, parseMagnet } from "../lib/magnet";
import {
  type AddTorrentsResult,
  BackgroundError,
  type BackgroundRequest,
  sendBackgroundMessage,
  type TorrentLookupResult,
} from "../lib/messages";
import { type ParsedTorrentFile, parseTorrentFile, torrentFileLabel } from "../lib/torrent-file";
import type { TorrentSummary } from "../lib/torrents";
import AddedSummary from "./AddedSummary";
import type { FlowStatus } from "./flow-status";
import IssueReportDialog from "./IssueReportDialog";
import MagnetForm from "./MagnetForm";
import MagnetReview from "./MagnetReview";
import Wordmark from "./Wordmark";

interface AddedState extends AddTorrentsResult {
  name: string;
}

export interface AddTorrentProps {
  /** Magnet to show immediately, usually handed over by the protocol handler. */
  initialMagnet?: string;
  /** Compact layout for the toolbar popover instead of a full page. */
  embedded?: boolean;
  /** Focus the file chooser when `add.html?source=file` opens. */
  autoFocusFile?: boolean;
  /** Return to the torrent list, or close the add page. */
  onClose: () => void;
  /**
   * Called after a successful add. The popover uses this to return straight to
   * its torrent list; without it the flow shows the "Added" summary instead.
   */
  onAdded?: () => void;
}

/**
 * The magnet and `.torrent` review and submit flow.
 *
 * It is shared by the toolbar popover (the normal surface) and `add.html`,
 * which stays as the protocol-handler fallback and as the place the popover
 * hands file selection to, since a native file picker closes the popover.
 */
export default function AddTorrent(props: AddTorrentProps) {
  const initialMagnet = props.initialMagnet?.trim() ?? "";
  const [magnetUri, setMagnetUri] = createSignal(initialMagnet);
  const [draft, setDraft] = createSignal(initialMagnet);
  const [torrentFile, setTorrentFile] = createSignal<ParsedTorrentFile | null>(null);
  const [editing, setEditing] = createSignal(parseMagnet(initialMagnet) === null);
  const [paused, setPaused] = createSignal(false);
  const [existing, setExisting] = createSignal<TorrentSummary | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<FlowStatus>();
  const [added, setAdded] = createSignal<AddedState>();
  const [reportContext, setReportContext] = createSignal<IssueReportContext>();
  const [reportOpen, setReportOpen] = createSignal(false);

  let lookupToken = 0;
  let fileToken = 0;

  const magnet = createMemo<MagnetLink | null>(() => {
    const uri = magnetUri().trim();
    return uri ? parseMagnet(uri) : null;
  });

  onMount(() => {
    const link = magnet();
    if (link?.infoHash) void lookup(link.infoHash);
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

    fileToken += 1;
    setTorrentFile(null);
    setMagnetUri(link.uri);
    setDraft(link.uri);
    setEditing(false);
    setAdded(undefined);
    setStatus(undefined);
    setReportContext(undefined);
    setExisting(null);
    void lookup(link.infoHash);
    return true;
  }

  /** Parse a `.torrent` file and open its review screen. */
  async function handleFileSelect(file: File) {
    const token = ++fileToken;
    setStatus(undefined);
    setReportContext(undefined);

    try {
      const parsed = await parseTorrentFile(file);
      if (token !== fileToken) return;

      setTorrentFile(parsed);
      setMagnetUri("");
      setDraft("");
      setEditing(false);
      setAdded(undefined);
      setStatus(undefined);
      setReportContext(undefined);
      setExisting(null);
      void lookup(parsed.infoHash);
    } catch (error) {
      if (token === fileToken) {
        setStatus({ tone: "error", message: errorMessage(error) });
      }
    }
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
      // A lookup failure usually means the proxy is not configured yet. Let
      // the add request surface the real error.
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
    setReportContext(undefined);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const file = torrentFile();
    const link = file ? null : magnet();
    if ((!file && !link) || existing()) return;

    let request: BackgroundRequest;
    if (file) {
      request = {
        type: "torrents:add",
        files: [{ filename: file.filename, data: file.dataBase64 }],
        ...(paused() ? { paused: true } : {}),
      };
    } else if (link) {
      request = {
        type: "torrents:add",
        urls: [link.uri],
        ...(paused() ? { paused: true } : {}),
      };
    } else {
      return;
    }

    setBusy(true);
    setStatus(undefined);
    setReportContext(undefined);

    try {
      const result = await sendBackgroundMessage<AddTorrentsResult>(request);
      if (props.onAdded) {
        props.onAdded();
        return;
      }
      const name = file ? torrentFileLabel(file) : link ? magnetLabel(link) : "";
      setAdded({ ...result, name });
      setStatus({ tone: "ok", message: `Sent “${name}” to Remagnet Proxy.` });
    } catch (error) {
      setStatus({ tone: "error", message: errorMessage(error) });
      setReportContext(issueContext(error, "Adding torrent"));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    fileToken += 1;
    setAdded(undefined);
    setMagnetUri("");
    setDraft("");
    setTorrentFile(null);
    setEditing(true);
    setExisting(null);
    setStatus(undefined);
    setReportContext(undefined);
  }

  /** The popover hands file selection to a tab so the picker can stay open. */
  function openFilePickerSurface() {
    void openTorrentFileSurface();
    window.close();
  }

  const body = (
    <Show
      when={added()}
      fallback={
        <Show
          when={!editing() && (magnet() ?? torrentFile())}
          fallback={
            <MagnetForm
              draft={draft()}
              status={status()}
              canCancel={Boolean(magnetUri() || torrentFile())}
              embedded={Boolean(props.embedded)}
              autoFocusFile={Boolean(props.autoFocusFile)}
              onDraftChange={setDraft}
              onSubmit={applyDraft}
              onCancel={() => setEditing(false)}
              onFileSelect={(file) => void handleFileSelect(file)}
              onOpenFilePickerSurface={props.embedded ? openFilePickerSurface : undefined}
            />
          }
        >
          <MagnetReview
            link={magnet() ?? undefined}
            file={torrentFile() ?? undefined}
            existing={existing()}
            paused={paused()}
            busy={busy()}
            status={status()}
            onEdit={editMagnet}
            onSubmit={submit}
            onPausedChange={setPaused}
          />
        </Show>
      }
    >
      {(result) => (
        <AddedSummary
          name={result().name}
          category={result().category}
          tags={result().tags}
          embedded={Boolean(props.embedded)}
          onAddAnother={reset}
          onClose={props.onClose}
        />
      )}
    </Show>
  );

  const reportControls = (
    <>
      <Show when={reportContext()}>
        <p class="report-inline">
          <button class="linkish" type="button" onClick={() => setReportOpen(true)}>
            Report issue
          </button>
        </p>
      </Show>
      <IssueReportDialog
        open={reportOpen()}
        context={reportContext()}
        onClose={() => setReportOpen(false)}
      />
    </>
  );

  if (props.embedded) {
    return (
      <section class="add-flow stack">
        {body}
        {reportControls}
      </section>
    );
  }

  return (
    <main class="add">
      <header class="add-header">
        <div class="header-text">
          <Wordmark as="p" size="lg" surface="Add torrent" />
          <h1>Send to Remagnet Proxy</h1>
          <p class="muted">The proxy adds the magnet or .torrent file to your torrent client.</p>
        </div>
        <button class="ghost" type="button" onClick={() => props.onClose()}>
          Close
        </button>
      </header>
      {body}
      {reportControls}
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueContext(cause: unknown, action: string): IssueReportContext {
  const context: IssueReportContext = { action, message: errorMessage(cause) };
  if (cause instanceof BackgroundError) {
    if (cause.code) context.code = cause.code;
    if (cause.status !== undefined) context.status = cause.status;
  }
  return context;
}
