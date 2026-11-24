import { For, Show } from "solid-js";
import { formatBytes, formatPercent, stateLabel } from "../lib/format";
import { type MagnetLink, magnetLabel, trackerHosts } from "../lib/magnet";
import {
  type ParsedTorrentFile,
  torrentFileLabel,
  trackerHostsFromList,
} from "../lib/torrent-file";
import type { TorrentSummary } from "../lib/torrents";
import type { FlowStatus } from "./flow-status";

export interface MagnetReviewProps {
  /** A parsed magnet link. Omit when reviewing a `.torrent` file. */
  link?: MagnetLink;
  /** A parsed `.torrent` file. Omit when reviewing a magnet link. */
  file?: ParsedTorrentFile;
  /** A torrent with the same info hash, when the proxy already has it. */
  existing?: TorrentSummary | null;
  paused: boolean;
  busy: boolean;
  status?: FlowStatus;
  onEdit: () => void;
  onSubmit: (event: SubmitEvent) => void;
  onPausedChange: (paused: boolean) => void;
}

/**
 * Review screen for a parsed magnet or `.torrent` file: what will be sent,
 * whether it is already in the client, and the submit action.
 */
export default function MagnetReview(props: MagnetReviewProps) {
  const name = () => {
    if (props.file) return torrentFileLabel(props.file);
    if (props.link) return magnetLabel(props.link);
    return "";
  };
  const infoHash = () => props.file?.infoHash ?? props.link?.infoHash ?? null;
  const size = () => props.file?.size ?? props.link?.size ?? null;
  const trackers = () => props.file?.trackers ?? props.link?.trackers ?? [];
  const webSeeds = () => props.file?.webSeeds ?? props.link?.webSeeds ?? [];
  const hosts = () => {
    if (props.file) return trackerHostsFromList(props.file.trackers);
    if (props.link) return trackerHosts(props.link);
    return [];
  };
  const fileCount = () => {
    const count = props.file?.fileCount ?? 0;
    return count > 1 ? count : null;
  };

  return (
    <div class="stack">
      <section class="panel magnet-card">
        <div class="magnet-head">
          <h2>{name()}</h2>
          <button class="ghost" type="button" onClick={props.onEdit}>
            {props.file ? "Change" : "Edit"}
          </button>
        </div>

        <dl class="kv">
          <Show when={infoHash()}>
            {(hash) => (
              <div>
                <dt>Info hash</dt>
                <dd class="mono">{hash()}</dd>
              </div>
            )}
          </Show>
          <Show when={size() !== null}>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(size() ?? 0)}</dd>
            </div>
          </Show>
          <Show when={fileCount()}>
            {(count) => (
              <div>
                <dt>Files</dt>
                <dd>{count()} files</dd>
              </div>
            )}
          </Show>
          <Show when={props.file?.isPrivate}>
            <div>
              <dt>Private</dt>
              <dd>
                <span class="badge">Yes</span>
              </dd>
            </div>
          </Show>
          <Show when={trackers().length > 0}>
            <div>
              <dt>Trackers</dt>
              <dd>
                {trackers().length}
                {hosts().length > 0 ? ` · ${hosts().join(", ")}` : ""}
              </dd>
            </div>
          </Show>
          <Show when={webSeeds().length > 0}>
            <div>
              <dt>Web seeds</dt>
              <dd>{webSeeds().length}</dd>
            </div>
          </Show>
        </dl>

        <Show when={trackers().length > 0}>
          <details class="trackers">
            <summary>Show tracker URLs</summary>
            <ul>
              <For each={trackers()}>{(tracker) => <li class="mono">{tracker}</li>}</For>
            </ul>
          </details>
        </Show>
      </section>

      <Show when={props.existing}>
        {(torrent) => (
          <p class="status warn">
            Already in Remagnet Proxy: <strong>{torrent().name}</strong> (
            {stateLabel(torrent().state)} · {formatPercent(torrent().progress)}).
          </p>
        )}
      </Show>

      <form class="panel stack" onSubmit={props.onSubmit}>
        <div class="submit-row">
          <div class="submit-main">
            <button type="submit" disabled={props.busy || Boolean(props.existing)}>
              {props.busy ? "Sending…" : "Send to Remagnet Proxy"}
            </button>
            <label class="check compact" title="Add stopped, and start it manually in your client">
              <input
                type="checkbox"
                checked={props.paused}
                onChange={(event) => props.onPausedChange(event.currentTarget.checked)}
              />
              <span>Add paused</span>
            </label>
          </div>
        </div>

        <Show when={props.status}>
          {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
        </Show>
      </form>
    </div>
  );
}
