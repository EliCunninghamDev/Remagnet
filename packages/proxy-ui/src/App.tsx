import {
  errorMessage,
  type IssueReportContext,
  IssueReportDialog,
  PageFooter,
  Wordmark,
} from "@remagnet/ui";
import {
  createEffect,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import {
  type AuthSession,
  type AuthStatus,
  type ConnectionHealth,
  checkSessionExpired,
  fetchConfig,
  fetchLiveness,
  getAuthStatus,
  isSessionExpired,
  type LoginRequest,
  loginAdmin,
  logoutAdmin,
  ProxyApiError,
  type PublicConfig,
  type SetupAdminRequest,
  setupAdmin,
} from "./api";
import ClientConfigPanel from "./components/ClientConfigPanel";
import DevicesPanel from "./components/DevicesPanel";
import PairingPanel from "./components/PairingPanel";
import SecurityPanel from "./components/SecurityPanel";
import SetupView, { type SetupCredentials } from "./components/SetupView";
import SignInView, { type SignInValues } from "./components/SignInView";
import type { StatusMessage } from "./components/StatusLine";
import TorrentsPanel from "./components/TorrentsPanel";

const SESSION_ENDED = "Your session ended. Sign in again.";

type DashboardTab = "torrents" | "devices" | "connection" | "account";

const DASHBOARD_TABS: DashboardTab[] = ["torrents", "devices", "connection", "account"];
const UNCONFIGURED_TABS: DashboardTab[] = ["connection", "account"];

const TAB_LABELS: Record<DashboardTab, string> = {
  torrents: "Torrents",
  devices: "Devices",
  connection: "Connection",
  account: "Account",
};

function tabFromHash(hash: string): DashboardTab | undefined {
  const value = hash.replace(/^#/, "").toLowerCase();
  return DASHBOARD_TABS.find((tab) => tab === value);
}

/**
 * The proxy administrator page.
 *
 * Authentication state comes from `GET /api/auth/status` once on mount. The
 * liveness probe only supplies the version for the footer and issue reports,
 * so a missing `/healthz` never blocks setup or sign-in.
 */
export default function App() {
  const [authStatus, setAuthStatus] = createSignal<AuthStatus>();
  const [booted, setBooted] = createSignal(false);
  const [proxyVersion, setProxyVersion] = createSignal("");

  const [configLoaded, setConfigLoaded] = createSignal(false);
  const [publicConfig, setPublicConfig] = createSignal<PublicConfig>();
  const [configured, setConfigured] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<DashboardTab>("torrents");

  const [health, setHealth] = createSignal<ConnectionHealth>();
  const [refreshTrigger, setRefreshTrigger] = createSignal(0);

  const [setupBusy, setSetupBusy] = createSignal(false);
  const [setupStatus, setSetupStatus] = createSignal<StatusMessage>();

  const [signInBusy, setSignInBusy] = createSignal(false);
  const [signInStatus, setSignInStatus] = createSignal<StatusMessage>();
  const [totpRequired, setTotpRequired] = createSignal(false);

  const [reportOpen, setReportOpen] = createSignal(false);
  const [reportContext, setReportContext] = createSignal<IssueReportContext>();

  let revokeActivePairing: (() => void) | undefined;
  let configRequested = false;

  const allowedTabs = () => (configured() ? DASHBOARD_TABS : UNCONFIGURED_TABS);
  const defaultTab = (): DashboardTab => (configured() ? "torrents" : "connection");

  createEffect(() => {
    if (authStatus()?.authenticated !== true) {
      configRequested = false;
      return;
    }
    if (configRequested) return;
    configRequested = true;
    void loadConfig();
  });

  createEffect(
    on([configLoaded, configured], ([loaded]) => {
      if (!loaded) return;

      const tabs = allowedTabs();
      const requested = tabFromHash(location.hash);
      const next =
        requested && tabs.includes(requested)
          ? requested
          : tabs.includes(activeTab())
            ? activeTab()
            : defaultTab();

      setActiveTab(next);
      if (location.hash !== `#${next}`) {
        try {
          history.replaceState(null, "", `#${next}`);
        } catch {
          // happy-dom and some embedded browsers reject history writes.
        }
      }
    }),
  );

  onMount(() => {
    const stopExpiryHandler = checkSessionExpired(handleSessionExpired);
    onCleanup(stopExpiryHandler);

    void loadVersion();
    void boot();
  });

  async function loadVersion() {
    try {
      const liveness = await fetchLiveness();
      if (liveness.version) setProxyVersion(liveness.version);
    } catch {
      // Version metadata is optional; the footer falls back to the product name.
    }
  }

  async function boot() {
    try {
      setAuthStatus(await getAuthStatus());
    } catch (error) {
      setSignInStatus({
        tone: "error",
        message:
          errorMessage(error) ||
          "Could not reach the proxy. Check that it is running, then reload.",
      });
    } finally {
      setBooted(true);
    }
  }

  function applyPublicConfig(config: PublicConfig) {
    setPublicConfig(config);
    setConfigured(config.configured);
    setConfigLoaded(true);
  }

  async function loadConfig() {
    try {
      applyPublicConfig(await fetchConfig());
    } catch (error) {
      if (isSessionExpired(error)) return;

      // A failed config read is not fatal; show Connection so the
      // administrator can finish setup and retry.
      setPublicConfig(undefined);
      setConfigured(false);
      setConfigLoaded(true);
    }
  }

  function handleConfigChange(config: PublicConfig) {
    applyPublicConfig(config);
    setRefreshTrigger((count) => count + 1);
  }

  function selectTab(tab: DashboardTab) {
    if (!allowedTabs().includes(tab)) return;

    try {
      history.replaceState(null, "", `#${tab}`);
    } catch {
      // The in-memory tab state above stays authoritative.
    }
    setActiveTab(tab);
  }

  function resetConfig() {
    configRequested = false;
    setPublicConfig(undefined);
    setConfigured(false);
    setConfigLoaded(false);
    setActiveTab("torrents");
  }

  function applySession(session: AuthSession) {
    setAuthStatus({
      initialized: true,
      requiresSetupCode: false,
      authenticated: true,
      username: session.username,
      totpEnabled: session.totpEnabled,
    });
    setSetupStatus(undefined);
    setSignInStatus(undefined);
    setTotpRequired(false);
  }

  async function handleSetup(credentials: SetupCredentials) {
    if (setupBusy()) return;

    setSetupBusy(true);
    setSetupStatus({ tone: "muted", message: "Creating your account…" });
    try {
      // SetupView only sends `setupCode` when the deployment requires one.
      const body: SetupAdminRequest = credentials;
      applySession(await setupAdmin(body));
    } catch (error) {
      if (error instanceof ProxyApiError && error.status === 409) {
        // Another tab or first-run request won the race; reload the real state.
        void boot();
        return;
      }
      setSetupStatus({ tone: "error", message: errorMessage(error) });
    } finally {
      setSetupBusy(false);
    }
  }

  async function handleSignIn(values: SignInValues) {
    if (signInBusy()) return;

    setSignInBusy(true);
    setSignInStatus({ tone: "muted", message: "Signing in…" });
    try {
      const body: LoginRequest = {
        username: values.username,
        password: values.password,
        ...(values.totpCode ? { totpCode: values.totpCode } : {}),
      };
      applySession(await loginAdmin(body));
    } catch (error) {
      if (
        error instanceof ProxyApiError &&
        error.status === 401 &&
        error.code === "totp_required"
      ) {
        setTotpRequired(true);
        setSignInStatus({
          tone: "warn",
          message: "Enter the 6-digit code from your authenticator app, or a saved recovery code.",
        });
      } else {
        setSignInStatus({ tone: "error", message: errorMessage(error) });
      }
    } finally {
      setSignInBusy(false);
    }
  }

  async function handleSignOut() {
    // Revoke before dropping the dashboard so a visible QR code cannot be used
    // after the session is gone.
    revokeActivePairing?.();

    try {
      await logoutAdmin();
    } catch {
      // The cookie may already be gone; return to sign-in regardless.
    }

    setAuthStatus((current) => (current ? { ...current, authenticated: false } : current));
    setHealth(undefined);
    resetConfig();
    setTotpRequired(false);
    setSignInStatus({ tone: "ok", message: "Signed out." });
  }

  function handleSessionExpired() {
    setAuthStatus((current) =>
      current
        ? { ...current, authenticated: false }
        : {
            initialized: true,
            requiresSetupCode: false,
            authenticated: false,
            username: null,
            totpEnabled: false,
          },
    );
    setHealth(undefined);
    resetConfig();
    setTotpRequired(false);
    setSignInStatus({ tone: "error", message: SESSION_ENDED });
  }

  function handleTotpChanged(enabled: boolean) {
    setAuthStatus((current) => (current ? { ...current, totpEnabled: enabled } : current));
  }

  function openReport(context?: IssueReportContext) {
    setReportContext(context);
    setReportOpen(true);
  }

  /** A client label only; URLs and credentials never reach the report dialog. */
  const backendLabel = () => {
    const current = health();
    if (!current) return "Remagnet Proxy";
    return `${current.clientLabel} ${current.appVersion}`.trim() || "Remagnet Proxy";
  };

  const signInView = () => (
    <SignInView
      busy={signInBusy()}
      totpRequired={totpRequired()}
      status={signInStatus()}
      onSubmit={(values) => void handleSignIn(values)}
    />
  );

  return (
    <div class="proxy-shell">
      <Show when={booted()} fallback={<LoadingView />}>
        <Show when={authStatus()} fallback={signInView()}>
          {(status) => (
            <Show
              when={status().initialized}
              fallback={
                <SetupView
                  requiresSetupCode={status().requiresSetupCode}
                  busy={setupBusy()}
                  status={setupStatus()}
                  onSubmit={(credentials) => void handleSetup(credentials)}
                />
              }
            >
              <Show when={status().authenticated} fallback={signInView()}>
                <Show when={configLoaded()} fallback={<LoadingView />}>
                  <main class="proxy-main">
                    <div class="stack">
                      <header class="options-header">
                        <div class="masthead">
                          <Wordmark as="p" size="lg" surface="Proxy" iconSrc="/icon.svg" />
                          <div class="account-bar">
                            <span>
                              Signed in as <strong>{status().username ?? ""}</strong>
                            </span>
                            <button
                              type="button"
                              class="ghost"
                              onClick={() => void handleSignOut()}
                            >
                              Sign out
                            </button>
                          </div>
                        </div>
                        {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the section navigation is a tablist landmark. */}
                        <nav class="nav-tabs" role="tablist" aria-label="Proxy sections">
                          <For each={allowedTabs()}>
                            {(tab) => (
                              <button
                                type="button"
                                role="tab"
                                class="nav-tab"
                                classList={{ "nav-tab-active": activeTab() === tab }}
                                aria-selected={activeTab() === tab}
                                onClick={() => selectTab(tab)}
                              >
                                {TAB_LABELS[tab]}
                              </button>
                            )}
                          </For>
                        </nav>
                      </header>

                      <Switch>
                        <Match when={activeTab() === "torrents"}>
                          <TorrentsPanel
                            health={health()}
                            refreshTrigger={refreshTrigger()}
                            onSessionExpired={handleSessionExpired}
                            onReportIssue={openReport}
                          />
                        </Match>

                        <Match when={activeTab() === "devices"}>
                          <div class="stack">
                            <PairingPanel
                              revokeRef={(revoke) => {
                                revokeActivePairing = revoke;
                              }}
                              onReportIssue={openReport}
                            />
                            <DevicesPanel onReportIssue={openReport} />
                          </div>
                        </Match>

                        <Match when={activeTab() === "connection"}>
                          <Show when={!configured()}>
                            <p class="status warn onboarding-note">
                              Connect qBittorrent, Transmission, Deluge, or rTorrent below to start
                              managing torrents and pairing devices.
                            </p>
                          </Show>
                          <ClientConfigPanel
                            initialConfig={publicConfig() ?? null}
                            onConfigChange={handleConfigChange}
                            onHealthChange={setHealth}
                            onReportIssue={openReport}
                          />
                        </Match>

                        <Match when={activeTab() === "account"}>
                          <SecurityPanel
                            totpEnabled={status().totpEnabled}
                            onTotpChanged={handleTotpChanged}
                            onSessionExpired={handleSessionExpired}
                            onReportIssue={openReport}
                          />
                        </Match>
                      </Switch>
                    </div>
                  </main>
                </Show>
              </Show>
            </Show>
          )}
        </Show>
      </Show>

      <PageFooter version={proxyVersion()} onReport={() => openReport()} />

      <IssueReportDialog
        open={reportOpen()}
        component="Remagnet Proxy"
        version={proxyVersion() || "dev"}
        backend={backendLabel()}
        context={reportContext()}
        onClose={() => setReportOpen(false)}
      />
    </div>
  );
}

/** Shown until `/api/auth/status` answers. */
function LoadingView() {
  return (
    <main class="proxy-main">
      <div class="auth-shell">
        <header class="options-header">
          <Wordmark as="p" size="lg" surface="Proxy" iconSrc="/icon.svg" />
        </header>
        <p class="status muted" role="status" aria-live="polite">
          Loading…
        </p>
      </div>
    </main>
  );
}
