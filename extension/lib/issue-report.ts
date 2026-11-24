/**
 * Opt-in bug report text, built locally before the user chooses to send it.
 *
 * Nothing here uploads anything: the options page opens a GitHub issue or a
 * mail draft, and the redaction below keeps magnets, URLs, device tokens,
 * API keys, hashes and addresses out of whatever the user decides to share.
 */

export interface IssueReportContext {
  action?: string;
  message?: string;
  code?: string;
  status?: number;
  backend?: string;
}

export type IssueReportComponent = "Firefox extension" | "Chrome extension";

export interface IssueReportPayload {
  component: IssueReportComponent;
  version: string;
  diagnostics: string;
  githubUrl: string;
  mailtoUrl: string;
}

const GITHUB_ISSUES_URL = "https://github.com/EliCunninghamDev/Remagnet/issues/new";
const CONTACT_EMAIL = "contact@elijahcunningham.dev";
/** GitHub rejects issue URLs longer than this, so the diagnostics param is trimmed. */
const GITHUB_URL_LIMIT = 2000;
const TRUNCATION_NOTE = "\n… (truncated)";
const MAILTO_PROMPT = "Please describe what happened and what you expected:\n\n";

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/magnet:\?[^\s"'<>]+/gi, "[redacted-magnet]"],
  [/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]"],
  [/Bearer\s+\S+/gi, "Bearer [redacted]"],
  [/\brmg_[A-Za-z0-9_-]+/g, "[redacted-token]"],
  [/\bqbt_[A-Za-z0-9_-]+/g, "[redacted-key]"],
  [/\b[0-9a-fA-F]{64}\b/g, "[redacted-hash]"],
  [/\b[0-9a-fA-F]{40}\b/g, "[redacted-hash]"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[redacted-ip]"],
];

/**
 * Replace secrets and identifying details with stable placeholders.
 *
 * The placeholders are deliberately readable: a maintainer can still see that
 * a token, hash or address was involved without receiving its value.
 */
export function redactSensitiveText(input: string): string {
  let output = input;
  for (const [pattern, replacement] of REDACTIONS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Build a plain-text report plus ready-to-open GitHub and mail links.
 *
 * The full (redacted) diagnostics stay in `diagnostics`; only the copy embedded
 * in `githubUrl` is shortened when the URL would overflow GitHub's limit.
 */
export function buildIssueReport(input: {
  component: IssueReportComponent;
  version: string;
  platform?: string;
  context?: IssueReportContext;
}): IssueReportPayload {
  const component = input.component;
  const version = input.version;
  const diagnostics = formatDiagnostics(input);

  return {
    component,
    version,
    diagnostics,
    githubUrl: buildGithubUrl(component, version, diagnostics),
    mailtoUrl: buildMailtoUrl(component, version, diagnostics),
  };
}

function formatDiagnostics(input: {
  component: IssueReportComponent;
  version: string;
  platform?: string;
  context?: IssueReportContext;
}): string {
  const { context } = input;
  const lines = [`Component: ${input.component}`, `Version: ${input.version}`];

  const platform = input.platform?.trim();
  if (platform) lines.push(`Platform: ${platform}`);

  const backend = context?.backend?.trim();
  if (backend) lines.push(`Backend: ${redactSensitiveText(backend)}`);

  const action = context?.action?.trim();
  if (action) lines.push(`Action: ${action}`);

  if (context?.status !== undefined) lines.push(`HTTP status: ${context.status}`);

  const code = context?.code?.trim();
  if (code) lines.push(`Error code: ${code}`);

  const message = context?.message?.trim();
  if (message) lines.push(`Error message: ${redactSensitiveText(message)}`);

  return lines.join("\n");
}

function buildGithubUrl(
  component: IssueReportComponent,
  version: string,
  diagnostics: string,
): string {
  const params = new URLSearchParams({
    template: "bug_report.yml",
    component,
    version,
    diagnostics: fitDiagnosticsForUrl(component, version, diagnostics),
  });
  return `${GITHUB_ISSUES_URL}?${params.toString()}`;
}

function githubUrlLength(
  component: IssueReportComponent,
  version: string,
  diagnostics: string,
): number {
  const params = new URLSearchParams({
    template: "bug_report.yml",
    component,
    version,
    diagnostics,
  });
  return GITHUB_ISSUES_URL.length + 1 + params.toString().length;
}

/** Longest prefix of `diagnostics` whose encoded URL still fits GitHub's limit. */
function fitDiagnosticsForUrl(
  component: IssueReportComponent,
  version: string,
  diagnostics: string,
): string {
  if (githubUrlLength(component, version, diagnostics) < GITHUB_URL_LIMIT) return diagnostics;

  let low = 0;
  let high = diagnostics.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (githubUrlLength(component, version, truncate(diagnostics, mid)) < GITHUB_URL_LIMIT) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return truncate(diagnostics, low);
}

function truncate(value: string, length: number): string {
  return `${value.slice(0, length).trimEnd()}${TRUNCATION_NOTE}`;
}

function buildMailtoUrl(
  component: IssueReportComponent,
  version: string,
  diagnostics: string,
): string {
  const subject = `Remagnet bug report (${component} ${version})`;
  const body = `${MAILTO_PROMPT}${diagnostics}`;
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
