import { For, Show } from "solid-js";
import {
  formatBytes,
  formatEta,
  formatPercent,
  splitTorrentName,
  stateLabel,
  stateTone,
} from "../lib/format";
import {
  fileBasename,
  isFileComplete,
  isTorrentComplete,
  isTorrentPaused,
  type TorrentFile,
  type TorrentSummary,
} from "../lib/torrents";
import SquareBar, { type BarPhase } from "./SquareBar";

export interface TorrentCardProps {
  torrent: TorrentSummary;
  zipping: boolean;
  removing: boolean;
  confirming: boolean;
  /** Disable the ZIP action, e.g. when the proxy cannot archive downloads. */
  zipDisabled?: boolean;
  /** Tooltip explaining why the ZIP action is unavailable. */
  zipTitle?: string;
  /** Disable the pause/resume action while its request is in flight. */
  togglingPause?: boolean;
  /** Whether the per-file browser is expanded. */
  filesOpen?: boolean;
  /** Files reported for this torrent. */
  files?: TorrentFile[];
  /** Whether the file list is being fetched. */
  filesLoading?: boolean;
  /** Error shown in place of the file list. */
  filesError?: string;
  /** Index of the file whose download is in flight. */
  downloadingFileIndex?: number;
  /** Show and wire the per-file browser toggle. */
  onToggleFiles?: () => void;
  /** Download one completed file. */
  onDownloadFile?: (file: TorrentFile) => void;
  onZip: () => void;
  /** Show and wire the pause/resume action. */
  onTogglePause?: () => void;
  onRemoveToggle: () => void;
  onRemove: (deleteFiles: boolean) => void;
  onCancelRemove: () => void;
}

/**
 * One row in the popover: name, progress bar, live stats and the Download and
 * remove actions. The bar's color is the status indicator; the textual status
 * only remains for assistive tech. The component is deliberately prop-driven so
 * the gallery and component tests can render every state without a torrent
 * client.
 */
export default function TorrentCard(props: TorrentCardProps) {
  const complete = () => isTorrentComplete(props.torrent);
  const paused = () => isTorrentPaused(props.torrent);

  const status = (): { phase: BarPhase; label: string } => {
    if (props.zipping) return { phase: "zip", label: "Zipping" };
    if (complete()) return { phase: "done", label: "Ready" };
    const tone = stateTone(props.torrent.state);
    if (tone === "bad") return { phase: "idle", label: stateLabel(props.torrent.state) };
    if (tone === "warn") return { phase: "zip", label: "Stalled" };
    if (props.torrent.state === "stopped") return { phase: "idle", label: "Paused" };
    return {
      phase: tone === "active" ? "fetch" : "idle",
      label: stateLabel(props.torrent.state),
    };
  };

  /** An unknown ETA is a dash; leave the field out instead of showing it. */
  const eta = () => {
    const value = formatEta(props.torrent.eta);
    return value === "—" ? undefined : value;
  };

  const downloaded = () => formatBytes(props.torrent.progress * props.torrent.size);
  const name = () => splitTorrentName(props.torrent.name);

  /**
   * Stalled, paused and errored torrents get their state in the slot the
   * Download action would use: the bar color alone cannot say which one it is.
   * Every other state keeps the same word for assistive tech only.
   */
  const stateNote = (): string | undefined => {
    if (props.zipping || complete()) return undefined;
    const tone = stateTone(props.torrent.state);
    if (tone === "warn" || tone === "bad" || props.torrent.state === "stopped") {
      return status().label;
    }
    return undefined;
  };

  return (
    <li class="torrent">
      <div class="torrent-head">
        <span class="torrent-name" title={props.torrent.name}>
          <span class="torrent-name-head">{name().head}</span>
          <Show when={name().tail}>
            <span class="torrent-name-tail">{name().tail}</span>
          </Show>
        </span>
      </div>

      <SquareBar progress={props.torrent.progress} phase={status().phase} />

      <Show
        when={props.confirming}
        fallback={
          <div class="torrent-footer">
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
            <div class="row-actions">
              <span class="torrent-state mono" classList={{ "sr-only": !stateNote() }}>
                {status().label}
              </span>
              <Show when={complete()}>
                <button
                  class="row-icon download-action"
                  type="button"
                  disabled={props.zipping || props.zipDisabled}
                  title={props.zipTitle ?? "Download this completed torrent"}
                  onClick={() => props.onZip()}
                >
                  Download
                </button>
              </Show>
              <Show when={props.onToggleFiles}>
                <button
                  class="row-icon files-action"
                  classList={{ "is-open": Boolean(props.filesOpen) }}
                  type="button"
                  title={props.filesOpen ? "Hide files" : "Show files"}
                  aria-label={props.filesOpen ? "Hide files" : "Show files"}
                  aria-expanded={Boolean(props.filesOpen)}
                  onClick={() => props.onToggleFiles?.()}
                >
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M1.5 2.75h9v1.25h-9zm0 2.75h9v1.25h-9zm0 2.75h6.5V9.5h-6.5z" />
                  </svg>
                </button>
              </Show>
              <Show when={props.onTogglePause}>
                <button
                  class="row-icon pause-action"
                  classList={{ "is-paused": paused() }}
                  type="button"
                  disabled={Boolean(props.togglingPause) || props.removing}
                  title={paused() ? "Resume this torrent" : "Pause this torrent"}
                  aria-label={paused() ? "Resume torrent" : "Pause torrent"}
                  onClick={() => props.onTogglePause?.()}
                >
                  <Show
                    when={paused()}
                    fallback={
                      <svg viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M2.75 2.25h2.25v7.5H2.75zm4.25 0h2.25v7.5H7z" />
                      </svg>
                    }
                  >
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M3 2.25 10 6 3 9.75z" />
                    </svg>
                  </Show>
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
          </div>
        }
      >
        <div class="remove-confirm">
          <span class="remove-question">Remove this torrent?</span>
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

      <Show when={props.filesOpen && !props.confirming}>
        <div class="torrent-files">
          <Show when={props.filesLoading}>
            <p class="torrent-files-note mono">Loading files…</p>
          </Show>
          <Show when={!props.filesLoading && props.filesError}>
            {(message) => <p class="torrent-files-note torrent-files-error">{message()}</p>}
          </Show>
          <Show when={!props.filesLoading && !props.filesError}>
            <Show
              when={(props.files?.length ?? 0) > 0}
              fallback={<p class="torrent-files-note mono">No files available yet.</p>}
            >
              <ul class="torrent-file-list">
                <For each={props.files}>
                  {(file) => {
                    const ready = () => isFileComplete(file);
                    const busy = () => props.downloadingFileIndex === file.index;
                    return (
                      <li class="torrent-file-row">
                        <span class="torrent-file-name mono" title={file.name}>
                          {file.name}
                        </span>
                        <span class="torrent-file-meta mono">
                          {formatBytes(file.size)}
                          <Show when={!ready()}>
                            {" · "}
                            {formatPercent(file.progress)}
                          </Show>
                        </span>
                        <Show when={ready() && props.onDownloadFile}>
                          <button
                            class="row-icon download-action"
                            type="button"
                            disabled={busy() || props.zipDisabled}
                            title={props.zipTitle ?? `Download ${fileBasename(file.name)}`}
                            onClick={() => props.onDownloadFile?.(file)}
                          >
                            {busy() ? "…" : "Download"}
                          </button>
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      </Show>
    </li>
  );
}
