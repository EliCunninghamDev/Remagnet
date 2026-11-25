import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import type { Component } from "solid-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

type MockResponse = { status?: number; body?: unknown };
type Handler = (url: string, init: RequestInit) => MockResponse | Promise<MockResponse>;
type FetchCall = { url: string; init: RequestInit };

const liveness = {
  ok: true,
  service: "remagnet-proxy",
  version: "0.3.1",
  apiVersion: 1,
};

const health = {
  ok: true,
  clientLabel: "qBittorrent",
  appVersion: "5.3.0",
  webApiVersion: "2.16.2",
  apiVersion: 1,
  proxyVersion: "0.3.1",
  capabilities: {
    pauseOnAdd: true,
    archiveDownload: true,
    categories: true,
    tags: true,
    torrentFiles: true,
  },
  defaultCategory: "remagnet",
  defaultTags: ["remagnet"],
};

const config = {
  clientKind: "qbittorrent",
  baseUrl: "http://gluetun:8080",
  username: "admin",
  hasApiKey: true,
  hasPassword: true,
  downloadsDir: "/downloads",
  clientDownloadsDir: "",
  defaultCategory: "remagnet",
  defaultTags: ["remagnet", "proxy"],
  configured: true,
  envLocked: [] as string[],
};

const torrent = {
  hash: "dc555f7a26f1acae38a18edc04e53588ade33051",
  name: "Ubuntu 24.04.iso",
  state: "seeding",
  progress: 1,
  size: 2_048,
  downloadSpeed: 0,
  uploadSpeed: 128,
  eta: 8_640_000,
  ratio: 1,
  category: "remagnet",
  tags: ["remagnet"],
  seeds: 3,
  peers: 1,
};

let handler: Handler;
let calls: FetchCall[];
let App: Component;

beforeEach(async () => {
  calls = [];
  handler = (url) => (url === "/healthz" ? { body: liveness } : { body: {} });

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : undefined;
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = raw.startsWith("http") ? new URL(raw).pathname : raw;
    const callInit = {
      ...init,
      method: request?.method ?? init.method,
      body: request ? await request.clone().text() : init.body,
    };
    calls.push({ url, init: callInit });

    const { status = 200, body } = await handler(url, callInit);
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    window.history.replaceState(null, "", "/");
  } catch {
    // The default test origin is enough when history writes are restricted.
  }

  Object.defineProperty(window, "confirm", {
    configurable: true,
    value: vi.fn(() => true),
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });

  // `api.ts` captures `fetch` when the module is first evaluated, so load the
  // app after the mock is installed. Later tests reuse the same client, which
  // reads the current `handler` through this closure.
  ({ default: App } = await import("./App"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function authStatus(overrides: Record<string, unknown>) {
  return {
    initialized: true,
    requiresSetupCode: false,
    authenticated: false,
    username: "admin",
    totpEnabled: false,
    ...overrides,
  };
}

test("first run renders the setup view", async () => {
  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") {
      return { body: authStatus({ initialized: false, username: null }) };
    }
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Create admin account" })).toBeTruthy(),
  );
  expect(screen.getByLabelText("Username")).toBeTruthy();
  expect(screen.getByLabelText(/^Password/)).toBeTruthy();
  expect(screen.getByLabelText("Confirm password")).toBeTruthy();
  await waitFor(() => expect(screen.getByText("Remagnet Proxy 0.3.1")).toBeTruthy());
});

test("sign-in asks for a second factor after totp_required", async () => {
  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({}) };
    if (url === "/api/auth/login") {
      return {
        status: 401,
        body: { error: "Two-factor authentication is required.", code: "totp_required" },
      };
    }
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy());
  fireEvent.input(screen.getByLabelText("Username"), { target: { value: "admin" } });
  fireEvent.input(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  await waitFor(() => expect(screen.getByLabelText(/^Two-factor code/)).toBeTruthy());
  expect(
    screen.getByText(
      "Enter the 6-digit code from your authenticator app, or a saved recovery code.",
    ),
  ).toBeTruthy();

  const login = calls.find((call) => call.url === "/api/auth/login");
  expect(login?.init.method).toBe("POST");
  expect(JSON.parse(String(login?.init.body))).toEqual({
    username: "admin",
    password: "correct horse",
  });
});

