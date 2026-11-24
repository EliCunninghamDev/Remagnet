/** A message shown under an add-flow form. */
export interface FlowStatus {
  tone: "ok" | "error" | "warn";
  message: string;
}
