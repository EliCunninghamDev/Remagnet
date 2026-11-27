import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
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
  expect(screen.getByTitle("Download this completed torrent")).toBeTruthy();
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

test("pausing a torrent posts to the pause endpoint and refreshes the list", async () => {
  let torrentRequests = 0;

  handler = (url, init) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") {
      torrentRequests += 1;
      return { body: { torrents: [torrent] } };
    }
    if (url === `/api/torrents/${torrent.hash}/pause` && init.method === "POST") {
      return { status: 204 };
    }
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());
  const before = torrentRequests;

  fireEvent.click(screen.getByRole("button", { name: "Pause torrent" }));

  await waitFor(() =>
    expect(
      calls.some(
        (call) => call.url === `/api/torrents/${torrent.hash}/pause` && call.init.method === "POST",
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(torrentRequests).toBeGreaterThan(before));
  expect(await screen.findByText("Paused Ubuntu 24.04.iso.")).toBeTruthy();
});

test("resuming a torrent posts to the resume endpoint and refreshes the list", async () => {
  const stopped = { ...torrent, state: "stopped" };
  let torrentRequests = 0;

  handler = (url, init) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") {
      torrentRequests += 1;
      return { body: { torrents: [stopped] } };
    }
    if (url === `/api/torrents/${stopped.hash}/resume` && init.method === "POST") {
      return { status: 204 };
    }
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());
  const before = torrentRequests;

  fireEvent.click(screen.getByRole("button", { name: "Resume torrent" }));

  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.url === `/api/torrents/${stopped.hash}/resume` && call.init.method === "POST",
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(torrentRequests).toBeGreaterThan(before));
  expect(await screen.findByText("Resumed Ubuntu 24.04.iso.")).toBeTruthy();
});

test("bulk pause and resume post to the bulk endpoints", async () => {
  const stopped = {
    ...torrent,
    hash: "b".repeat(40),
    name: "Ubuntu 24.04 paused.iso",
    state: "stopped",
  };
  let torrentRequests = 0;

  handler = (url, init) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") {
      torrentRequests += 1;
      return { body: { torrents: [torrent, stopped] } };
    }
    if (url === "/api/torrents/pause" && init.method === "POST") return { status: 204 };
    if (url === "/api/torrents/resume" && init.method === "POST") return { status: 204 };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Pause all" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Resume all" })).toBeTruthy();

  const beforePause = torrentRequests;
  fireEvent.click(screen.getByRole("button", { name: "Pause all" }));

  await waitFor(() =>
    expect(
      calls.some((call) => call.url === "/api/torrents/pause" && call.init.method === "POST"),
    ).toBe(true),
  );
  expect(await screen.findByText("Paused all torrents.")).toBeTruthy();
  await waitFor(() => expect(torrentRequests).toBeGreaterThan(beforePause));

  const resumeAll = screen.getByRole("button", { name: "Resume all" }) as HTMLButtonElement;
  await waitFor(() => expect(resumeAll.disabled).toBe(false));

  const beforeResume = torrentRequests;
  fireEvent.click(resumeAll);

  await waitFor(() =>
    expect(
      calls.some((call) => call.url === "/api/torrents/resume" && call.init.method === "POST"),
    ).toBe(true),
  );
  expect(await screen.findByText("Resumed all torrents.")).toBeTruthy();
  await waitFor(() => expect(torrentRequests).toBeGreaterThan(beforeResume));
});

test("Pause all and Resume all only show when a matching torrent exists", async () => {
  let list = [torrent];

  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: list } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Pause all" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Resume all" })).toBeNull();

  list = [{ ...torrent, state: "stopped" }];
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

  await waitFor(() => expect(screen.queryByRole("button", { name: "Pause all" })).toBeNull());
  expect(screen.getByRole("button", { name: "Resume all" })).toBeTruthy();
});

function listedTorrentNames(): string[] {
  return Array.from(document.querySelectorAll(".proxy-torrent-list .torrent-name")).map(
    (element) => element.getAttribute("title") ?? "",
  );
}

function filterTab(label: string): HTMLElement {
  return screen.getByRole("tab", { name: new RegExp(`^${label}`) });
}

