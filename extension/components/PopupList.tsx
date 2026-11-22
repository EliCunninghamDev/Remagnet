import { Index, Show } from "solid-js";
import type { TorrentSummary } from "../lib/torrents";
import TorrentCard from "./TorrentCard";
import Wordmark from "./Wordmark";

export interface PopupListProps {
  torrents: TorrentSummary[];
  loading: boolean;
  error?: string;
  actionError?: string;
  /** Whether the configured category/tags limit the list. */
  filterActive: boolean;
  /** Human-readable summary of the active filter, e.g. `category 'remagnet'`. */
  filterDescription: string;
  clientLabel: string;
  /** Shown alongside the client in the wordmark tooltip. */
  serverLabel?: string;
  /** The archive bridge is configured, so completed rows can offer ZIP. */
  archiveReady: boolean;
  downloadingHash?: string;
  removingHash?: string;
  confirmingHash?: string;
  onRetry: () => void;
  onOpenSettings: () => void;
  onDismissActionError: () => void;
  onAdd: () => void;
  onZip: (torrent: TorrentSummary) => void;
  onRemoveToggle: (torrent: TorrentSummary) => void;
  onRemove: (torrent: TorrentSummary, deleteFiles: boolean) => void;
  onCancelRemove: () => void;
}

/**
 * The popover's default view: heading, actions, and the filtered torrent list.
 *
 * It takes plain data and callbacks rather than reading storage or talking to
 * the background worker, which keeps every list state renderable in the
 * component gallery and in tests.
 */
export default function PopupList(props: PopupListProps) {
  const wordmarkTitle = () =>
    props.serverLabel ? `${props.clientLabel} · ${props.serverLabel}` : props.clientLabel;

  return (
    <>
      <header class="popup-header">
        <div class="header-text">
          <div class="title-row">
            <Wordmark as="h1" title={wordmarkTitle()} />
            <Show when={props.torrents.length >= 2}>
              <span class="count-badge mono">{props.torrents.length}</span>
            </Show>
          </div>
        </div>
        <div class="header-actions">
          <button class="add-button" type="button" title="Add a magnet link" onClick={props.onAdd}>
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
          </p>
        )}
      </Show>

      <Show when={!props.error}>
        <Show
          when={!props.loading || props.torrents.length > 0}
          fallback={<p class="muted">Loading torrents…</p>}
        >
          <Show
            when={props.torrents.length > 0}
            fallback={
              <Show
                when={props.filterActive}
                fallback={<p class="muted empty">No torrents in {props.clientLabel}.</p>}
              >
                <p class="muted empty">
                  No Remagnet torrents yet. Add a magnet to see it here; matching uses{" "}
                  {props.filterDescription}.
                </p>
              </Show>
            }
          >
            <ul class="torrent-list">
              {/*
                Index (not For) keeps each row's DOM and canvas alive while the
                polled list replaces its objects. For would remount every bar on
                every refresh and replay the fill and sweep.
              */}
              <Index each={props.torrents}>
                {(torrent) => (
                  <TorrentCard
                    torrent={torrent()}
                    zipping={props.downloadingHash === torrent().hash}
                    archiveReady={props.archiveReady}
                    clientLabel={props.clientLabel}
                    removing={props.removingHash === torrent().hash}
                    confirming={props.confirmingHash === torrent().hash}
                    onZip={() => props.onZip(torrent())}
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
    </>
  );
}
