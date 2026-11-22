import { Show } from "solid-js";
import type { FlowStatus } from "./flow-status";

export interface MagnetFormProps {
  draft: string;
  status?: FlowStatus;
  /** Offer Cancel when a previously parsed magnet can be restored. */
  canCancel: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (event: SubmitEvent) => void;
  onCancel: () => void;
}

/** Paste-a-magnet form used before a link has been parsed. */
export default function MagnetForm(props: MagnetFormProps) {
  return (
    <form class="panel stack" onSubmit={props.onSubmit}>
      <label class="field">
        <span>Magnet link</span>
        <textarea
          rows={3}
          spellcheck={false}
          placeholder="magnet:?xt=urn:btih:…"
          value={props.draft}
          onInput={(event) => props.onDraftChange(event.currentTarget.value)}
        />
        <small>Click a magnet link in Firefox and it opens here, or paste one above.</small>
      </label>
      <div class="actions">
        <button type="submit" disabled={!props.draft.trim()}>
          Continue
        </button>
        <Show when={props.canCancel}>
          <button class="ghost" type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </Show>
      </div>
      <Show when={props.status}>
        {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
      </Show>
    </form>
  );
}
