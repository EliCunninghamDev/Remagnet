/**
 * Real Remagnet SolidJS screen adapter for Promo Studio (HTML-in-Canvas).
 *
 * Mounts the production `PopupList`, `SquareBar` (with real ease-out-back tile
 * pop physics, bitmap counter ripple, and diagonal ZIP/DONE sweeps), `MagnetReview`,
 * and `Wordmark` components directly inside Promo Studio's `<div drawable>`.
 */

import "../extension/assets/app.css";
import "./promo-screens.css";

import { createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { render } from "solid-js/web";
import MagnetReview from "../extension/components/MagnetReview";
import PopupList from "../extension/components/PopupList";
import { parseMagnet } from "../extension/lib/magnet";
import type { TorrentSummary } from "../extension/lib/torrents";

export interface ScreenMountOptions {
  templateId: string;
  animT: number | null;
  width: number;
  height: number;
  state?: Record<string, unknown>;
}

const DEMO_MAGNET = parseMagnet(
  "magnet:?xt=urn:btih:9f2a8c41e0b71a62d83f59c41802ab714d18e3b0&dn=Nebula-Linux-4.2-Workstation-x86_64.iso&xl=5175435264&tr=https%3A%2F%2Ftracker.nebula-linux.org%2Fannounce&tr=udp%3A%2F%2Fmirrors.kernel.example%3A6969",
);

const noop = () => undefined;

function buildLiveTorrents(
  animT: number | null,
  isPortrait: boolean,
): { torrents: TorrentSummary[]; downloadingHash?: string } {
  let primary: TorrentSummary;
  let downloadingHash: string | undefined;

  if (animT === null) {
    primary = {
      hash: "a100000000000000000000000000000000000001",
      name: "Nebula-Linux-4.2-Workstation-x86_64.iso",
      state: "downloading",
      progress: 0.64,
      size: 5_175_435_264,
      downloadSpeed: 17_200_000,
      uploadSpeed: 0,
      eta: 248,
      ratio: 0,
      category: "remagnet",
      tags: ["remagnet"],
      seeds: 42,
      peers: 11,
    };
  } else if (animT < 0.62) {
    const p = Math.min(0.99, 0.04 + (animT / 0.62) * 0.95);
    const speed = Math.round(15_200_000 + Math.sin(animT * 24) * 2_800_000);
    const eta = Math.max(1, Math.round((1 - p) * 260));
    primary = {
      hash: "a100000000000000000000000000000000000001",
      name: "Nebula-Linux-4.2-Workstation-x86_64.iso",
      state: "downloading",
      progress: p,
      size: 5_175_435_264,
      downloadSpeed: speed,
      uploadSpeed: 0,
      eta,
      ratio: 0,
      category: "remagnet",
      tags: ["remagnet"],
      seeds: 48,
      peers: 14,
    };
  } else if (animT < 0.8) {
    // Triggers the real SquareBar amber diagonal ZIP_SWEEP animation!
    downloadingHash = "a100000000000000000000000000000000000001";
    primary = {
      hash: "a100000000000000000000000000000000000001",
      name: "Nebula-Linux-4.2-Workstation-x86_64.iso",
      state: "seeding",
      progress: 1,
      size: 5_175_435_264,
      downloadSpeed: 0,
      uploadSpeed: 1_900_000,
      eta: 0,
      ratio: 0.4,
      category: "remagnet",
      tags: ["remagnet"],
      seeds: 54,
      peers: 9,
    };
  } else {
    // Triggers the real SquareBar sage-green DONE_SWEEP animation!
    primary = {
      hash: "a100000000000000000000000000000000000001",
      name: "Nebula-Linux-4.2-Workstation-x86_64.iso",
      state: "seeding",
      progress: 1,
      size: 5_175_435_264,
      downloadSpeed: 0,
      uploadSpeed: 2_350_000,
      eta: 0,
      ratio: 0.7,
      category: "remagnet",
      tags: ["remagnet"],
      seeds: 58,
      peers: 12,
    };
  }

  const list: TorrentSummary[] = [
    primary,
    {
      hash: "b200000000000000000000000000000000000002",
      name: "Fedora-Workstation-Live-44-x86_64.iso",
      state: "stalled",
      progress: 0.34,
      size: 6_512_230_400,
      downloadSpeed: 0,
      uploadSpeed: 0,
      eta: 8_640_000,
      ratio: 0,
      category: "remagnet",
      tags: ["remagnet"],
      seeds: 5,
      peers: 0,
    },
    {
      hash: "c300000000000000000000000000000000000003",
      name: "ubuntu-26.04-desktop-amd64.iso",
      state: "seeding",
      progress: 1,
      size: 6_120_400_000,
      downloadSpeed: 0,
      uploadSpeed: 1_468_006,
      eta: 0,
      ratio: 1.2,
      category: "remagnet",
      tags: ["remagnet"],
      seeds: 58,
      peers: 12,
    },
  ];

  if (isPortrait) {
    list.push({
      hash: "d400000000000000000000000000000000000004",
      name: "debian-13.2.0-arm64-netinst.iso",
      state: "seeding",
      progress: 1,
      size: 754_974_720,
      downloadSpeed: 0,
      uploadSpeed: 890_000,
      eta: 0,
      ratio: 0.9,
      category: "remagnet",
      tags: ["remagnet"],
      seeds: 31,
      peers: 4,
    });
  }

  return { torrents: list, downloadingHash };
}

function RealPopup(props: { animT: number | null; isPortrait?: boolean }) {
  const data = createMemo(() => buildLiveTorrents(props.animT, !!props.isPortrait));
  return (
    <div class="theme-popup rmg-popup-shell">
      <main class="popup">
        <PopupList
          torrents={data().torrents}
          loading={false}
          configured
          serverLabel="https://remagnet.example.com"
          downloadingHash={data().downloadingHash}
          onRetry={noop}
          onOpenSettings={noop}
          onDismissActionError={noop}
          onAdd={noop}
          onZip={noop}
          onRemoveToggle={noop}
          onRemove={noop}
          onCancelRemove={noop}
        />
      </main>
    </div>
  );
}

function BrowserFrame(props: {
  browser: "chrome" | "firefox";
  mode: "popup" | "context";
  animT: number | null;
}) {
  const showContext = () =>
    props.mode === "context" &&
    (props.animT === null || (props.animT >= 0.14 && props.animT < 0.34));
  const showPopover = () =>
    props.mode === "popup" ||
    (props.mode === "context" && props.animT !== null && props.animT >= 0.34);
  const popupAnimT = () => {
    if (props.animT === null) return null;
    if (props.mode === "context") {
      return Math.max(0, Math.min(1, (props.animT - 0.34) / 0.66));
    }
    return props.animT;
  };

  return (
    <div class={`rmg-browser rmg-browser-${props.browser}`}>
      <div class="rmg-tabstrip">
        <div class="rmg-win-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div class="rmg-tab active">
          <span class="rmg-tab-dot" />
          <span class="rmg-tab-title">Nebula Linux 4.2 — Official Releases</span>
        </div>
      </div>

      <div class="rmg-navbar">
        <div class="rmg-nav-btns" aria-hidden="true">
          <span>←</span>
          <span>→</span>
          <span>↻</span>
        </div>
        <div class="rmg-omnibox">
          <span class="rmg-lock">{props.browser === "firefox" ? "🛡 🔒" : "🔒"}</span>
          <span class="rmg-url">https://releases.nebula-linux.org/4.2/downloads</span>
        </div>
        <div class={`rmg-ext-btn ${showPopover() ? "active" : ""}`}>
          <img src="/project-assets/icon/remagnet-small.svg" alt="Remagnet" />
          <span class="rmg-ext-badge">3</span>
        </div>
        <div class="rmg-nav-menu" aria-hidden="true">
          {props.browser === "firefox" ? "☰" : "⋮"}
        </div>
      </div>

      <div class="rmg-viewport">
        <header class="rmg-site-nav">
          <span class="rmg-site-brand">NEBULA LINUX</span>
          <span class="rmg-site-links">
            <span>Downloads</span>
            <span>Docs</span>
            <span>Mirrors</span>
            <span>SHA-256 Checksums</span>
          </span>
        </header>

        <section class="rmg-release-card">
          <div class="rmg-release-eyebrow">OFFICIAL OPEN-SOURCE RELEASE · LTS</div>
          <h2 class="rmg-release-title">Nebula Linux 4.2 Workstation</h2>
          <p class="rmg-release-sub">
            x86_64 Live Desktop Image · Kernel 6.14 · Wayland · 4.82 GiB
          </p>

          <div class="rmg-release-actions">
            <span class="rmg-btn-mirror">Direct Mirror (HTTPS)</span>
            <span class={`rmg-btn-magnet ${showContext() ? "active" : ""}`}>Magnet Link</span>
          </div>

          <div class="rmg-release-meta">
            <div>
              <span>Filename</span>
              <strong>Nebula-Linux-4.2-Workstation-x86_64.iso</strong>
            </div>
            <div>
              <span>SHA-256</span>
              <strong>9f2a8c41e0b7…4d18e3b09c2a</strong>
            </div>
            <div>
              <span>License</span>
              <strong>GPL-3.0 / Apache-2.0 Open Source</strong>
            </div>
            <div>
              <span>Mirrors</span>
              <strong>142 active HTTP &amp; BitTorrent seeds</strong>
            </div>
          </div>
        </section>

        <Show when={showContext()}>
          <div class="rmg-context-menu">
            <div class="rmg-ctx-item">Open link in new tab</div>
            <div class="rmg-ctx-item">Copy link address</div>
            <div class="rmg-ctx-sep" />
            <div class="rmg-ctx-item active">
              <img src="/project-assets/icon/remagnet-small.svg" alt="" />
              <span>Add to Remagnet</span>
            </div>
            <div class="rmg-ctx-sep" />
            <div class="rmg-ctx-item">Inspect</div>
            <svg class="rmg-cursor" viewBox="0 0 24 28" aria-hidden="true">
              <path
                d="M2 2v20l5.2-5.2L11.5 25l3.2-1.6-4.2-8.2H17z"
                fill="#ffffff"
                stroke="#111317"
                stroke-width="1.8"
              />
            </svg>
          </div>
        </Show>

        <Show when={showPopover()}>
          <div class="rmg-page-scrim" />
          <div class="rmg-popover-anchor">
            <div class="rmg-popover-caret" />
            <div class="rmg-popover-scale">
              <RealPopup animT={popupAnimT()} />
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}

export const SCREEN_TEMPLATES = [
  { id: "remagnet-android-qr", label: "Remagnet · Android QR Scanner" },
  { id: "remagnet-android-review", label: "Remagnet · Android Review Sheet" },
];

/** Deterministic 25×25 QR matrix (authentic finder + alignment + timing patterns). */
function buildQrModules(): Array<{ x: number; y: number }> {
  const n = 25;
  const grid: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));
  const reserved: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));

  const setFinder = (ox: number, oy: number) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx;
        const y = oy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        reserved[y][x] = true;
        const inOuter = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const onRing = dx === 0 || dx === 6 || dy === 0 || dy === 6;
        const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        grid[y][x] = inOuter && (onRing || inCore);
      }
    }
  };

  setFinder(0, 0);
  setFinder(n - 7, 0);
  setFinder(0, n - 7);

  // 5×5 alignment pattern at (18, 18)
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = 18 + dx;
      const y = 18 + dy;
      reserved[y][x] = true;
      const edge = Math.abs(dx) === 2 || Math.abs(dy) === 2;
      grid[y][x] = edge || (dx === 0 && dy === 0);
    }
  }

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    reserved[6][i] = true;
    reserved[i][6] = true;
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }

  // Deterministic pseudo-random data bits
  let seed = 0x51a7c3d9;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (reserved[y][x]) continue;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      grid[y][x] = seed >>> 24 > 122;
    }
  }

  const modules: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (grid[y][x]) modules.push({ x, y });
    }
  }
  return modules;
}

