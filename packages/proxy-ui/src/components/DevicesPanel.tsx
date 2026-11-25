import { errorMessage, type IssueReportContext, issueContextFromError } from "@remagnet/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import { fetchDevices, isSessionExpired, type PublicDevice, revokeDevice } from "../api";
import StatusLine, { type StatusMessage } from "./StatusLine";

const JUST_NOW_SECONDS = 45;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;
const MONTH_SECONDS = 2_592_000;
const YEAR_SECONDS = 31_536_000;

export interface DevicesPanelProps {
  /** Called with redacted diagnostics when the user asks to report a failure. */
  onReportIssue?: (context: IssueReportContext) => void;
}

/** Devices holding a proxy token, with a per-row revoke action. */
export default function DevicesPanel(props: DevicesPanelProps) {
  const [devices, setDevices] = createSignal<PublicDevice[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [revokingId, setRevokingId] = createSignal<string>();
  const [status, setStatus] = createSignal<StatusMessage | undefined>();
  const [statusContext, setStatusContext] = createSignal<IssueReportContext>();

  onMount(() => {
    void loadDevices();
  });

  async function loadDevices(quiet = false) {
    if (loading()) return;

    setLoading(true);

    try {
      const list = await fetchDevices();
      setDevices(list);
      setLoaded(true);
      if (!quiet) setStatus(undefined);
      setStatusContext(undefined);
    } catch (error) {
      if (isSessionExpired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContextFromError(error, "Loading devices"));
    } finally {
      setLoading(false);
    }
  }

  async function removeDevice(device: PublicDevice) {
    const label = device.name || "this device";
    // Browsers confirm before revoking; test or embedded hosts without a
    // `confirm` implementation still get the same action.
    if (
      typeof window.confirm === "function" &&
      !window.confirm(`Revoke ${label}? That device will need to sign in again.`)
    ) {
      return;
    }

    setRevokingId(device.id);
    setStatus({ tone: "muted", message: `Revoking ${label}…` });
    setStatusContext(undefined);
    try {
      await revokeDevice(device.id);
      await loadDevices(true);
      setStatus({ tone: "ok", message: `Revoked ${label}.` });
    } catch (error) {
      if (isSessionExpired(error)) return;
      setStatus({ tone: "error", message: errorMessage(error) });
      setStatusContext(issueContextFromError(error, "Revoking device"));
    } finally {
      setRevokingId(undefined);
    }
  }

  function reportIssue() {
    const context = statusContext();
    if (context) props.onReportIssue?.(context);
  }

  return (
    <section class="panel stack">
      <div class="panel-head">
        <h2>Connected devices</h2>
        <button
          type="button"
          class="ghost"
          disabled={loading()}
          aria-busy={loading()}
          onClick={() => void loadDevices()}
        >
          Refresh
        </button>
      </div>
      <p class="hint">
        Devices that paired with this proxy or signed in for a token. Revoking one signs that device
        out immediately.
      </p>

      <StatusLine status={status()} onReport={props.onReportIssue ? reportIssue : undefined} />

      <Show when={!loaded() && loading() && !status()}>
        <p class="hint">Loading devices…</p>
      </Show>

      <Show when={devices().length > 0}>
        <ul class="device-list">
          <For each={devices()}>
            {(device) => (
              <li class="device-row">
                <div class="device-info">
                  <span class="device-name">{device.name || "Unnamed device"}</span>
                  <span
                    class="device-meta"
                    title={
                      `Added ${deviceTimestamp(device.createdAt)}` +
                      (device.lastUsedAt
                        ? `\nLast used ${deviceTimestamp(device.lastUsedAt)}`
                        : "\nNever used")
                    }
                  >
                    Added {relativeTime(device.createdAt)} · Last used{" "}
                    {device.lastUsedAt ? relativeTime(device.lastUsedAt) : "never"}
                  </span>
                </div>
                <button
                  type="button"
                  class="ghost"
                  disabled={revokingId() === device.id}
                  aria-label={`Revoke ${device.name || "device"}`}
                  onClick={() => void removeDevice(device)}
                >
                  Revoke
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={loaded() && devices().length === 0}>
        <p class="hint">No devices are paired yet. Use the QR code above to connect one.</p>
      </Show>
    </section>
  );
}

function relativeTime(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - Number(unixSeconds);
  if (!Number.isFinite(diff)) return "unknown";
  if (diff < JUST_NOW_SECONDS) return "just now";

  const units: ReadonlyArray<readonly [number, string]> = [
    [YEAR_SECONDS, "year"],
    [MONTH_SECONDS, "month"],
    [WEEK_SECONDS, "week"],
    [DAY_SECONDS, "day"],
    [HOUR_SECONDS, "hour"],
    [MINUTE_SECONDS, "minute"],
  ];
  for (const [seconds, label] of units) {
    if (diff >= seconds) {
      const count = Math.floor(diff / seconds);
      return `${count} ${label}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

function deviceTimestamp(unixSeconds: number): string {
  const date = new Date(Number(unixSeconds) * 1000);
  return Number.isNaN(date.valueOf()) ? "unknown" : date.toLocaleString();
}
