import { Show } from "solid-js";
import type { FlowStatus } from "./flow-status";

export interface StatusLineProps {
  status?: FlowStatus;
  /** Show an inline report link for error messages. */
  onReport?: () => void;
}

/** One-line status text with an opt-in report trigger for failures. */
export default function StatusLine(props: StatusLineProps) {
  return (
    <Show when={props.status}>
      {(current) => (
        <p class={`status ${current().tone}`} role="status" aria-live="polite">
          {current().message}
          <Show when={current().tone === "error" && props.onReport}>
            <button class="linkish report-inline" type="button" onClick={() => props.onReport?.()}>
              Report issue
            </button>
          </Show>
        </p>
      )}
    </Show>
  );
}