const QR_MODULES = buildQrModules();

function AndroidStatusBar() {
  return (
    <div class="rmg-android-statusbar" aria-hidden="true">
      <span class="rmg-sb-time">9:41</span>
      <span class="rmg-sb-icons">
        <span class="rmg-sb-signal">
          <i style="height:6px" />
          <i style="height:10px" />
          <i style="height:14px" />
          <i style="height:18px" />
        </span>
        <span class="rmg-sb-5g">5G</span>
        <span class="rmg-sb-battery">
          <i />
        </span>
      </span>
    </div>
  );
}

/** Mirrors Android `QrScannerScreen.kt` — CameraX scanner over a blurred proxy pairing screen. */
function AndroidQrScannerScreen() {
  return (
    <div class="rmg-android-qr">
      {/* Simulated live camera feed: dark desktop monitor showing the Proxy "Pair a device" panel */}
      <div class="rmg-qr-camera-bg" aria-hidden="true">
        <div class="rmg-qr-monitor">
          <div class="rmg-qr-monitor-bar">
            <img src="/project-assets/icon/remagnet-small.svg" alt="" />
            <span>Remagnet · Proxy</span>
            <span class="rmg-qr-monitor-tab">Devices</span>
          </div>
          <div class="rmg-qr-monitor-sub">PAIR A DEVICE · EXPIRES IN 0:48</div>
          <div class="rmg-qr-paper">
            <svg
              viewBox="-2 -2 29 29"
              class="rmg-qr-svg"
              shape-rendering="crispEdges"
              aria-hidden="true"
            >
              <rect x="-2" y="-2" width="29" height="29" fill="#f2f3f5" />
              {QR_MODULES.map((m) => (
                <rect x={m.x} y={m.y} width="1" height="1" fill="#111317" />
              ))}
            </svg>
          </div>
          <div class="rmg-qr-monitor-link">remagnet://pair?url=https://remagnet.example.com…</div>
        </div>
      </div>

      {/* 62% black scrim punched out around the sharp scan window (exact QrScannerScreen.kt layout) */}
      <div class="rmg-qr-scrim-top" />
      <div class="rmg-qr-scrim-mid">
        <div class="rmg-qr-scrim-side" />
        <div class="rmg-qr-window">
          <span class="rmg-qr-bracket tl" />
          <span class="rmg-qr-bracket tr" />
          <span class="rmg-qr-bracket bl" />
          <span class="rmg-qr-bracket br" />
        </div>
        <div class="rmg-qr-scrim-side" />
      </div>
      <div class="rmg-qr-scrim-bottom" />

      {/* Foreground HUD matching ScannerTopBar + ScannerControls */}
      <div class="rmg-qr-hud">
        <AndroidStatusBar />
        <header class="rmg-qr-topbar">
          <span class="rmg-android-btn secondary">Close</span>
          <span class="rmg-qr-title">Scan code</span>
          <span class="rmg-android-btn secondary">Flash on</span>
        </header>

        <div class="rmg-qr-window-spacer" />

        <div class="rmg-qr-controls">
          <div class="rmg-qr-lock-pill">
            <span class="rmg-qr-lock-dot" />
            <span>remagnet://pair · AES-256-GCM</span>
          </div>
          <p class="rmg-qr-hint">Point the camera at the QR code on your Remagnet Proxy page.</p>
          <span class="rmg-android-btn secondary">Paste code instead</span>
        </div>
      </div>
    </div>
  );
}

