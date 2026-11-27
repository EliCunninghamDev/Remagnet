import {
  COUNT_BADGE_MIN,
  countTorrentFilters,
  filterAndSortTorrents,
  isTorrentPaused,
  type TorrentFile,
  type TorrentFilter,
  TorrentListControls,
  type TorrentSort,
} from "@remagnet/ui";
import { createMemo, createSignal, Index, Show } from "solid-js";
import type { TorrentSummary } from "../lib/torrents";
import TorrentCard from "./TorrentCard";
import Wordmark from "./Wordmark";

export interface PopupListProps {
  torrents: TorrentSummary[];
  loading: boolean;
  /** False on a fresh install, before a proxy has been paired or configured. */
  configured: boolean;
  error?: string;
  actionError?: string;
  /** Proxy URL shown alongside the wordmark in its tooltip. */
  serverLabel?: string;
  downloadingHash?: string;
  removingHash?: string;
  confirmingHash?: string;
  /** Hash of the torrent whose pause/resume request is in flight. */
  togglingHash?: string;
  /** A bulk pause or resume is in flight; row controls stay disabled. */
  bulkAction?: "pause" | "resume";
  /** Hash of the torrent whose file browser is expanded. */
  expandedHash?: string;
  /** Files already fetched, keyed by torrent hash. */
  filesByHash?: Record<string, TorrentFile[]>;
  /** Hash of the torrent whose file list is being fetched. */
  filesLoadingHash?: string;
  /** Error shown inside the expanded file browser. */
  filesError?: string;
  /** File whose download is in flight. */
  downloadingFile?: { hash: string; index: number };
  onRetry: () => void;
  onOpenSettings: () => void;
  onDismissActionError: () => void;
  /** Optional opt-in report trigger; omitted by the gallery and older tests. */
  onReportError?: () => void;
  /** Optional report trigger for a failed row action. */
  onReportActionError?: () => void;
  onAdd: () => void;
  onZip: (torrent: TorrentSummary) => void;
  onToggleFiles?: (torrent: TorrentSummary) => void;
  onDownloadFile?: (torrent: TorrentSummary, file: TorrentFile) => void;
  onTogglePause?: (torrent: TorrentSummary) => void;
  onPauseAll?: () => void;
  onResumeAll?: () => void;
  onRemoveToggle: (torrent: TorrentSummary) => void;
  onRemove: (torrent: TorrentSummary, deleteFiles: boolean) => void;
  onCancelRemove: () => void;
}

/**
 * The popover's default view: heading, actions, and the torrent list.
 *
 * It takes plain data and callbacks rather than reading storage or talking to
 * the background worker, which keeps every list state renderable in the
 * component gallery and in tests.
 */