test("configured dashboard defaults to Torrents and switches between every tab", async () => {
  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [torrent] } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  expect(await screen.findByText(/Signed in as/)).toBeTruthy();
  expect(screen.getByText("admin")).toBeTruthy();

  const torrentsTab = screen.getByRole("tab", { name: "Torrents" });
  expect(torrentsTab.getAttribute("aria-selected")).toBe("true");

  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());
  expect(screen.getByTitle("Download this completed torrent as a ZIP")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Remove torrent" }));
  await waitFor(() => expect(screen.getByText("Remove this torrent?")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Keep files" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete files" })).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "Devices" }));
  expect(await screen.findByRole("heading", { name: "Pair a device" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Connected devices" })).toBeTruthy();
  expect(screen.queryByTitle("Ubuntu 24.04.iso")).toBeNull();
  expect(screen.getByRole("tab", { name: "Devices" }).getAttribute("aria-selected")).toBe("true");

  fireEvent.click(screen.getByRole("tab", { name: "Connection" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Torrent client" })).toBeTruthy());
  expect(screen.queryByRole("heading", { name: "Pair a device" })).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "Account" }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Account & security" })).toBeTruthy(),
  );

  fireEvent.click(screen.getByRole("tab", { name: "Torrents" }));
  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());
  await waitFor(() => expect(screen.getByText("Remagnet Proxy 0.3.1")).toBeTruthy());
});

test("unconfigured dashboard starts on Connection and unlocks after saving", async () => {
  const unconfigured = {
    ...config,
    baseUrl: "",
    username: "",
    hasApiKey: false,
    hasPassword: false,
    configured: false,
    envLocked: [],
  };
  const connected = { ...config, configured: true, envLocked: [] };

  handler = (url, init) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") {
      return { body: init.method === "PUT" ? connected : unconfigured };
    }
    if (url === "/api/torrents") return { body: { torrents: [] } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  expect(await screen.findByText(/Signed in as/)).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Connection" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(screen.queryByRole("tab", { name: "Torrents" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Devices" })).toBeNull();
  expect(
    screen.getByText(
      "Connect qBittorrent, Transmission, Deluge, or rTorrent below to start managing torrents and pairing devices.",
    ),
  ).toBeTruthy();

  fireEvent.input(screen.getByLabelText(/^Web UI URL/), {
    target: { value: "http://gluetun:8080" },
  });
  fireEvent.input(screen.getByLabelText(/^API key/), { target: { value: "qbt_test" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(screen.getByRole("tab", { name: "Torrents" })).toBeTruthy());
  expect(screen.getByRole("tab", { name: "Devices" })).toBeTruthy();
  expect(
    screen.queryByText(
      "Connect qBittorrent, Transmission, Deluge, or rTorrent below to start managing torrents and pairing devices.",
    ),
  ).toBeNull();

  const put = calls.find((call) => call.url === "/api/config" && call.init.method === "PUT");
  expect(JSON.parse(String(put?.init.body))).toMatchObject({
    clientKind: "qbittorrent",
    baseUrl: "http://gluetun:8080",
    apiKey: "qbt_test",
  });
});

