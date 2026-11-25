/**
 * Generate `docs/remagnet-banner.svg` from the application's own design.
 *
 * The banner is a static, pixel-accurate rendering of the popover: the same
 * popup tokens, the same Geist Mono / Departure Mono faces, the same 440px
 * layout and the same `barLayout` / `counterBitmap` geometry the canvas bar
 * uses at runtime. Text is measurable because both families are monospace, so
 * layout is computed instead of hand-placed.
 *
 * Regenerate with `bun run banner:generate` after changing the visual system.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatBytes, formatEta, splitTorrentName } from "../extension/lib/format";
import { BAR_DEFAULTS, barLayout, counterBitmap } from "../extension/lib/tile-bar";
import { type ColorValue, type DimensionValue, type TokenGroup, tokens } from "../tokens.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type Family = "Geist Mono" | "Departure Mono";

/** Advance width in em for each bundled monospace face. */
const ADVANCE: Record<Family, number> = {
  "Geist Mono": 0.6,
  "Departure Mono": 7 / 11,
};

const FONT_STACK: Record<Family, string> = {
  "Geist Mono": "'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
  "Departure Mono": "'Departure Mono', 'Geist Mono', ui-monospace, monospace",
};

const FONT_FILES = [
  { family: "Geist Mono", weight: 400, file: "geist-mono-latin-400-normal.woff2" },
  { family: "Geist Mono", weight: 500, file: "geist-mono-latin-500-normal.woff2" },
  { family: "Geist Mono", weight: 600, file: "geist-mono-latin-600-normal.woff2" },
  { family: "Departure Mono", weight: 400, file: "departure-mono-regular.woff2" },
] as const;

function color(group: TokenGroup<ColorValue>, name: string): string {
  const entry = group[name];
  if (!entry || typeof entry !== "object" || !("$value" in entry)) {
    throw new Error(`Missing color token: ${name}`);
  }
  const { hex, alpha } = entry.$value;
  if (alpha === undefined) return hex;
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
}

