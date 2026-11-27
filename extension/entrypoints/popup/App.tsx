import {
  errorMessage,
  type IssueReportContext,
  issueContextFromError,
  isTorrentComplete,
  isTorrentPaused,
  type TorrentFile,
} from "@remagnet/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { browser } from "wxt/browser";
import AddTorrent from "../../components/AddTorrent";
import IssueReportDialog from "../../components/IssueReportDialog";
import PopupList from "../../components/PopupList";
import Wordmark from "../../components/Wordmark";
import { parseMagnet } from "../../lib/magnet";
import {
  type ArchiveDownloadResult,
  type BulkTorrentActionResult,
  type PauseTorrentsResult,
  type RemoveTorrentsResult,
  type ResumeTorrentsResult,
  sendBackgroundMessage,
  type TorrentFilesResult,
  type TorrentListResult,
  type TorrentLookupResult,
} from "../../lib/messages";
import { pendingMagnetItem } from "../../lib/pending-magnet";
import { getSettings, isProxyConfigured, type Settings } from "../../lib/settings";
import type { TorrentSummary } from "../../lib/torrents";

/** A moving torrent is polled every second so the bars feel live. */
const ACTIVE_REFRESH_MS = 1_000;
/** Nothing in flight: keep the list current without hammering the client. */
const IDLE_REFRESH_MS = 5_000;

type View = "list" | "add";

