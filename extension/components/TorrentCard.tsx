import { Show } from "solid-js";
import { formatBytes, formatEta, splitTorrentName, stateLabel, stateTone } from "../lib/format";
import { COMPLETE_PROGRESS, type TorrentSummary } from "../lib/torrents";
import SquareBar, { type BarPhase } from "./SquareBar";

export interface TorrentCardProps {
  torrent: TorrentSummary;
  zipping: boolean;
  removing: boolean;
  confirming: boolean;
  onZip: () => void;
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
  const complete = () => props.torrent.progress >= COMPLETE_PROGRESS;

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
                  disabled={props.zipping}
                  title="Download this completed torrent as a ZIP"
                  onClick={() => props.onZip()}
                >
                  Download
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
    </li>
  );
}