/** Read a pixel dimension from a token group such as `layout.popup`. */
function dimension(group: unknown, name: string): number {
  const entry =
    group && typeof group === "object" ? (group as Record<string, unknown>)[name] : undefined;
  if (!entry || typeof entry !== "object" || !("$value" in entry)) {
    throw new Error(`Missing dimension token: layout.popup.${name}`);
  }
  const { value, unit } = entry.$value as DimensionValue;
  if (unit !== "px") throw new Error(`Dimension token layout.popup.${name} must use px`);
  return value;
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** Match the canvas `rgbCss(color, factor)` rounding exactly. */
function shade(hex: string, factor: number): string {
  const [red, green, blue] = rgb(hex);
  return `rgb(${Math.round(red * factor)},${Math.round(green * factor)},${Math.round(blue * factor)})`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const n = (value: number): number => Math.round(value * 100) / 100;

function measure(value: string, size: number, family: Family, letterSpacing = 0): number {
  const characters = [...value].length;
  return characters * size * ADVANCE[family] + characters * letterSpacing;
}

interface TextOptions {
  size: number;
  fill: string;
  family?: Family;
  weight?: number;
  letterSpacing?: number;
  anchor?: "start" | "middle" | "end";
  opacity?: number;
}

function text(value: string, x: number, y: number, options: TextOptions): string {
  const family = options.family ?? "Geist Mono";
  const attributes = [
    `x="${n(x)}"`,
    `y="${n(y)}"`,
    `font-family="${FONT_STACK[family]}"`,
    `font-size="${n(options.size)}"`,
    `font-weight="${options.weight ?? 400}"`,
    options.letterSpacing ? `letter-spacing="${n(options.letterSpacing)}"` : "",
    options.anchor ? `text-anchor="${options.anchor}"` : "",
    options.opacity === undefined ? "" : `opacity="${options.opacity}"`,
    `xml:space="preserve"`,
    `fill="${options.fill}"`,
  ]
    .filter(Boolean)
    .join(" ");
  return `<text ${attributes}>${xml(value)}</text>`;
}

const popup = tokens.color.popup;
const dark = tokens.color.dark;
const palette = {
  page: color(dark, "bg"),
  panel: color(popup, "bg"),
  line: color(popup, "line"),
  text: color(popup, "text"),
  muted: color(popup, "muted"),
  accent: color(popup, "accent"),
  accentText: color(popup, "accentText"),
  done: color(popup, "done"),
  warn: color(popup, "warn"),
  track: color(popup, "track"),
};

/** The popover's measured CSS box, in CSS pixels. */
const POPUP = {
  width: dimension(tokens.layout.popup, "width"),
  height: 340,
  x: 676,
  y: 20,
  border: 1,
  padding: dimension(tokens.layout.popup, "padding"),
  header: 26,
  gap: dimension(tokens.layout.popup, "gap"),
  nameSize: 12.5,
  nameLineHeight: 1.35,
  statsSize: 10,
  actionSize: 9,
  footer: 18,
  rowPaddingTop: 10,
  rowPaddingBottom: 11,
  rowGap: 6,
};

const CONTENT_X = POPUP.x + POPUP.border + POPUP.padding;
const CONTENT_Y = POPUP.y + POPUP.border + POPUP.padding;
const CONTENT_WIDTH = POPUP.width - POPUP.border * 2 - POPUP.padding * 2;
const CONTENT_RIGHT = CONTENT_X + CONTENT_WIDTH;

const NAME_HEIGHT = POPUP.nameSize * POPUP.nameLineHeight;
const ROW_HEIGHT =
  POPUP.rowPaddingTop +
  NAME_HEIGHT +
  POPUP.rowGap +
  22 +
  POPUP.rowGap +
  POPUP.footer +
  POPUP.rowPaddingBottom;

type Phase = "fetch" | "zip" | "done";

interface Row {
  name: string;
  progress: number;
  size: number;
  downloadSpeed: number;
  uploadSpeed: number;
  eta: number;
  peers: number;
  seeds: number;
  phase: Phase;
  action: "idle" | "state" | "download";
  label?: string;
}

/**
 * Three rows, one per bar phase. The first name is long enough to exercise the
 * popup's middle truncation; the last is complete so the Download and remove
 * actions are shown together.
 */
const ROWS: Row[] = [
  {
    name: "Some.Distributor.Linux.2026.11.Desktop.2160p.HDR.x86_64.GNOME.Wayland.MultiLanguage.Including.Live.Session.REPACK-GROUP.iso",
    progress: 0.42,
    size: 6_512_230_400,
    downloadSpeed: 8_912_896,
    uploadSpeed: 0,
    eta: 743,
    peers: 7,
    seeds: 42,
    phase: "fetch",
    action: "idle",
  },
  {
    name: "Fedora-Workstation-Live-44-x86_64.iso",
    progress: 0.18,
    size: 6_512_230_400,
    downloadSpeed: 0,
    uploadSpeed: 0,
    eta: 8_640_000,
    peers: 0,
    seeds: 3,
    phase: "zip",
    action: "state",
    label: "Stalled",
  },
  {
    name: "ubuntu-26.04-desktop-amd64.iso",
    progress: 1,
    size: 6_512_230_400,
    downloadSpeed: 0,
    uploadSpeed: 1_468_006,
    eta: 0,
    peers: 12,
    seeds: 58,
    phase: "done",
    action: "download",
  },
];

function embeddedFonts(): string {
  return FONT_FILES.map(({ family, weight, file }) => {
    const base64 = readFileSync(`${ROOT}/extension/public/fonts/${file}`).toString("base64");
    return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${base64}) format("woff2");}`;
  }).join("\n");
}

function icon(x: number, y: number, size: number): string {
  const source = readFileSync(`${ROOT}/extension/public/icon/remagnet.svg`, "utf8");
  const inner = source.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const scale = size / 128;
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(scale)})">${inner}</g>`;
}

/** Reproduce `splitTorrentName` plus CSS `text-overflow` on the head. */
function torrentName(name: string, x: number, y: number, maxWidth: number): string {
  const { head, tail } = splitTorrentName(name);
  // The head span only ellipsizes when the whole name cannot fit; short names
  // that happen to exceed the split heuristic still render in full.
  if (!tail || measure(name, POPUP.nameSize, "Geist Mono") <= maxWidth) {
    return text(name, x, y, { size: POPUP.nameSize, fill: palette.text, weight: 500 });
  }

  const advance = POPUP.nameSize * ADVANCE["Geist Mono"];
  const tailWidth = measure(tail, POPUP.nameSize, "Geist Mono");
  const headCharacters = Math.max(0, Math.floor((maxWidth - tailWidth - advance) / advance));
  const clipped = [...head].slice(0, headCharacters).join("");
  const ellipsis = `${clipped}…`;
  return [
    text(ellipsis, x, y, { size: POPUP.nameSize, fill: palette.text, weight: 500 }),
    text(tail, x + measure(ellipsis, POPUP.nameSize, "Geist Mono"), y, {
      size: POPUP.nameSize,
      fill: palette.text,
      weight: 500,
    }),
  ].join("");
}

function bar(x: number, y: number, progress: number, phase: Phase): string {
  const layout = barLayout(CONTENT_WIDTH, BAR_DEFAULTS);
  const phaseColor =
    phase === "fetch" ? palette.accent : phase === "zip" ? palette.warn : palette.done;
  const paths = new Map<string, string[]>();
  const paint = (fill: string, cellX: number, cellY: number, size: number) => {
    const path = paths.get(fill) ?? [];
    path.push(`M${n(cellX)} ${n(cellY)}h${size}v${size}h-${size}z`);
    paths.set(fill, path);
  };

  for (let index = 0; index < layout.count; index++) {
    paint(
      palette.track,
      x + layout.offsetX + (index % layout.cols) * layout.step,
      y + Math.floor(index / layout.cols) * layout.step,
      BAR_DEFAULTS.cell,
    );
  }

  let pointer = 0;
  while (
    pointer < layout.count &&
    (layout.thresholds[layout.order[pointer] ?? 0] ?? 1) <= progress
  ) {
    const index = layout.order[pointer] ?? 0;
    pointer++;
    const factor = [0.82, 0.91, 1][layout.shadeIndex[index] ?? 0] ?? 1;
    paint(
      shade(phaseColor, factor),
      x + layout.offsetX + (index % layout.cols) * layout.step,
      y + Math.floor(index / layout.cols) * layout.step,
      BAR_DEFAULTS.cell,
    );
  }

  const counterX = x + layout.counterX;
  const counterY = y + (layout.counterY - layout.pad);
  const digits = counterBitmap(
    Math.floor(progress * 100 + 1e-6),
    layout.counterCols,
    BAR_DEFAULTS.cSlots,
  );
  for (let index = 0; index < layout.counterCols * 5; index++) {
    paint(
      digits[index] ? phaseColor : palette.track,
      counterX + (index % layout.counterCols) * layout.counterStep,
      counterY + Math.floor(index / layout.counterCols) * layout.counterStep,
      BAR_DEFAULTS.cTile,
    );
  }

  return `<g shape-rendering="crispEdges">${[...paths]
    .map(([fill, segments]) => `<path fill="${fill}" d="${segments.join("")}"/>`)
    .join("")}</g>`;
}

interface Part {
  value: string;
  bold?: boolean;
}

function stats(x: number, baseline: number, parts: Part[]): string {
  let cursor = x;
  const output: string[] = [];
  for (const part of parts) {
    output.push(
      text(part.value, cursor, baseline, {
        size: POPUP.statsSize,
        fill: part.bold ? palette.text : palette.muted,
        weight: part.bold ? 500 : 400,
      }),
    );
    cursor += measure(part.value, POPUP.statsSize, "Geist Mono");
  }
  return output.join("");
}

/** Render a run of stats segments with the popup's 10px gap between them. */
function statsRow(x: number, baseline: number, row: Row): string {
  const segments: Part[][] = [];
  const download = [{ value: formatBytes(row.downloadSpeed), bold: true }, { value: "/s" }];
  segments.push(download);

  const eta = formatEta(row.eta);
  if (eta !== "—") {
    segments.push([{ value: "ETA " }, { value: eta, bold: true }]);
  }
  if (row.uploadSpeed > 0) {
    segments.push([
      { value: "↑ " },
      { value: formatBytes(row.uploadSpeed), bold: true },
      { value: "/s" },
    ]);
  }
  segments.push([
    { value: formatBytes(row.progress * row.size), bold: true },
    { value: ` / ${formatBytes(row.size)}` },
  ]);
  segments.push([{ value: `${row.peers}/${row.seeds}`, bold: true }, { value: " peers" }]);

  let cursor = x;
  const output: string[] = [];
  for (const segment of segments) {
    output.push(stats(cursor, baseline, segment));
    const width = segment.reduce(
      (total, part) => total + measure(part.value, POPUP.statsSize, "Geist Mono"),
      0,
    );
    cursor += width + 10;
  }
  return output.join("");
}

function rowActions(baseline: number, row: Row): string {
  const output: string[] = [];
  const removeWidth = 18;
  const removeX = CONTENT_RIGHT - removeWidth;
  const letterSpacing = POPUP.actionSize * 0.05;

  output.push(
    text("×", removeX + removeWidth / 2, baseline + 1.5, {
      size: 14,
      fill: palette.muted,
      anchor: "middle",
      opacity: 0.5,
    }),
  );

  const right = removeX - 2;
  if (row.action === "download") {
    const label = "Download";
    const width = measure(label, POPUP.actionSize, "Geist Mono", letterSpacing) + 10;
    output.push(
      text(label, right - width + 5, baseline, {
        size: POPUP.actionSize,
        fill: palette.muted,
        weight: 600,
        letterSpacing,
      }),
    );
  } else if (row.action === "state" && row.label) {
    const width = measure(row.label, POPUP.actionSize, "Geist Mono", letterSpacing);
    output.push(
      text(row.label, right - width, baseline, {
        size: POPUP.actionSize,
        fill: palette.muted,
        weight: 600,
        letterSpacing,
      }),
    );
  }

  return output.join("");
}

function header(): string {
  const centerY = CONTENT_Y + POPUP.header / 2;
  const wordmark = "Remagnet";
  const wordmarkWidth = measure(wordmark, 22, "Departure Mono", 0.22);
  const badgeWidth = 6 + measure("3", 9, "Geist Mono") + 6;
  const parts = [
    text(wordmark, CONTENT_X, centerY + 8, {
      size: 22,
      family: "Departure Mono",
      fill: palette.text,
      letterSpacing: 0.22,
    }),
    `<rect x="${n(CONTENT_X + wordmarkWidth + 7)}" y="${n(centerY - 7.5)}" width="${n(badgeWidth)}" height="15" fill="${palette.track}"/>`,
    text("3", CONTENT_X + wordmarkWidth + 7 + badgeWidth / 2, centerY + 4, {
      size: 9,
      fill: palette.muted,
      anchor: "middle",
    }),
  ];

  const settingsSize = 26;
  const settingsX = CONTENT_RIGHT - settingsSize;
  parts.push(
    `<g transform="translate(${n(settingsX + 6.5)} ${n(centerY - 6.5)}) scale(${n(13 / 16)})" fill="none" stroke="${palette.muted}" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4.5h11M2.5 11.5h11"/><circle cx="6" cy="4.5" r="1.6"/><circle cx="10.5" cy="11.5" r="1.6"/></g>`,
  );

  const addLabel = "Add";
  const addWidth = measure(addLabel, 11, "Geist Mono") + 13 + 5 + 20;
  const addX = settingsX - 6 - addWidth;
  parts.push(
    `<rect x="${n(addX)}" y="${n(CONTENT_Y)}" width="${n(addWidth)}" height="26" fill="${palette.accent}"/>`,
    `<g transform="translate(${n(addX + 10)} ${n(centerY - 6.5)}) scale(${n(13 / 16)})" fill="none" stroke="${palette.accentText}" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></g>`,
    text(addLabel, addX + 10 + 13 + 5, centerY + 4, {
      size: 11,
      fill: palette.accentText,
      weight: 600,
    }),
  );

  return parts.join("");
}

function popover(): string {
  const parts = [
    `<rect x="${POPUP.x}" y="${POPUP.y}" width="${POPUP.width}" height="${POPUP.height}" fill="${palette.panel}" stroke="${palette.line}" filter="url(#panelShadow)"/>`,
    header(),
  ];

  const listTop = CONTENT_Y + POPUP.header + POPUP.gap;
  let y = listTop;

  ROWS.forEach((row, index) => {
    if (index > 0) {
      parts.push(
        `<rect x="${CONTENT_X}" y="${n(y)}" width="${CONTENT_WIDTH}" height="1" fill="${palette.line}"/>`,
      );
      y += 1;
    }

    const nameY = y + POPUP.rowPaddingTop;
    const barY = nameY + NAME_HEIGHT + POPUP.rowGap;
    const footerY = barY + 22 + POPUP.rowGap;

    parts.push(
      torrentName(row.name, CONTENT_X, nameY + 13, CONTENT_WIDTH),
      bar(CONTENT_X, barY, row.progress, row.phase),
      statsRow(CONTENT_X, footerY + 13, row),
      rowActions(footerY + 12.5, row),
    );

    y += ROW_HEIGHT;
  });

  return parts.join("");
}

function platforms(x: number, baseline: number): string {
  const size = 13;
  const letterSpacing = 0.6;
  const gap = 11;
  const labels = ["Android", "Firefox", "Chrome"];
  const output: string[] = [];
  let cursor = x;

  labels.forEach((label, index) => {
    if (index > 0) {
      output.push(
        text("•", cursor, baseline, {
          size,
          fill: palette.accent,
          letterSpacing,
        }),
      );
      cursor += measure("•", size, "Geist Mono", letterSpacing) + gap;
    }
    output.push(
      text(label, cursor, baseline, {
        size,
        fill: palette.muted,
        weight: 500,
        letterSpacing,
      }),
    );
    cursor += measure(label, size, "Geist Mono", letterSpacing) + gap;
  });

  return output.join("");
}

function banner(): string {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 380" width="1200" height="380" role="img" aria-labelledby="title desc">`,
    '<title id="title">Remagnet</title>',
    '<desc id="desc">The Remagnet popover beside the application mark, showing a downloading torrent, a stalled torrent and a completed torrent with its Download action.</desc>',
    "<defs>",
    `<style>\n${embeddedFonts()}\n</style>`,
    `<filter id="panelShadow" x="-30%" y="-20%" width="160%" height="170%"><feDropShadow dx="0" dy="14" stdDeviation="20" flood-color="#000000" flood-opacity="0.5"/></filter>`,
    "</defs>",
    `<rect width="1200" height="380" fill="${palette.page}"/>`,
    icon(64, 90, 120),
    text("Remagnet", 206, 193, {
      size: 56,
      family: "Departure Mono",
      fill: palette.text,
      letterSpacing: 0.56,
    }),
    text("Convenient Torrent Forwarding and Download Proxy", 64, 268, {
      size: 18,
      fill: palette.muted,
    }),
    platforms(64, 300),
    popover(),
    "</svg>",
  ];
  return parts.join("\n");
}

const output = `${ROOT}/docs/remagnet-banner.svg`;
writeFileSync(output, `${banner()}\n`);
console.log(`Wrote ${output}`);
