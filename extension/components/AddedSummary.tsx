import { Show } from "solid-js";

export interface AddedSummaryProps {
  name: string;
  category: string;
  tags: string[];
  /** The popover uses different labels from the full add page. */
  embedded: boolean;
  onAddAnother: () => void;
  onClose: () => void;
}

/** Confirmation shown after a magnet was accepted by the proxy. */
export default function AddedSummary(props: AddedSummaryProps) {
  return (
    <section class="panel stack">
      <p class="status ok">Added “{props.name}” to Remagnet Proxy.</p>
      <p class="muted">
        <Show when={props.category}>Category: {props.category}. </Show>
        <Show when={props.tags.length > 0}>Tags: {props.tags.join(", ")}. </Show>
        Metadata and file names arrive shortly.
      </p>
      <div class="actions">
        <button type="button" class="ghost" onClick={props.onAddAnother}>
          Add another
        </button>
        <button type="button" class="ghost" onClick={props.onClose}>
          {props.embedded ? "View downloads" : "Close"}
        </button>
      </div>
    </section>
  );
}