export default function App() {
  const [settings, setSettings] = createSignal<Settings>();
  const [torrents, setTorrents] = createSignal<TorrentListResult["torrents"]>([]);
  const [view, setView] = createSignal<View>("list");
  const [pendingMagnet, setPendingMagnet] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [downloading, setDownloading] = createSignal<string>();
  const [removing, setRemoving] = createSignal<string>();
  const [confirmingRemove, setConfirmingRemove] = createSignal<string>();
  const [togglingHash, setTogglingHash] = createSignal<string>();
  const [bulkAction, setBulkAction] = createSignal<"pause" | "resume">();
  const [expandedHash, setExpandedHash] = createSignal<string>();
  const [filesByHash, setFilesByHash] = createSignal<Record<string, TorrentFile[]>>({});
  const [filesLoadingHash, setFilesLoadingHash] = createSignal<string>();
  const [filesError, setFilesError] = createSignal<string>();
  const [downloadingFile, setDownloadingFile] = createSignal<{ hash: string; index: number }>();
  const [error, setError] = createSignal<string>();
  const [actionError, setActionError] = createSignal<string>();
  const [errorContext, setErrorContext] = createSignal<IssueReportContext>();
  const [reportOpen, setReportOpen] = createSignal(false);

  let refreshing = false;

  /** The popover has nothing to show until both proxy fields are set. */
  const configured = () => {
    const current = settings();
    return current ? isProxyConfigured(current) : false;
  };

  onMount(() => {
    void loadSettings();

    // The popover is a normal page, so it can poll while it is open. Schedule
    // the next request only after the previous one finishes: a slow client must
    // not build up a queue of list calls. Background notifications cover the
    // case where the popover is closed.
    let stopped = false;
    let timer: number | undefined;

    const schedule = () => {
      const active = torrents().some((torrent) => !isTorrentComplete(torrent));
      timer = window.setTimeout(poll, active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
    };

    const poll = async () => {
      if (stopped) return;
      // The add view covers the list, so there is nothing to update behind it.
      if (document.visibilityState === "visible" && view() === "list") {
        await refresh(true);
      }
      if (!stopped) schedule();
    };

    schedule();

    onCleanup(() => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    });

    // A magnet clicked in a page is handed over by add.html; the popover is the
    // only surface that shows the add flow. A hash the client already has stays
    // on the list instead of asking to add it again.
    const accept = (value: string | null) => {
      if (value) void acceptMagnet(value);
    };
    void pendingMagnetItem.getValue().then(accept);
    const unwatch = pendingMagnetItem.watch(accept);
    onCleanup(unwatch);
  });

  async function loadSettings() {
    try {
      const current = await getSettings();
      setSettings(current);
      if (isProxyConfigured(current)) {
        await refresh();
      } else {
        setLoading(false);
      }
    } catch {
      setLoading(false);
    }
  }

  /** Open the review screen, unless the client already has this torrent. */
  async function acceptMagnet(value: string) {
    const hash = parseMagnet(value)?.infoHash ?? null;
    if (hash && configured()) {
      try {
        const result = await sendBackgroundMessage<TorrentLookupResult>({
          type: "torrents:get",
          hash,
        });
        if (result.torrent) {
          setPendingMagnet("");
          setView("list");
          void pendingMagnetItem.setValue(null);
          void refresh(true);
          return;
        }
      } catch {
        // Unconfigured or unreachable: fall back to the review screen, where
        // sending will surface the real error.
      }
    }

    setPendingMagnet(value);
    setView("add");
    void pendingMagnetItem.setValue(null);
  }

  async function refresh(silent = false) {
    if (refreshing) return;

    // A fresh install has no proxy yet. Leave the list empty and let the
    // "Get started" panel explain what to do instead of showing a red error.
    if (!configured()) {
      if (!silent) {
        setLoading(false);
        setError();
        setErrorContext();
      }
      return;
    }

    refreshing = true;

    if (!silent) {
      setLoading(true);
      setError();
      setActionError();
      setErrorContext();
    }

    try {
      const result = await sendBackgroundMessage<TorrentListResult>({ type: "torrents:list" });
      setTorrents(result.torrents);
      if (silent) setError();
    } catch (cause) {
      if (silent) {
        console.warn("[remagnet] background refresh failed", cause);
      } else {
        setError(errorMessage(cause));
        setErrorContext(issueContextFromError(cause, "Listing torrents"));
      }
    } finally {
      refreshing = false;
      if (!silent) setLoading(false);
    }
  }

  function startAdd() {
    if (!configured()) return;
    setPendingMagnet("");
    setView("add");
  }

  function closeAdd() {
    setView("list");
    setPendingMagnet("");
    void refresh(true);
  }

  async function downloadZip(torrent: TorrentSummary) {
    setDownloading(torrent.hash);
    setActionError();
    setErrorContext();
    try {
      await sendBackgroundMessage<ArchiveDownloadResult>({
        type: "archive:download",
        hash: torrent.hash,
        name: torrent.name,
      });
    } catch (cause) {
      setActionError(errorMessage(cause));
      setErrorContext(issueContextFromError(cause, "Downloading ZIP"));
    } finally {
      setDownloading();
    }
  }

  async function toggleFiles(torrent: TorrentSummary) {
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
      const result = await sendBackgroundMessage<TorrentFilesResult>({
        type: "torrents:files",
        hash,
      });
      setFilesByHash((current) => ({ ...current, [hash]: result.files }));
    } catch (cause) {
      if (expandedHash() === hash) setFilesError(errorMessage(cause));
    } finally {
      setFilesLoadingHash((current) => (current === hash ? undefined : current));
    }
  }

  async function downloadFile(torrent: TorrentSummary, file: TorrentFile) {
    setDownloadingFile({ hash: torrent.hash, index: file.index });
    setActionError();
    setErrorContext();
    try {
      await sendBackgroundMessage<ArchiveDownloadResult>({
        type: "archive:downloadFile",
        hash: torrent.hash,
        index: file.index,
        name: file.name,
      });
    } catch (cause) {
      setActionError(errorMessage(cause));
      setErrorContext(issueContextFromError(cause, "Downloading file"));
    } finally {
      setDownloadingFile();
    }
  }

  async function removeTorrent(torrent: TorrentSummary, deleteFiles: boolean) {
    setRemoving(torrent.hash);
    setActionError();
    setErrorContext();
    try {
      await sendBackgroundMessage<RemoveTorrentsResult>({
        type: "torrents:remove",
        hashes: [torrent.hash],
        deleteFiles,
      });
      setTorrents((current) => current.filter((entry) => entry.hash !== torrent.hash));
      setConfirmingRemove();
    } catch (cause) {
      setActionError(errorMessage(cause));
      setErrorContext(issueContextFromError(cause, "Removing torrent"));
    } finally {
      setRemoving();
    }
  }

  async function togglePause(torrent: TorrentSummary) {
    if (bulkAction() || togglingHash()) return;

    const resuming = isTorrentPaused(torrent);
    setTogglingHash(torrent.hash);
    setActionError();
    setErrorContext();
    try {
      if (resuming) {
        await sendBackgroundMessage<ResumeTorrentsResult>({
          type: "torrents:resume",
          hashes: [torrent.hash],
        });
      } else {
        await sendBackgroundMessage<PauseTorrentsResult>({
          type: "torrents:pause",
          hashes: [torrent.hash],
        });
      }
      await refresh(true);
    } catch (cause) {
      setActionError(errorMessage(cause));
      setErrorContext(
        issueContextFromError(cause, resuming ? "Resuming torrent" : "Pausing torrent"),
      );
    } finally {
      setTogglingHash();
    }
  }

  async function pauseAll() {
    if (bulkAction() || togglingHash()) return;

    setBulkAction("pause");
    setActionError();
    setErrorContext();
    try {
      await sendBackgroundMessage<BulkTorrentActionResult>({ type: "torrents:pauseAll" });
      await refresh(true);
    } catch (cause) {
      setActionError(errorMessage(cause));
      setErrorContext(issueContextFromError(cause, "Pausing all torrents"));
    } finally {
      setBulkAction();
    }
  }

  async function resumeAll() {
    if (bulkAction() || togglingHash()) return;

    setBulkAction("resume");
    setActionError();
    setErrorContext();
    try {
      await sendBackgroundMessage<BulkTorrentActionResult>({ type: "torrents:resumeAll" });
      await refresh(true);
    } catch (cause) {
      setActionError(errorMessage(cause));
      setErrorContext(issueContextFromError(cause, "Resuming all torrents"));
    } finally {
      setBulkAction();
    }
  }

  function openIssueReport() {
    setReportOpen(true);
  }

  const serverLabel = () => settings()?.proxyBaseUrl ?? "Loading…";
  /** A label only: the dialog must never receive a proxy URL in `backend`. */
  const backendLabel = () => (configured() ? "Remagnet Proxy" : undefined);

  return (
    <main class="popup">
      <Show
        when={view() === "add"}
        fallback={
          <PopupList
            torrents={torrents()}
            loading={loading()}
            configured={configured()}
            error={error()}
            actionError={actionError()}
            serverLabel={serverLabel()}
            downloadingHash={downloading()}
            removingHash={removing()}
            confirmingHash={confirmingRemove()}
            togglingHash={togglingHash()}
            bulkAction={bulkAction()}
            expandedHash={expandedHash()}
            filesByHash={filesByHash()}
            filesLoadingHash={filesLoadingHash()}
            filesError={filesError()}
            downloadingFile={downloadingFile()}
            onRetry={() => void refresh()}
            onOpenSettings={() => void browser.runtime.openOptionsPage()}
            onDismissActionError={() => setActionError()}
            onReportError={openIssueReport}
            onReportActionError={openIssueReport}
            onAdd={startAdd}
            onZip={(torrent) => void downloadZip(torrent)}
            onToggleFiles={(torrent) => void toggleFiles(torrent)}
            onDownloadFile={(torrent, file) => void downloadFile(torrent, file)}
            onTogglePause={(torrent) => void togglePause(torrent)}
            onPauseAll={() => void pauseAll()}
            onResumeAll={() => void resumeAll()}
            onRemoveToggle={(torrent) =>
              setConfirmingRemove(confirmingRemove() === torrent.hash ? undefined : torrent.hash)
            }
            onRemove={(torrent, deleteFiles) => void removeTorrent(torrent, deleteFiles)}
            onCancelRemove={() => setConfirmingRemove()}
          />
        }
      >
        <header class="popup-header add-header">
          <div class="header-text">
            <div class="title-row">
              <Wordmark as="h1" title={`Remagnet Proxy · ${serverLabel()}`} />
            </div>
          </div>
          <button
            class="ghost icon-button back-button"
            type="button"
            title="Back to torrents"
            aria-label="Back to torrents"
            onClick={closeAdd}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M9.75 3.5 5.25 8l4.5 4.5" />
            </svg>
          </button>
        </header>
        <AddTorrent
          initialMagnet={pendingMagnet()}
          embedded
          onClose={closeAdd}
          onAdded={closeAdd}
        />
      </Show>

      <IssueReportDialog
        open={reportOpen()}
        context={errorContext()}
        backend={backendLabel()}
        onClose={() => setReportOpen(false)}
      />
    </main>
  );
}