test("torrent list search, filters, sort and reset work together", async () => {
  const ready = { ...torrent, hash: "a".repeat(40), name: "Alpha Ready.iso" };
  const paused = {
    ...torrent,
    hash: "b".repeat(40),
    name: "Middle Paused.iso",
    state: "stopped",
    progress: 0.2,
  };
  const downloading = {
    ...torrent,
    hash: "c".repeat(40),
    name: "Zulu Download.iso",
    state: "downloading",
    progress: 0.4,
  };

  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [downloading, ready, paused] } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() =>
    expect(screen.getByRole("searchbox", { name: "Search torrents" })).toBeTruthy(),
  );
  expect(listedTorrentNames()).toEqual([
    "Zulu Download.iso",
    "Alpha Ready.iso",
    "Middle Paused.iso",
  ]);

  const search = screen.getByRole("searchbox", { name: "Search torrents" });
  fireEvent.input(search, { target: { value: "alpha" } });
  await waitFor(() => expect(listedTorrentNames()).toEqual(["Alpha Ready.iso"]));

  fireEvent.input(search, { target: { value: "" } });
  await waitFor(() => expect(listedTorrentNames()).toHaveLength(3));

  fireEvent.click(filterTab("Active"));
  await waitFor(() => expect(listedTorrentNames()).toEqual(["Zulu Download.iso"]));
  expect(filterTab("Active").getAttribute("aria-selected")).toBe("true");

  fireEvent.click(filterTab("Ready"));
  await waitFor(() => expect(listedTorrentNames()).toEqual(["Alpha Ready.iso"]));

  fireEvent.click(filterTab("Paused"));
  await waitFor(() => expect(listedTorrentNames()).toEqual(["Middle Paused.iso"]));

  fireEvent.click(filterTab("All"));
  await waitFor(() => expect(listedTorrentNames()).toHaveLength(3));

  fireEvent.change(screen.getByLabelText("Sort torrents"), { target: { value: "name" } });
  await waitFor(() =>
    expect(listedTorrentNames()).toEqual([
      "Alpha Ready.iso",
      "Middle Paused.iso",
      "Zulu Download.iso",
    ]),
  );

  fireEvent.input(search, { target: { value: "no-such-torrent" } });
  await waitFor(() => expect(screen.getByText("No torrents match your filter.")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  await waitFor(() => expect(listedTorrentNames()).toHaveLength(3));
  expect(filterTab("All").getAttribute("aria-selected")).toBe("true");
  expect(
    (screen.getByRole("searchbox", { name: "Search torrents" }) as HTMLInputElement).value,
  ).toBe("");
});

test("the search and filter bar hides for a single torrent", async () => {
  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [torrent] } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());
  expect(screen.queryByRole("searchbox", { name: "Search torrents" })).toBeNull();
  expect(screen.queryByLabelText("Sort torrents")).toBeNull();
  expect(screen.queryByRole("tab", { name: /^All/ })).toBeNull();
});

function fileRow(name: string): HTMLElement {
  const label = Array.from(document.querySelectorAll(".torrent-file-list .torrent-file-name")).find(
    (element) => element.textContent === name,
  );
  const row = label?.closest(".torrent-file-row");
  if (!(row instanceof HTMLElement)) throw new Error(`No file row for ${name}`);
  return row;
}

test("showing torrent files fetches the file list and marks completion", async () => {
  const files = [
    { index: 0, name: "Ubuntu 24.04.iso", size: 2_048, progress: 1 },
    { index: 1, name: "docs/readme.txt", size: 512, progress: 0.5 },
  ];

  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [torrent] } };
    if (url === `/api/torrents/${torrent.hash}/files`) return { body: { files } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Show files" }));

  await waitFor(() =>
    expect(
      calls.some(
        (call) => call.url === `/api/torrents/${torrent.hash}/files` && call.init.method === "GET",
      ),
    ).toBe(true),
  );
  expect(await screen.findByText("docs/readme.txt")).toBeTruthy();

  const completeRow = fileRow("Ubuntu 24.04.iso");
  expect(completeRow.textContent).toContain("2 KB");
  expect(completeRow.textContent).not.toContain("%");
  expect(within(completeRow).getByRole("button", { name: "Download" })).toBeTruthy();

  const partialRow = fileRow("docs/readme.txt");
  expect(partialRow.textContent).toContain("50%");
  expect(within(partialRow).queryByRole("button", { name: "Download" })).toBeNull();
});

test("downloading one completed file mints a ticket and opens its href", async () => {
  const files = [
    { index: 0, name: "Ubuntu 24.04.iso", size: 2_048, progress: 1 },
    { index: 1, name: "docs/readme.txt", size: 512, progress: 0.5 },
  ];
  const clickedHrefs: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clickedHrefs.push(this.href);
  });

  handler = (url, init) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [torrent] } };
    if (url === `/api/torrents/${torrent.hash}/files`) return { body: { files } };
    if (url === `/api/archive/${torrent.hash}/files/0/ticket` && init.method === "POST") {
      return { body: { ticket: "file-ticket-1", expiresIn: 60 } };
    }
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Show files" }));
  await screen.findByText("docs/readme.txt");

  fireEvent.click(within(fileRow("Ubuntu 24.04.iso")).getByRole("button", { name: "Download" }));

  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.url === `/api/archive/${torrent.hash}/files/0/ticket` && call.init.method === "POST",
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(
      clickedHrefs.some((href) =>
        href.endsWith(`/archive/${torrent.hash}/files/0?ticket=file-ticket-1`),
      ),
    ).toBe(true),
  );
  expect(calls.some((call) => call.url === `/api/archive/${torrent.hash}/ticket`)).toBe(false);
});

test("incomplete files do not offer a Download action", async () => {
  const files = [{ index: 3, name: "still-downloading.mkv", size: 1_024, progress: 0.25 }];

  handler = (url) => {
    if (url === "/healthz") return { body: liveness };
    if (url === "/api/auth/status") return { body: authStatus({ authenticated: true }) };
    if (url === "/api/config") return { body: config };
    if (url === "/api/torrents") return { body: { torrents: [torrent] } };
    if (url === `/api/torrents/${torrent.hash}/files`) return { body: { files } };
    if (url === "/api/devices") return { body: { devices: [] } };
    return { body: {} };
  };

  render(() => <App />);

  await waitFor(() => expect(screen.getByTitle("Ubuntu 24.04.iso")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Show files" }));

  await waitFor(() => expect(screen.getByText("still-downloading.mkv")).toBeTruthy());
  const row = fileRow("still-downloading.mkv");
  expect(row.textContent).toContain("25%");
  expect(within(row).queryByRole("button", { name: "Download" })).toBeNull();
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
