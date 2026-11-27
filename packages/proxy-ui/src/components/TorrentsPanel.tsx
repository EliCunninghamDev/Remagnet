import {
  type TorrentSummary as CardTorrent,
  COUNT_BADGE_MIN,
  countTorrentFilters,
  errorMessage,
  fileBasename,
  filterAndSortTorrents,
  type IssueReportContext,
  isMagnetLink,
  issueContextFromError,
  isTorrentComplete,
  isTorrentPaused,
  MagnetForm,
  type MagnetLink,
  MagnetReview,
  magnetLabel,
  type ParsedTorrentFile,
  parseMagnet,
  parseTorrentFile,
  TorrentCard,
  type TorrentFile,
  type TorrentFilter,
  TorrentListControls,
  type TorrentSort,
  torrentFileLabel,
} from "@remagnet/ui";
import { createEffect, createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import {
  type AddTorrentRequest,
  addTorrents,
  archiveDownloadHref,
  type ConnectionHealth,
  createArchiveTicket,
  createFileArchiveTicket,
  fetchTorrent,
  fetchTorrentFiles,
  fetchTorrents,
  fileArchiveDownloadHref,
  isSessionExpired,
  ProxyApiError,
  type TorrentSummary as ProxyTorrent,
  pauseAllTorrents,
  pauseTorrent,
  removeTorrent,
  resumeAllTorrents,
  resumeTorrent,
} from "../api";
import StatusLine, { type StatusMessage } from "./StatusLine";

const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 10_000;

type ListOptions = { background?: boolean; quiet?: boolean };

export interface TorrentsPanelProps {
  /** Bumped by App after saving client settings to refresh immediately. */
  refreshTrigger?: number;
  /** Connection capabilities; `archiveDownload: false` disables ZIP downloads. */
  health?: ConnectionHealth;
  /** Called when an authenticated request finds that the session ended. */
  onSessionExpired?: () => void;
  /** Called with redacted diagnostics when the user asks to report a failure. */
  onReportIssue?: (context: IssueReportContext) => void;
}

/** The proxy dashboard's torrent list, add composer and row actions. */
export default function TorrentsPanel(props: TorrentsPanelProps) {
  const [torrents, setTorrents] = createSignal<CardTorrent[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [initialLoading, setInitialLoading] = createSignal(true);
  const [refreshing, setRefreshing] = createSignal(false);
  const [configured, setConfigured] = createSignal<boolean | null>(null);
  const [listStatus, setListStatus] = createSignal<StatusMessage>();
  const [listContext, setListContext] = createSignal<IssueReportContext>();

  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<TorrentFilter>("all");
  const [sort, setSort] = createSignal<TorrentSort>("added");

  const filterCounts = createMemo(() => countTorrentFilters(torrents()));
  const visibleTorrents = createMemo(() =>
    filterAndSortTorrents(torrents(), { query: query(), filter: filter(), sort: sort() }),
  );
  const showControls = () =>
    torrents().length >= COUNT_BADGE_MIN || query().trim().length > 0 || filter() !== "all";

  const [addOpen, setAddOpen] = createSignal(false);
  const [editing, setEditing] = createSignal(true);
  const [draft, setDraft] = createSignal("");
  const [magnet, setMagnet] = createSignal<MagnetLink | null>(null);
  const [file, setFile] = createSignal<ParsedTorrentFile | null>(null);
  const [existing, setExisting] = createSignal<ProxyTorrent | null>(null);
  const [paused, setPaused] = createSignal(false);
  const [addBusy, setAddBusy] = createSignal(false);
  const [addStatus, setAddStatus] = createSignal<StatusMessage>();
  const [addContext, setAddContext] = createSignal<IssueReportContext>();

  const [confirmingHash, setConfirmingHash] = createSignal<string>();
  const [removingHash, setRemovingHash] = createSignal<string>();
  const [downloadingHash, setDownloadingHash] = createSignal<string>();
  const [expandedHash, setExpandedHash] = createSignal<string>();
  const [filesByHash, setFilesByHash] = createSignal<Record<string, TorrentFile[]>>({});
  const [filesLoadingHash, setFilesLoadingHash] = createSignal<string>();
  const [filesError, setFilesError] = createSignal<string>();
  const [downloadingFile, setDownloadingFile] = createSignal<{ hash: string; index: number }>();
  const [togglingHash, setTogglingHash] = createSignal<string>();
  const [bulkAction, setBulkAction] = createSignal<"pause" | "resume">();

  let pollTimer: number | undefined;
  let generation = 0;
  let fetching = false;
  let reloadPending: ListOptions | null = null;
  let lastRefreshTrigger = props.refreshTrigger;
  let lookupToken = 0;
  let fileToken = 0;

  onMount(() => {
    void loadTorrents();

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearPollTimer();
        return;
      }
      void loadTorrents({ background: true, quiet: true });
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibilityChange));
  });

  // Saving client settings in another panel bumps `refreshTrigger`; reload the
  // list immediately instead of waiting for the next poll.
  createEffect(() => {
    const trigger = props.refreshTrigger;
    if (trigger === undefined || trigger === lastRefreshTrigger) return;
    lastRefreshTrigger = trigger;
    void loadTorrents({ quiet: true });
  });

  onCleanup(() => {
    generation += 1;
    clearPollTimer();
  });

  function clearPollTimer() {
    if (pollTimer !== undefined) {
      window.clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  }

  function schedulePoll() {
    clearPollTimer();
    if (document.visibilityState !== "visible") return;

    const token = generation;
    const active = torrents().some((torrent) => !isTorrentComplete(torrent));
    pollTimer = window.setTimeout(
      () => {
        pollTimer = undefined;
        if (token !== generation) return;
        void loadTorrents({ background: true });
      },
      active ? POLL_ACTIVE_MS : POLL_IDLE_MS,
    );
  }

  async function loadTorrents(options: ListOptions = {}) {
    const { background = false, quiet = false } = options;

    if (fetching) {
      // A foreground refresh after an add or removal should still run once the
      // request already in flight settles.
      if (!background) reloadPending = { background, quiet };
      return;
    }
    if (background && document.visibilityState !== "visible") {
      schedulePoll();
      return;
    }

    const token = generation;
    fetching = true;
    if (!background) {
      setRefreshing(true);
    }

    try {
      const list = await fetchTorrents();
      if (token !== generation) return;

      setTorrents(list);
      setConfigured(true);
      setLoaded(true);
      setListContext(undefined);
      if (!background && !quiet) setListStatus(undefined);
    } catch (error) {
      if (token !== generation) return;
      if (isSessionExpired(error)) return;

      if (
        error instanceof ProxyApiError &&
        error.status === 503 &&
        error.code === "not_configured"
      ) {
        closeAdd();
        setTorrents([]);
        setConfigured(false);
        setLoaded(true);
        setListStatus(undefined);
        setListContext(undefined);
        return;
      }

      // A background failure must not replace a list that is already on screen
      // with a red banner.
      if (background) return;

      setListStatus({ tone: "error", message: errorMessage(error) });
      setListContext(issueContextFromError(error, "Loading torrents"));
    } finally {
      if (token === generation) {
        fetching = false;
        setInitialLoading(false);
        setRefreshing(false);

        const pending = reloadPending;
        reloadPending = null;
        if (pending) void loadTorrents(pending);
        else schedulePoll();
      }
    }
  }

  function changeDraft(value: string) {
    setDraft(value);
    if (file() && value.trim()) {
      fileToken += 1;
      setFile(null);
      setEditing(true);
      setExisting(null);
    }
  }

  function applyDraft(event: SubmitEvent) {
    event.preventDefault();
    const uri = draft().trim();
    const parsed = parseMagnet(uri);

    if (!parsed) {
      setAddStatus({
        tone: "error",
        message: isMagnetLink(uri)
          ? "That magnet link cannot be read. Check the link and try again."
          : "Paste a magnet link that starts with magnet:?.",
      });
      setAddContext({ action: "Adding torrent", message: "The magnet link could not be parsed." });
      return;
    }

    fileToken += 1;
    setFile(null);
    setMagnet(parsed);
    setEditing(false);
    setExisting(null);
    setAddStatus(undefined);
    setAddContext(undefined);
    void lookup(parsed.infoHash);
  }

  async function handleFileSelect(chosen: File) {
    const token = ++fileToken;
    setAddStatus(undefined);
    setAddContext(undefined);

    try {
      const parsed = await parseTorrentFile(chosen);
      if (token !== fileToken) return;

      setFile(parsed);
      setMagnet(null);
      setDraft("");
      setEditing(false);
      setExisting(null);
      setAddStatus(undefined);
      void lookup(parsed.infoHash);
    } catch (error) {
      if (token !== fileToken) return;
      setAddStatus({ tone: "error", message: errorMessage(error) });
      setAddContext(issueContextFromError(error, "Reading .torrent file"));
    }
  }

  async function lookup(hash: string | null) {
    const token = ++lookupToken;
    if (!hash) {
      setExisting(null);
      return;
    }

    try {
      const torrent = await fetchTorrent(hash);
      if (token === lookupToken) setExisting(torrent);
    } catch (error) {
      if (isSessionExpired(error)) return;
      // A 404 is the normal "not there yet" answer; other failures are left to
      // the add request so the user gets one clear error.
      if (token === lookupToken) setExisting(null);
    }
  }

  function editAdd() {
    setEditing(true);
    setAddStatus(undefined);
    setAddContext(undefined);
    setExisting(null);
    if (magnet()) setDraft(magnet()?.uri ?? "");
  }

  function resetAdd() {
    lookupToken += 1;
    fileToken += 1;
    setEditing(true);
    setDraft("");
    setMagnet(null);
    setFile(null);
    setExisting(null);
    setPaused(false);
    setAddBusy(false);
    setAddStatus(undefined);
    setAddContext(undefined);
  }

  function openAdd() {
    resetAdd();
    setAddOpen(true);
  }

  function closeAdd() {
    resetAdd();
    setAddOpen(false);
  }

  function toggleAdd() {
    if (addOpen()) closeAdd();
    else openAdd();
  }

  async function submitAdd(event: SubmitEvent) {
    event.preventDefault();
    const selectedFile = file();
    const selectedMagnet = selectedFile ? null : magnet();
    if ((!selectedFile && !selectedMagnet) || existing() || addBusy()) return;

    setAddBusy(true);
    setAddStatus({ tone: "muted", message: "Adding torrent…" });
    setAddContext(undefined);

    const body: AddTorrentRequest = selectedFile
      ? {
          urls: [],
          files: [{ filename: selectedFile.filename, data: selectedFile.dataBase64 }],
          paused: paused(),
        }
      : { urls: [selectedMagnet?.uri ?? ""], files: [], paused: paused() };

    try {
      await addTorrents(body);
      const name = selectedFile
        ? torrentFileLabel(selectedFile)
        : selectedMagnet
          ? magnetLabel(selectedMagnet)
          : "torrent";
      closeAdd();
      setListStatus({ tone: "ok", message: `Added “${name}” to Remagnet Proxy.` });
      setListContext(undefined);
      await loadTorrents({ quiet: true });
    } catch (error) {
      if (isSessionExpired(error)) return;
      setAddStatus({ tone: "error", message: errorMessage(error) });
      setAddContext(issueContextFromError(error, "Adding torrent"));
    } finally {
      setAddBusy(false);
    }
  }

  async function download(torrent: CardTorrent) {
    if (downloadingHash()) return;

    setDownloadingHash(torrent.hash);
    setListStatus({ tone: "muted", message: "Preparing download…" });
    setListContext(undefined);

    try {
      const { ticket } = await createArchiveTicket(torrent.hash);

      // A real anchor click lets the browser start the download while the page
      // keeps polling.
      const anchor = document.createElement("a");
      anchor.href = archiveDownloadHref(torrent.hash, ticket);
      anchor.download = "";
      anchor.rel = "noreferrer";
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();

      setListStatus({ tone: "ok", message: "Preparing download…" });
    } catch (error) {
      if (isSessionExpired(error)) return;
      setListStatus({ tone: "error", message: errorMessage(error) });
      setListContext(issueContextFromError(error, "Preparing download"));
    } finally {
      setDownloadingHash(undefined);
    }
  }

  async function toggleFiles(torrent: CardTorrent) {
    if (expandedHash() === torrent.hash) {
      setExpandedHash(undefined);
      setFilesError(undefined);
      return;
    }

    const hash = torrent.hash;
    setExpandedHash(hash);
    setFilesError(undefined);
    setFilesLoadingHash(hash);
    try {
      const files = await fetchTorrentFiles(hash);
      setFilesByHash((current) => ({ ...current, [hash]: files }));
    } catch (error) {
      if (isSessionExpired(error)) return;
      setFilesError(errorMessage(error));
    } finally {
      setFilesLoadingHash((current) => (current === hash ? undefined : current));
    }
  }

  async function downloadFile(torrent: CardTorrent, file: TorrentFile) {
    if (downloadingHash() || downloadingFile()) return;

    setDownloadingFile({ hash: torrent.hash, index: file.index });
    setListStatus({
      tone: "muted",
      message: `Preparing download for ${fileBasename(file.name)}…`,
    });
    setListContext(undefined);

    try {
      const { ticket } = await createFileArchiveTicket(torrent.hash, file.index);

      // Same anchor pattern as the ZIP download: the browser handles the file
      // while the page keeps polling.
      const anchor = document.createElement("a");
      anchor.href = fileArchiveDownloadHref(torrent.hash, file.index, ticket);
      anchor.download = "";
      anchor.rel = "noreferrer";
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();

      setListStatus({ tone: "ok", message: `Downloading ${fileBasename(file.name)}…` });
    } catch (error) {
      if (isSessionExpired(error)) return;
      setListStatus({ tone: "error", message: errorMessage(error) });
      setListContext(issueContextFromError(error, "Downloading file"));
    } finally {
      setDownloadingFile(undefined);
    }
  }

  function toggleRemove(torrent: CardTorrent) {
    setConfirmingHash(confirmingHash() === torrent.hash ? undefined : torrent.hash);
  }

  async function remove(torrent: CardTorrent, deleteFiles: boolean) {
    setConfirmingHash(torrent.hash);
    setRemovingHash(torrent.hash);
    setListStatus({
      tone: "muted",
      message: deleteFiles ? "Removing torrent and files…" : "Removing torrent…",
    });
    setListContext(undefined);

    try {
      await removeTorrent(torrent.hash, deleteFiles);
      setConfirmingHash(undefined);
      setRemovingHash(undefined);
      setListStatus({
        tone: "ok",
        message: deleteFiles
          ? `Removed ${torrent.name} and its files.`
          : `Removed ${torrent.name}.`,
      });
      await loadTorrents({ quiet: true });
    } catch (error) {
      setRemovingHash(undefined);
      if (isSessionExpired(error)) return;
      setListStatus({ tone: "error", message: errorMessage(error) });
      setListContext(issueContextFromError(error, "Removing torrent"));
    }
  }

  function cancelRemove() {
    setConfirmingHash(undefined);
  }

  async function togglePause(torrent: CardTorrent) {
    if (togglingHash() || bulkAction()) return;

    const paused = isTorrentPaused(torrent);
    setTogglingHash(torrent.hash);
    setListContext(undefined);
    setListStatus({ tone: "muted", message: paused ? "Resuming torrent…" : "Pausing torrent…" });

    try {
      await (paused ? resumeTorrent(torrent.hash) : pauseTorrent(torrent.hash));
      setListStatus({
        tone: "ok",
        message: paused ? `Resumed ${torrent.name}.` : `Paused ${torrent.name}.`,
      });
      await loadTorrents({ quiet: true });
    } catch (error) {
      if (isSessionExpired(error)) return;
      setListStatus({ tone: "error", message: errorMessage(error) });
      setListContext(issueContextFromError(error, paused ? "Resuming torrent" : "Pausing torrent"));
    } finally {
      setTogglingHash(undefined);
    }
  }

  async function pauseAll() {
    if (bulkAction() || togglingHash()) return;

    setBulkAction("pause");
    setListContext(undefined);
    setListStatus({ tone: "muted", message: "Pausing all torrents…" });

    try {
      await pauseAllTorrents();
      setListStatus({ tone: "ok", message: "Paused all torrents." });
      await loadTorrents({ quiet: true });
    } catch (error) {
      if (isSessionExpired(error)) return;
      setListStatus({ tone: "error", message: errorMessage(error) });
      setListContext(issueContextFromError(error, "Pausing all torrents"));
    } finally {
      setBulkAction(undefined);
    }
  }

  async function resumeAll() {
    if (bulkAction() || togglingHash()) return;

    setBulkAction("resume");
    setListContext(undefined);
    setListStatus({ tone: "muted", message: "Resuming all torrents…" });

    try {
      await resumeAllTorrents();
      setListStatus({ tone: "ok", message: "Resumed all torrents." });
      await loadTorrents({ quiet: true });
    } catch (error) {
      if (isSessionExpired(error)) return;
      setListStatus({ tone: "error", message: errorMessage(error) });
      setListContext(issueContextFromError(error, "Resuming all torrents"));
    } finally {
      setBulkAction(undefined);
    }
  }

  function reportListIssue() {
    const context = listContext();
    if (context) props.onReportIssue?.(context);
  }

  function reportAddIssue() {
    const context = addContext();
    if (context) props.onReportIssue?.(context);
  }

  function resetFilters() {
    setQuery("");
    setFilter("all");
  }

  const canAdd = () => configured() !== false;
  const hasActive = () => torrents().some((torrent) => !isTorrentPaused(torrent));
  const hasPaused = () => torrents().some((torrent) => isTorrentPaused(torrent));
  const showEmpty = () => loaded() && torrents().length === 0 && !listStatus();
  const showReview = () => !editing() && Boolean(magnet() ?? file());

  return (
    <section class="panel stack">
      <div class="panel-head">
        <div class="panel-title">
          <h2>Torrents</h2>
          <Show when={torrents().length >= COUNT_BADGE_MIN}>
            <span class="count-badge" title={`${torrents().length} torrents`}>
              {torrents().length}
            </span>
          </Show>
        </div>
        <div class="actions">
          <Show when={hasActive()}>
            <button
              type="button"
              class="ghost"
              disabled={Boolean(bulkAction()) || Boolean(togglingHash())}
              onClick={() => void pauseAll()}
            >
              Pause all
            </button>
          </Show>
          <Show when={hasPaused()}>
            <button
              type="button"
              class="ghost"
              disabled={Boolean(bulkAction()) || Boolean(togglingHash())}
              onClick={() => void resumeAll()}
            >
              Resume all
            </button>
          </Show>
          <button
            type="button"
            aria-expanded={addOpen()}
            aria-controls="proxy-torrent-add"
            disabled={!canAdd()}
            onClick={toggleAdd}
          >
            + Add
          </button>
          <button
            type="button"
            class="ghost"
            disabled={refreshing()}
            aria-busy={refreshing()}
            onClick={() => void loadTorrents()}
          >
            Refresh
          </button>
        </div>
      </div>

      <Show when={addOpen()}>
        <div id="proxy-torrent-add" class="subsection stack">
          <Show
            when={showReview()}
            fallback={
              <MagnetForm
                draft={draft()}
                canCancel
                onDraftChange={changeDraft}
                onSubmit={applyDraft}
                onCancel={() => {
                  if (magnet() ?? file()) setEditing(false);
                  else closeAdd();
                }}
                onFileSelect={(chosen) => void handleFileSelect(chosen)}
              />
            }
          >
            <MagnetReview
              link={magnet() ?? undefined}
              file={file() ?? undefined}
              existing={existing()}
              paused={paused()}
              busy={addBusy()}
              onEdit={editAdd}
              onSubmit={submitAdd}
              onPausedChange={setPaused}
            />
            <div class="actions">
              <button type="button" class="ghost" onClick={closeAdd}>
                Close
              </button>
            </div>
          </Show>

          <StatusLine
            status={addStatus()}
            onReport={props.onReportIssue ? reportAddIssue : undefined}
          />
        </div>
      </Show>

      <StatusLine
        status={listStatus()}
        onReport={props.onReportIssue ? reportListIssue : undefined}
      />

      <Show when={configured() === false}>
        <p class="muted">
          Configure a torrent client in the proxy settings to list and manage torrents.
        </p>
      </Show>

      <Show when={configured() !== false}>
        <Show when={!loaded() && initialLoading() && !listStatus()}>
          <p class="muted">Loading torrents…</p>
        </Show>

        <Show when={showEmpty()}>
          <p class="muted">No torrents yet. Use + Add to add a magnet link or .torrent file.</p>
        </Show>

        <Show when={torrents().length > 0}>
          <Show when={showControls()}>
            <TorrentListControls
              query={query()}
              filter={filter()}
              sort={sort()}
              counts={filterCounts()}
              onQueryChange={setQuery}
              onFilterChange={setFilter}
              onSortChange={setSort}
            />
          </Show>

          <Show
            when={visibleTorrents().length > 0}
            fallback={
              <div class="list-empty-filter">
                <p class="muted">No torrents match your filter.</p>
                <button type="button" class="ghost" onClick={resetFilters}>
                  Reset filters
                </button>
              </div>
            }
          >
            <ul class="torrent-list proxy-torrent-list">
              {/* Index keeps each row's bar alive while polled data replaces the
                  objects, so the fill animation does not replay on every refresh. */}
              <Index each={visibleTorrents()}>
                {(torrent) => (
                  <TorrentCard
                    torrent={torrent()}
                    zipping={downloadingHash() === torrent().hash}
                    removing={removingHash() === torrent().hash}
                    confirming={confirmingHash() === torrent().hash}
                    togglingPause={togglingHash() === torrent().hash || Boolean(bulkAction())}
                    onTogglePause={() => void togglePause(torrent())}
                    zipDisabled={props.health?.capabilities?.archiveDownload === false}
                    zipTitle={
                      props.health?.capabilities?.archiveDownload === false
                        ? "Configure a downloads directory in the proxy settings to enable ZIP archives"
                        : "Download this completed torrent"
                    }
                    filesOpen={expandedHash() === torrent().hash}
                    files={filesByHash()[torrent().hash]}
                    filesLoading={filesLoadingHash() === torrent().hash}
                    filesError={expandedHash() === torrent().hash ? filesError() : undefined}
                    downloadingFileIndex={
                      downloadingFile()?.hash === torrent().hash
                        ? downloadingFile()?.index
                        : undefined
                    }
                    onToggleFiles={() => void toggleFiles(torrent())}
                    onDownloadFile={(selected) => void downloadFile(torrent(), selected)}
                    onZip={() => void download(torrent())}
                    onRemoveToggle={() => toggleRemove(torrent())}
                    onRemove={(deleteFiles) => void remove(torrent(), deleteFiles)}
                    onCancelRemove={cancelRemove}
                  />
                )}
              </Index>
            </ul>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
