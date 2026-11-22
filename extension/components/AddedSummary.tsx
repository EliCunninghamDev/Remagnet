import { Show } from "solid-js";

export interface AddedSummaryProps {
  name: string;
  category: string;
  tags: string[];
  clientLabel: string;
  /** The popover uses different labels from the full add page. */
  embedded: boolean;
  onOpenClient: () => void;
  onAddAnother: () => void;
  onClose: () => void;
}

/** Confirmation shown after a magnet was accepted by the client. */
export default function AddedSummary(props: AddedSummaryProps) {
  return (
    <section class="panel stack">
      <p class="status ok">
        Added “{props.name}” to {props.clientLabel}.
      </p>
      <p class="muted">
        <Show when={props.category}>Category: {props.category}. </Show>
        <Show when={props.tags.length > 0}>Tags: {props.tags.join(", ")}. </Show>
        Metadata and file names arrive shortly.
      </p>
      <div class="actions">
        <button type="button" onClick={props.onOpenClient}>
          Open {props.clientLabel}
        </button>
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