test("switching to Deluge submits its connection fields", async () => {
  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [] } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  expect(await screen.findByText(/Signed in as/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Connection" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Torrent client" })).toBeTruthy());

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "deluge" } });
  await waitFor(() => expect(screen.getByLabelText(/^Web UI URL/)).toBeTruthy());

  fireEvent.input(screen.getByLabelText(/^Web UI URL/), {
    target: { value: "http://deluge:8112" },
  });
  fireEvent.input(screen.getByLabelText(/^Password/), {
    target: { value: "deluge-password" },
  });
  fireEvent.input(screen.getByLabelText(/^Downloads directory/), {
    target: { value: "/downloads" },
  });
  fireEvent.input(screen.getByLabelText(/^Client downloads path/), {
    target: { value: "/data/deluge" },
  });
  fireEvent.input(screen.getByLabelText(/^Label/), {
    target: { value: "remagnet" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());

  const put = calls.find((call) => call.url === "/api/config" && call.init.method === "PUT");
  expect(JSON.parse(String(put?.init.body))).toEqual({
    clientKind: "deluge",
    baseUrl: "http://deluge:8112",
    password: "deluge-password",
    downloadsDir: "/downloads",
    clientDownloadsDir: "/data/deluge",
    defaultCategory: "remagnet",
    defaultTags: [],
  });
});

test("switching to rTorrent submits its connection fields", async () => {
  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [] } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  expect(await screen.findByText(/Signed in as/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Connection" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Torrent client" })).toBeTruthy());

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "rtorrent" } });
  await waitFor(() => expect(screen.getByLabelText(/^XML-RPC URL/)).toBeTruthy());

  fireEvent.input(screen.getByLabelText(/^XML-RPC URL/), {
    target: { value: "http://rtorrent:8000" },
  });
  fireEvent.input(screen.getByLabelText(/^Username/), { target: { value: "admin" } });
  fireEvent.input(screen.getByLabelText(/^Password/), {
    target: { value: "rtorrent-password" },
  });
  fireEvent.input(screen.getByLabelText(/^Downloads directory/), {
    target: { value: "/downloads" },
  });
  fireEvent.input(screen.getByLabelText(/^Client downloads path/), {
    target: { value: "/data/rtorrent" },
  });
  fireEvent.input(screen.getByLabelText(/^Label/), {
    target: { value: "remagnet" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());

  const put = calls.find((call) => call.url === "/api/config" && call.init.method === "PUT");
  expect(JSON.parse(String(put?.init.body))).toEqual({
    clientKind: "rtorrent",
    baseUrl: "http://rtorrent:8000",
    username: "admin",
    password: "rtorrent-password",
    downloadsDir: "/downloads",
    clientDownloadsDir: "/data/rtorrent",
    defaultCategory: "remagnet",
    defaultTags: [],
  });
});

test("environment-locked fields show badges, stay read-only, and only send unlocked values", async () => {
  const lockedConfig = {
    ...config,
    configured: true,
    envLocked: ["clientKind", "baseUrl", "apiKey"],
  };

  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: lockedConfig };
    if (url === "/api/health") return { body: health };
    if (url === "/api/torrents") return { body: { torrents: [] } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  expect(await screen.findByText(/Signed in as/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Connection" }));

  await waitFor(() => expect(screen.getByRole("heading", { name: "Torrent client" })).toBeTruthy());

  expect(screen.getAllByText("Env")).toHaveLength(3);
  expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText(/^Web UI URL/) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText(/^API key/) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Remove the saved API key") as HTMLInputElement).disabled).toBe(
    true,
  );

  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(false);

  const testConnection = screen.getByRole("button", {
    name: "Test connection",
  }) as HTMLButtonElement;
  expect(testConnection.disabled).toBe(false);
  fireEvent.click(testConnection);
  await waitFor(() => expect(calls.some((call) => call.url === "/api/health")).toBe(true));

  fireEvent.input(screen.getByLabelText(/Category/), { target: { value: "updated" } });
  fireEvent.click(save);
  await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());

  const configGets = calls.filter(
    (call) => call.url === "/api/config" && call.init.method !== "PUT",
  );
  expect(configGets).toHaveLength(1);

  const put = calls.find((call) => call.url === "/api/config" && call.init.method === "PUT");
  const body = JSON.parse(String(put?.init.body));
  expect(body).not.toHaveProperty("clientKind");
  expect(body).not.toHaveProperty("baseUrl");
  expect(body).not.toHaveProperty("apiKey");
  expect(body.defaultCategory).toBe("updated");
  expect(body).toHaveProperty("defaultTags");
});

