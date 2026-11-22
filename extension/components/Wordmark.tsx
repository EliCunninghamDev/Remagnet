import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";

export type WordmarkSize = "sm" | "md" | "lg";

export interface WordmarkProps {
  /** Visual size. The pixel font is crisp at 11px multiples. */
  size?: WordmarkSize;
  /** Short surface label shown after the wordmark, e.g. Bridge or Android. */
  surface?: string;
  /** Optional hover text, such as the active client and server. */
  title?: string;
  /** Semantic element. Use h1 when the wordmark is the page heading. */
  as?: "span" | "p" | "h1";
  class?: string;
}

/**
 * The Remagnet wordmark.
 *
 * Every surface renders the same mark with the same font, casing and spacing.
 * A surface label is optional; it is the only part that changes between the
 * popover, settings, gallery, bridge and Android app.
 */
export default function Wordmark(props: WordmarkProps) {
  return (
    <Dynamic
      component={props.as ?? "span"}
      class={`wordmark wordmark-${props.size ?? "md"}${props.class ? ` ${props.class}` : ""}`}
      title={props.title}
    >
      Remagnet
      <Show when={props.surface}>
        {(surface) => <span class="wordmark-surface">{surface()}</span>}
      </Show>
    </Dynamic>
  );
}