/** Mirrors Android `AddMagnetSheet.kt` — modal bottom sheet floating over the home torrent list. */
function AndroidReviewSheetScreen() {
  const bgTorrents: TorrentSummary[] = [
    {
      hash: "c300000000000000000000000000000000000003",
      name: "ubuntu-26.04-desktop-amd64.iso",
      state: "seeding",
      progress: 1,
      size: 6_120_400_000,
      downloadSpeed: 0,
      uploadSpeed: 1_468_006,
      eta: 0,
      ratio: 1.2,
      category: "remagnet",
      tags: ["remagnet"],
      seeds: 58,
      peers: 12,
    },
  ];

  return (
    <div class="rmg-android-review">
      <div class="rmg-review-backdrop">
        <AndroidStatusBar />
        <div class="rmg-review-bg-list">
          <div class="theme-popup rmg-popup-shell">
            <main class="popup">
              <PopupList
                torrents={bgTorrents}
                loading={false}
                configured
                serverLabel="https://remagnet.example.com"
                onRetry={noop}
                onOpenSettings={noop}
                onDismissActionError={noop}
                onAdd={noop}
                onZip={noop}
                onRemoveToggle={noop}
                onRemove={noop}
                onCancelRemove={noop}
              />
            </main>
          </div>
        </div>
        <div class="rmg-review-scrim" />
      </div>

      <section class="rmg-bottom-sheet" aria-label="Review torrent">
        <div class="rmg-sheet-handle" />

        <div class="rmg-sheet-head">
          <div class="rmg-sheet-title-col">
            <div class="rmg-sheet-kicker">REVIEW</div>
            <h2 class="rmg-sheet-title">Nebula-Linux-4.2-Workstation-x86_64.iso</h2>
          </div>
          <span class="rmg-android-btn secondary">Edit</span>
        </div>

        <dl class="rmg-sheet-meta">
          <div>
            <dt>Info hash</dt>
            <dd class="mono">9f2a8c41e0b71a62d83f59c41802ab714d18e3b0</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>4.82 GiB</dd>
          </div>
          <div>
            <dt>Trackers (2)</dt>
            <dd>tracker.nebula-linux.org, mirrors.kernel.example</dd>
          </div>
        </dl>

        <div class="rmg-sheet-notice">Not in torrent client yet.</div>

        <div class="rmg-sheet-check">
          <span class="rmg-checkbox" aria-hidden="true" />
          <div class="rmg-sheet-check-copy">
            <strong>Add paused</strong>
            <span>Starts stopped on your server. Start it there when you are ready.</span>
          </div>
        </div>

        <div class="rmg-sheet-actions">
          <span class="rmg-android-btn primary">Send to proxy</span>
          <span class="rmg-android-btn secondary">Cancel</span>
        </div>
      </section>
    </div>
  );
}