export default function PopupList(props: PopupListProps) {
  const wordmarkTitle = () =>
    props.serverLabel ? `Remagnet Proxy · ${props.serverLabel}` : "Remagnet Proxy";

  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<TorrentFilter>("all");
  const [sort, setSort] = createSignal<TorrentSort>("added");

  const filterCounts = createMemo(() => countTorrentFilters(props.torrents));
  const visibleTorrents = createMemo(() =>
    filterAndSortTorrents(props.torrents, { query: query(), filter: filter(), sort: sort() }),
  );
  const showControls = () =>
    props.torrents.length >= COUNT_BADGE_MIN || query().trim().length > 0 || filter() !== "all";

  const hasActive = () => props.torrents.some((torrent) => !isTorrentPaused(torrent));
  const hasPaused = () => props.torrents.some((torrent) => isTorrentPaused(torrent));

  function resetFilters() {
    setQuery("");
    setFilter("all");
  }

  return (
    <>
      <header class="popup-header">
        <div class="header-text">
          <div class="title-row">
            <Wordmark as="h1" title={wordmarkTitle()} />
            <Show when={props.torrents.length >= COUNT_BADGE_MIN}>
              <span class="count-badge mono">{props.torrents.length}</span>
            </Show>
          </div>
        </div>
        <div class="header-actions">
          <Show when={props.configured && props.onPauseAll && hasActive()}>
            <button
              class="ghost icon-button"
              type="button"
              title="Pause all torrents"
              aria-label="Pause all torrents"
              disabled={Boolean(props.bulkAction)}
              onClick={() => props.onPauseAll?.()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M5.5 3.5v9M10.5 3.5v9" />
              </svg>
            </button>
          </Show>
          <Show when={props.configured && props.onResumeAll && hasPaused()}>
            <button
              class="ghost icon-button"
              type="button"
              title="Resume all torrents"
              aria-label="Resume all torrents"
              disabled={Boolean(props.bulkAction)}
              onClick={() => props.onResumeAll?.()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M5.25 3.5 12 8l-6.75 4.5z" stroke-linejoin="round" />
              </svg>
            </button>
          </Show>
          <button
            class="add-button"
            type="button"
            title={
              props.configured
                ? "Add a magnet or .torrent file"
                : "Configure Remagnet Proxy before adding"
            }
            disabled={!props.configured}
            onClick={props.onAdd}
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
            onClick={props.onOpenSettings}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 4.5h11M2.5 11.5h11" />
              <circle cx="6" cy="4.5" r="1.6" />
              <circle cx="10.5" cy="11.5" r="1.6" />
            </svg>
          </button>
        </div>
      </header>

      <Show when={props.error}>
        {(message) => (
          <div class="stack-tight">
            <p class="status error">{message()}</p>
            <div class="actions">
              <button type="button" disabled={props.loading} onClick={props.onRetry}>
                Retry
              </button>
              <button class="ghost" type="button" onClick={props.onOpenSettings}>
                Open settings
              </button>
              <Show when={props.onReportError}>
                <button class="linkish" type="button" onClick={() => props.onReportError?.()}>
                  Report issue
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.actionError}>
        {(message) => (
          <p class="status error">
            {message()}{" "}
            <button class="linkish" type="button" onClick={props.onDismissActionError}>
              Dismiss
            </button>
            <Show when={props.onReportActionError}>
              {" "}
              <button class="linkish" type="button" onClick={() => props.onReportActionError?.()}>
                Report issue
              </button>
            </Show>
          </p>
        )}
      </Show>

      <Show
        when={props.configured}
        fallback={
          <section class="panel stack get-started">
            <h2>Get started</h2>
            <p class="muted">
              Remagnet connects through your Remagnet Proxy, which talks to your torrent client for
              you. Sign in with your proxy username and password, or paste a pairing link from your
              proxy page, in settings. Pairing links connect without a password or 2FA code.
            </p>
            <div class="actions">
              <button type="button" onClick={props.onOpenSettings}>
                Open settings
              </button>
            </div>
          </section>
        }
      >
        <Show when={!props.error}>
          <Show
            when={!props.loading || props.torrents.length > 0}
            fallback={<p class="muted">Loading torrents…</p>}
          >
            <Show
              when={props.torrents.length > 0}
              fallback={
                <p class="muted empty">
                  No Remagnet torrents yet. Add a magnet or .torrent file to see it here.
                </p>
              }
            >
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
                <ul class="torrent-list">
                  {/*
                    Index (not For) keeps each row's DOM and canvas alive while the
                    polled list replaces its objects. For would remount every bar on
                    every refresh and replay the fill and sweep.
                  */}
                  <Index each={visibleTorrents()}>
                    {(torrent) => (
                      <TorrentCard
                        torrent={torrent()}
                        zipping={props.downloadingHash === torrent().hash}
                        removing={props.removingHash === torrent().hash}
                        confirming={props.confirmingHash === torrent().hash}
                        togglingPause={
                          props.togglingHash === torrent().hash || Boolean(props.bulkAction)
                        }
                        filesOpen={props.expandedHash === torrent().hash}
                        files={props.filesByHash?.[torrent().hash]}
                        filesLoading={props.filesLoadingHash === torrent().hash}
                        filesError={
                          props.expandedHash === torrent().hash ? props.filesError : undefined
                        }
                        downloadingFileIndex={
                          props.downloadingFile?.hash === torrent().hash
                            ? props.downloadingFile.index
                            : undefined
                        }
                        onToggleFiles={
                          props.onToggleFiles ? () => props.onToggleFiles?.(torrent()) : undefined
                        }
                        onDownloadFile={
                          props.onDownloadFile
                            ? (file) => props.onDownloadFile?.(torrent(), file)
                            : undefined
                        }
                        onZip={() => props.onZip(torrent())}
                        onTogglePause={
                          props.onTogglePause ? () => props.onTogglePause?.(torrent()) : undefined
                        }
                        onRemoveToggle={() => props.onRemoveToggle(torrent())}
                        onRemove={(deleteFiles) => props.onRemove(torrent(), deleteFiles)}
                        onCancelRemove={() => props.onCancelRemove()}
                      />
                    )}
                  </Index>
                </ul>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </>
  );
}
