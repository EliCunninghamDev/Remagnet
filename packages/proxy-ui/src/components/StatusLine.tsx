import { type FlowStatus, StatusLine as SharedStatusLine } from "@remagnet/ui";

export type StatusTone = FlowStatus["tone"] | "muted";

/**
 * A short flow message shown below a form, list or panel action.
 *
 * The proxy adds a `muted` tone for progress copy such as "Saving…"; the
 * rendering is the shared status line.
 */
export interface StatusMessage {
  tone: StatusTone;
  message: string;
}

export interface StatusLineProps {
  status?: StatusMessage;
  /** Show an inline report link for error messages. */
  onReport?: () => void;
}

/** One-line status text rendered through the shared component. */
export default function StatusLine(props: StatusLineProps) {
  return (
    <SharedStatusLine status={props.status as FlowStatus | undefined} onReport={props.onReport} />
  );
}
