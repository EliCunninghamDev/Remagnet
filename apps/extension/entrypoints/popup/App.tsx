import { createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { browser } from "wxt/browser";
import AddTorrent from "../../components/AddTorrent";
import SquareBar, { type BarPhase } from "../../components/SquareBar";
import { getArchiveSettings } from "../../lib/archive";
import { getTorrentClientDefinition } from "../../lib/clients/catalog";
import { formatBytes, formatEta, formatPercent, stateLabel, stateTone } from "../../lib/format";
import { parseMagnet } from "../../lib/magnet";
import {
  type ArchiveDownloadResult,
  COMPLETE_PROGRESS,
  type RemoveTorrentsResult,
  sendBackgroundMessage,
  type TorrentListResult,
  type TorrentLookupResult,
} from "../../lib/messages";
import { pendingMagnetItem } from "../../lib/pending-magnet";
import { getTorrentFilter } from "../../lib/relevance";
import { getSettings, type Settings } from "../../lib/settings";
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
  const [error, setError] = createSignal<string>();
  const [actionError, setActionError] = createSignal<string>();

  let refreshing = false;

  onMount(() => {
    void getSettings().then(setSettings);
    void refresh();

    // The popover is a normal page, so it can poll while it is open. Schedule
    // the next request only after the previous one finishes: a slow client must
    // not build up a queue of list calls. Background notifications cover the
    // case where the popover is closed.
    let stopped = false;
    let timer: number | undefined;

    const schedule = () => {
      const active = torrents().some((torrent) => torrent.progress < COMPLETE_PROGRESS);
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

  /** Open the review screen, unless the client already has this torrent. */
  async function acceptMagnet(value: string) {
    const hash = parseMagnet(value)?.infoHash ?? null;
    if (hash) {
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
    refreshing = true;

    if (!silent) {
      setLoading(true);
      setError();
      setActionError();
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
      }
    } finally {
      refreshing = false;
      if (!silent) setLoading(false);
    }
  }

  function startAdd() {
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
    try {
      await sendBackgroundMessage<ArchiveDownloadResult>({
        type: "archive:download",
        hash: torrent.hash,
        name: torrent.name,
      });
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setDownloading();
    }
  }

  async function removeTorrent(torrent: TorrentSummary, deleteFiles: boolean) {
    setRemoving(torrent.hash);
    setActionError();
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
    } finally {
      setRemoving();
    }
  }

  const archiveReady = createMemo(() => {
    const current = settings();
    return current ? getArchiveSettings(current) !== null : false;
  });

  const filter = createMemo(() => {
    const current = settings();
    return current
      ? getTorrentFilter(current)
      : { active: false, category: "", tags: [] as string[] };
  });

  const filterDescription = createMemo(() => {
    const { category, tags } = filter();
    const parts: string[] = [];
    if (category) parts.push(`category '${category}'`);
    if (tags.length > 0) {
      const label = tags.length === 1 ? "tag" : "tags";
      parts.push(`${label} ${tags.map((tag) => `'${tag}'`).join(", ")}`);
    }
    return parts.join(" or ");
  });

  const clientLabel = createMemo(() => {
    const current = settings();
    return current ? getTorrentClientDefinition(current.client).label : "Loading…";
  });

  const serverLabel = () => settings()?.baseUrl ?? "Loading…";

  return (
    <main class="popup">
      <Show
        when={view() === "add"}
        fallback={
          <>
            <header class="popup-header">
              <div class="header-text">
                <div class="title-row">
                  <h1 class="wordmark" title={`${clientLabel()} · ${serverLabel()}`}>
                    Remagnet
                  </h1>
                  <Show when={torrents().length >= 2}>
                    <span class="count-badge mono">{torrents().length}</span>
                  </Show>
                </div>
              </div>
              <div class="header-actions">
                <button
                  class="add-button"
                  type="button"
                  title="Add a magnet link"
                  onClick={startAdd}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 3.5v9M3.5 8h9" />
                  </svg>
                  Add
                </button>
                <button
                  class="ghost icon-button"
                  type="button"
                  title="Settings"
                  aria-label="Settings"
                  onClick={() => void browser.runtime.openOptionsPage()}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M2.5 4.5h11M2.5 11.5h11" />
                    <circle cx="6" cy="4.5" r="1.6" />
                    <circle cx="10.5" cy="11.5" r="1.6" />
                  </svg>
                </button>
              </div>
            </header>

            <Show when={error()}>
              {(message) => (
                <div class="stack-tight">
                  <p class="status error">{message()}</p>
                  <div class="actions">
                    <button type="button" disabled={loading()} onClick={() => void refresh()}>
                      Retry
                    </button>
                    <button
                      class="ghost"
                      type="button"
                      onClick={() => void browser.runtime.openOptionsPage()}
                    >
                      Open settings
                    </button>
                  </div>
                </div>
              )}
            </Show>

            <Show when={actionError()}>
              {(message) => (
                <p class="status error">
                  {message()}{" "}
                  <button class="linkish" type="button" onClick={() => setActionError()}>
                    Dismiss
                  </button>
                </p>
              )}
            </Show>

            <Show when={!error()}>
              <Show
                when={!loading() || torrents().length > 0}
                fallback={<p class="muted">Loading torrents…</p>}
              >
                <Show
                  when={torrents().length > 0}
                  fallback={
                    <Show
                      when={filter().active}
                      fallback={<p class="muted empty">No torrents in {clientLabel()}.</p>}
                    >
                      <p class="muted empty">
                        No Remagnet torrents yet. Add a magnet to see it here; matching uses{" "}
                        {filterDescription()}.
                      </p>
                    </Show>
                  }
                >
                  <ul class="torrent-list">
                    {/*
                      Index (not For) keeps each row's DOM and canvas alive while
                      the polled list replaces its objects. For would remount
                      every bar on every refresh and replay the fill and sweep.
                    */}
                    <Index each={torrents()}>
                      {(torrent) => (
                        <TorrentCard
                          torrent={torrent()}
                          zipping={downloading() === torrent().hash}
                          archiveReady={archiveReady()}
                          clientLabel={clientLabel()}
                          removing={removing() === torrent().hash}
                          confirming={confirmingRemove() === torrent().hash}
                          onZip={() => void downloadZip(torrent())}
                          onRemoveToggle={() =>
                            setConfirmingRemove(
                              confirmingRemove() === torrent().hash ? undefined : torrent().hash,
                            )
                          }
                          onRemove={(deleteFiles) => void removeTorrent(torrent(), deleteFiles)}
                          onCancelRemove={() => setConfirmingRemove()}
                        />
                      )}
                    </Index>
                  </ul>
                </Show>
              </Show>
            </Show>
          </>
        }
      >
        <header class="popup-header add-header">
          <div class="header-text">
            <div class="title-row">
              <h1 class="wordmark" title={`${clientLabel()} · ${serverLabel()}`}>
                Remagnet
              </h1>
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
    </main>
  );
}

interface TorrentCardProps {
  torrent: TorrentSummary;
  zipping: boolean;
  archiveReady: boolean;
  clientLabel: string;
  removing: boolean;
  confirming: boolean;
  onZip: () => void;
  onRemoveToggle: () => void;
  onRemove: (deleteFiles: boolean) => void;
  onCancelRemove: () => void;
}

function TorrentCard(props: TorrentCardProps) {
  const complete = () => props.torrent.progress >= COMPLETE_PROGRESS;
  const status = () => {
    if (props.zipping) return { tone: "zip", label: "Zipping" };
    if (complete()) return { tone: "done", label: "Ready" };
    const tone = stateTone(props.torrent.state);
    if (tone === "bad") return { tone: "bad", label: stateLabel(props.torrent.state) };
    if (tone === "warn") return { tone: "zip", label: "Stalled" };
    if (props.torrent.state === "stopped") return { tone: "idle", label: "Paused" };
    return { tone: tone === "active" ? "fetch" : "idle", label: stateLabel(props.torrent.state) };
  };

  const phase = (): BarPhase => {
    if (props.zipping) return "zip";
    return complete() ? "done" : "fetch";
  };

  /** An unknown ETA is a dash; leave the field out instead of showing it. */
  const eta = () => {
    const value = formatEta(props.torrent.eta);
    return value === "—" ? undefined : value;
  };

  const downloaded = () => formatBytes(props.torrent.progress * props.torrent.size);

  return (
    <li class="torrent">
      <div class="torrent-head">
        <span class="torrent-name" title={props.torrent.name}>
          {props.torrent.name}
        </span>
        <span class="torrent-status mono" data-s={status().tone}>
          {status().label}
        </span>
        <span class="torrent-percent mono">{formatPercent(props.torrent.progress)}</span>
        <Show when={props.archiveReady && complete()}>
          <button
            class="row-icon zip-action"
            type="button"
            disabled={props.zipping}
            title="Download this completed torrent as a ZIP"
            onClick={() => props.onZip()}
          >
            ZIP
          </button>
        </Show>
        <button
          class="row-icon remove-action"
          type="button"
          disabled={props.removing}
          title="Remove this torrent from the client"
          aria-label="Remove torrent"
          onClick={() => props.onRemoveToggle()}
        >
          ×
        </button>
      </div>

      <SquareBar progress={props.torrent.progress} phase={phase()} />

      <div class="torrent-stats mono">
        <span>
          <b>{formatBytes(props.torrent.downloadSpeed)}</b>/s
        </span>
        <Show when={eta()}>
          {(value) => (
            <span>
              ETA <b>{value()}</b>
            </span>
          )}
        </Show>
        <Show when={props.torrent.uploadSpeed > 0}>
          <span>
            ↑ <b>{formatBytes(props.torrent.uploadSpeed)}</b>/s
          </span>
        </Show>
        <span>
          <b>{downloaded()}</b> / {formatBytes(props.torrent.size)}
        </span>
        <span>
          <b>
            {props.torrent.peers}/{props.torrent.seeds}
          </b>{" "}
          peers
        </span>
      </div>

      <Show when={props.confirming}>
        <div class="remove-confirm">
          <span class="muted">
            Remove from {props.clientLabel}? Keep the downloaded data or delete it.
          </span>
          <div class="actions">
            <button
              class="ghost"
              type="button"
              disabled={props.removing}
              onClick={() => props.onRemove(false)}
            >
              Keep files
            </button>
            <button
              class="ghost danger"
              type="button"
              disabled={props.removing}
              onClick={() => props.onRemove(true)}
            >
              Delete files
            </button>
            <button class="ghost" type="button" onClick={() => props.onCancelRemove()}>
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </li>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
