import { For, Show } from "solid-js";
import type { TorrentClientCapabilities } from "../lib/clients/types";
import { formatBytes, formatPercent, stateLabel } from "../lib/format";
import { type MagnetLink, magnetLabel, trackerHosts } from "../lib/magnet";
import type { TorrentSummary } from "../lib/torrents";
import type { FlowStatus } from "./flow-status";

export interface MagnetReviewProps {
  link: MagnetLink;
  clientLabel: string;
  capabilities: TorrentClientCapabilities;
  /** A torrent with the same info hash, when the client already has it. */
  existing?: TorrentSummary | null;
  paused: boolean;
  busy: boolean;
  status?: FlowStatus;
  onEdit: () => void;
  onSubmit: (event: SubmitEvent) => void;
  onPausedChange: (paused: boolean) => void;
  onOpenClient: () => void;
}

/**
 * Review screen for a parsed magnet: what will be sent, whether it is already
 * in the client, and the submit action.
 */
export default function MagnetReview(props: MagnetReviewProps) {
  return (
    <div class="stack">
      <section class="panel magnet-card">
        <div class="magnet-head">
          <h2>{magnetLabel(props.link)}</h2>
          <button class="ghost" type="button" onClick={props.onEdit}>
            Edit
          </button>
        </div>

        <dl class="kv">
          <Show when={props.link.infoHash}>
            {(hash) => (
              <div>
                <dt>Info hash</dt>
                <dd class="mono">{hash()}</dd>
              </div>
            )}
          </Show>
          <Show when={props.link.size !== null}>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(props.link.size ?? 0)}</dd>
            </div>
          </Show>
          <Show when={props.link.trackers.length > 0}>
            <div>
              <dt>Trackers</dt>
              <dd>
                {props.link.trackers.length}
                {trackerHosts(props.link).length > 0
                  ? ` · ${trackerHosts(props.link).join(", ")}`
                  : ""}
              </dd>
            </div>
          </Show>
          <Show when={props.link.webSeeds.length > 0}>
            <div>
              <dt>Web seeds</dt>
              <dd>{props.link.webSeeds.length}</dd>
            </div>
          </Show>
        </dl>

        <Show when={props.link.trackers.length > 0}>
          <details class="trackers">
            <summary>Show tracker URLs</summary>
            <ul>
              <For each={props.link.trackers}>{(tracker) => <li class="mono">{tracker}</li>}</For>
            </ul>
          </details>
        </Show>
      </section>

      <Show when={props.existing}>
        {(torrent) => (
          <p class="status warn">
            Already in {props.clientLabel}: <strong>{torrent().name}</strong> (
            {stateLabel(torrent().state)} · {formatPercent(torrent().progress)}).
          </p>
        )}
      </Show>

      <form class="panel stack" onSubmit={props.onSubmit}>
        <div class="submit-row">
          <div class="submit-main">
            <button type="submit" disabled={props.busy || Boolean(props.existing)}>
              {props.busy ? "Sending…" : `Send to ${props.clientLabel}`}
            </button>
            <Show when={props.capabilities.pauseOnAdd}>
              <label
                class="check compact"
                title={`Add stopped, and start it manually in ${props.clientLabel}`}
              >
                <input
                  type="checkbox"
                  checked={props.paused}
                  onChange={(event) => props.onPausedChange(event.currentTarget.checked)}
                />
                <span>Add paused</span>
              </label>
            </Show>
          </div>

          <button type="button" class="client-link" onClick={props.onOpenClient}>
            Open {props.clientLabel}
          </button>
        </div>

        <Show when={props.status}>
          {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
        </Show>
      </form>
    </div>
  );
}