test("devices tab exposes Copy link even while the QR code is hidden", async () => {
  const pairing = {
    id: "pair_hidden_1",
    uri: "remagnet://pair?origin=http%3A%2F%2Flocalhost&session=pair_hidden_1&code=abc",
    svg: "<svg></svg>",
    expiresIn: 60,
  };

  handler = (url, init) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [] } };
    if (url === "/api/devices") return { body: { devices: [] } };
    if (url === "/api/pair" && init.method === "POST") return { body: pairing };
    return { body: {} };
  };

  render(() => <App />);

  expect(await screen.findByText(/Signed in as/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Devices" }));
  expect(await screen.findByRole("heading", { name: "Pair a device" })).toBeTruthy();

  expect(screen.getByRole("button", { name: "Show QR code" })).toBeTruthy();
  const copyButton = screen.getByRole("button", { name: "Copy link" });
  expect(copyButton).toBeTruthy();
  expect(screen.queryByRole("img", { name: "QR code for pairing a Remagnet device" })).toBeNull();

  fireEvent.click(copyButton);

  await waitFor(() =>
    expect(screen.getByText("Copied a one-time pairing link. Expires in 60s.")).toBeTruthy(),
  );
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(pairing.uri);
  expect(screen.queryByRole("img", { name: "QR code for pairing a Remagnet device" })).toBeNull();
});

test("copy link falls back to showing the URI when clipboard write fails while QR is hidden", async () => {
  const pairing = {
    id: "pair_hidden_2",
    uri: "remagnet://pair?origin=http%3A%2F%2Flocalhost&session=pair_hidden_2&code=xyz",
    svg: "<svg></svg>",
    expiresIn: 60,
  };

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
  });

  handler = (url, init) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [] } };
    if (url === "/api/devices") return { body: { devices: [] } };
    if (url === "/api/pair" && init.method === "POST") return { body: pairing };
    return { body: {} };
  };

  render(() => <App />);

  expect(await screen.findByText(/Signed in as/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Devices" }));
  fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));

  await waitFor(() =>
    expect(screen.getByText("Could not copy. Select the link below instead.")).toBeTruthy(),
  );
  expect(screen.getByText(pairing.uri)).toBeTruthy();
  expect(screen.queryByRole("img", { name: "QR code for pairing a Remagnet device" })).toBeNull();
});

test("refreshing torrents keeps the Refresh label stable and does not flash a status line", async () => {
  let resolveRefresh: ((value: MockResponse) => void) | undefined;
  let torrentRequests = 0;

  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") {
      torrentRequests += 1;
      if (torrentRequests === 1) return { body: { torrents: [torrent] } };
      return new Promise<MockResponse>((resolve) => {
        resolveRefresh = resolve;
      });
    }
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());

  const refresh = screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
  fireEvent.click(refresh);

  await waitFor(() => expect(resolveRefresh).toBeDefined());
  expect(refresh.disabled).toBe(true);
  expect(refresh.textContent).toBe("Refresh");
  expect(refresh.getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText("Refreshing…")).toBeNull();
  expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy();

  resolveRefresh?.({ body: { torrents: [torrent] } });
  await waitFor(() => expect(refresh.disabled).toBe(false));
  expect(refresh.getAttribute("aria-busy")).toBe("false");
});

test("the footer opens the shared issue report dialog", async () => {
  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [] } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  fireEvent.click(await screen.findByRole("button", { name: "Report an issue" }));

  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Report an issue" })).toBeTruthy();

  await waitFor(() => {
    const preview = document.querySelector(".diagnostics-preview");
    expect(preview?.textContent).toContain("Component: Remagnet Proxy");
    expect(preview?.textContent).toContain("Version: 0.3.1");
  });
});