function ScreenApp(props: { opts: () => ScreenMountOptions }) {
  const templateId = () => props.opts().templateId;
  const animT = () => props.opts().animT;
  const isPortrait = () => props.opts().height > props.opts().width * 1.15;

  return (
    <div class="rmg-promo-root">
      <Switch fallback={<StandalonePopup animT={animT()} isPortrait={isPortrait()} />}>
        <Match when={templateId() === "remagnet-chrome-popup"}>
          <BrowserFrame browser="chrome" mode="popup" animT={animT()} />
        </Match>
        <Match when={templateId() === "remagnet-firefox-popup"}>
          <BrowserFrame browser="firefox" mode="popup" animT={animT()} />
        </Match>
        <Match when={templateId() === "remagnet-chrome-context"}>
          <BrowserFrame browser="chrome" mode="context" animT={animT()} />
        </Match>
        <Match when={templateId() === "remagnet-android-qr"}>
          <AndroidQrScannerScreen />
        </Match>
        <Match when={templateId() === "remagnet-android-review"}>
          <AndroidReviewSheetScreen />
        </Match>
        <Match when={templateId() === "remagnet-add"}>
          <div class="rmg-standalone theme-popup">
            <div class="rmg-standalone-card">
              <MagnetReview
                link={DEMO_MAGNET ?? undefined}
                paused={false}
                busy={false}
                onEdit={noop}
                onSubmit={(e) => e.preventDefault()}
                onPausedChange={noop}
              />
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

function StandalonePopup(props: { animT: number | null; isPortrait: boolean }) {
  return (
    <div class={`rmg-standalone ${props.isPortrait ? "portrait" : "landscape"}`}>
      <div class="rmg-standalone-scale">
        <RealPopup animT={props.animT} isPortrait={props.isPortrait} />
      </div>
    </div>
  );
}

/**
 * Promo Studio generic Screen Module contract.
 * Mounts reactive SolidJS components once into `containerEl` and updates signals in place.
 */
export function mountScreen(containerEl: HTMLElement, initialOpts: ScreenMountOptions) {
  containerEl.innerHTML = "";
  const [opts, setOpts] = createSignal<ScreenMountOptions>(initialOpts);
  const dispose = render(() => <ScreenApp opts={opts} />, containerEl);
  return {
    update(nextOpts: ScreenMountOptions) {
      setOpts(nextOpts);
    },
    unmount() {
      dispose();
      containerEl.innerHTML = "";
    },
  };
}
