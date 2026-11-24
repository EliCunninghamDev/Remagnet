import SharedIssueReportDialog, {
  type IssueReportDialogProps as SharedIssueReportDialogProps,
} from "@remagnet/ui/components/IssueReportDialog";
import { browser } from "wxt/browser";

export type IssueReportDialogProps = Omit<SharedIssueReportDialogProps, "component" | "version">;

/**
 * Extension wrapper: supplies the browser-specific product label and the
 * installed manifest version. The dialog itself stays surface-neutral so the
 * proxy UI can reuse it with its own component name and version.
 */
export default function IssueReportDialog(props: IssueReportDialogProps) {
  return (
    <SharedIssueReportDialog
      {...props}
      component={import.meta.env.FIREFOX ? "Firefox extension" : "Chrome extension"}
      version={manifestVersion()}
    />
  );
}

/** Manifest version, with a stable fallback for tests and the gallery. */
function manifestVersion(): string {
  try {
    const runtime = (
      browser as { runtime?: { getManifest?: () => { version?: string } } } | undefined
    )?.runtime;
    return runtime?.getManifest?.()?.version ?? "dev";
  } catch {
    return "dev";
  }
}
