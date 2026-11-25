/**
 * Remagnet design tokens in Design Tokens Community Group (DTCG) format.
 *
 * This is a JavaScript module rather than a `.tokens.json` file so the same
 * values can be imported by scripts, tests and tooling. The exported object is
 * plain JSON-serializable data using the 2025.10 DTCG schema:
 * https://www.designtokens.org/tr/2025.10/format/
 *
 * The light and dark CSS variables in `packages/ui/src/styles/base.css` and the
 * popup overrides in `extension/assets/app.css` mirror these values. Keep them
 * in sync when changing the visual system.
 */

/** sRGB color token helper. `hex` must be a six-digit CSS hex color. */
function color(hex, alpha) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`Invalid six-digit hex color: ${hex}`);
  const components = match.slice(1).map((part) => {
    return Math.round((Number.parseInt(part, 16) / 255) * 1000) / 1000;
  });
  return {
    $value: {
      colorSpace: "srgb",
      components,
      ...(alpha === undefined ? {} : { alpha }),
      hex,
    },
  };
}

/** Pixel dimension token helper. */
function px(value) {
  return { $value: { value, unit: "px" } };
}

/** Millisecond duration token helper. */
function ms(value) {
  return { $value: { value, unit: "ms" } };
}

/** Shorthand for typed primitive tokens. */
function value($value) {
  return { $value };
}

export const tokens = {
  $schema: "https://www.designtokens.org/schemas/2025.10/format.json",

  color: {
    $type: "color",
    $description: "Neutral palette for the extension's light, dark and popup themes.",
    light: {
      $description: "Default light theme: warm gray surfaces with muted status colors.",
      bg: color("#f2f2ef"),
      panel: color("#fbfbf9"),
      line: color("#dededb"),
      border: color("#dededb"),
      text: color("#232527"),
      muted: color("#6e7377"),
      accent: color("#4f7595"),
      accentText: color("#ffffff"),
      done: color("#4e735d"),
      warn: color("#8a6b35"),
      track: color("#e4e4df"),
      tile0: color("#8c9094"),
      tile1: color("#969a9e"),
      tile2: color("#a0a4a8"),
      okBg: color("#e6efe9"),
      okText: color("#3d6b51"),
      errorBg: color("#f8e8e8"),
      errorText: color("#8d3838"),
      warnBg: color("#f5eddb"),
      warnText: color("#7d5f23"),
      surface: color("#7f7f7f", 0.06),
      hover: color("#7f7f7f", 0.14),
      sweep: color("#ffffff"),
    },
    dark: {
      $description: "Dark theme selected by prefers-color-scheme.",
      bg: color("#17181a"),
      panel: color("#1d1f21"),
      line: color("#2e3134"),
      border: color("#2e3134"),
      text: color("#d6d8da"),
      muted: color("#85898d"),
      accent: color("#70a3d2"),
      accentText: color("#10161b"),
      done: color("#84bc98"),
      warn: color("#cfa65e"),
      track: color("#202326"),
      tile0: color("#4a4e52"),
      tile1: color("#52565a"),
      tile2: color("#5a5e62"),
      okBg: color("#1c2620"),
      okText: color("#84bc98"),
      errorBg: color("#2c1d1d"),
      errorText: color("#d98c8c"),
      warnBg: color("#2b2418"),
      warnText: color("#cfa65e"),
      surface: color("#7f7f7f", 0.06),
      hover: color("#7f7f7f", 0.14),
      sweep: color("#e4e7e9"),
    },
    popup: {
      $description: "Always-dark scheme scoped to the toolbar popover.",
      bg: color("#141517"),
      panel: color("#181a1c"),
      line: color("#2a2d30"),
      border: color("#2a2d30"),
      text: color("#cfd1d3"),
      muted: color("#7d8286"),
      accent: color("#70a3d2"),
      accentText: color("#10161b"),
      done: color("#84bc98"),
      warn: color("#cfa65e"),
      track: color("#1d1f21"),
      tile0: color("#4a4e52"),
      tile1: color("#52565a"),
      tile2: color("#5a5e62"),
      okBg: color("#1b241f"),
      okText: color("#84bc98"),
      errorBg: color("#2a1c1c"),
      errorText: color("#d98c8c"),
      warnBg: color("#2a2418"),
      warnText: color("#cfa65e"),
      surface: color("#7f7f7f", 0.06),
      hover: color("#7f7f7f", 0.14),
      sweep: color("#e4e7e9"),
    },
  },

  typography: {
    $description: "Font stacks and type scale used by the extension.",
    family: {
      $type: "fontFamily",
      sans: value([
        "Inter",
        "ui-sans-serif",
        "system-ui",
        "-apple-system",
        "Segoe UI",
        "sans-serif",
      ]),
      mono: value(["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"]),
      geistMono: value([
        "Geist Mono",
        "ui-monospace",
        "SFMono-Regular",
        "Menlo",
        "Consolas",
        "monospace",
      ]),
      wordmark: value(["Departure Mono", "Geist Mono", "ui-monospace", "monospace"]),
    },
    weight: {
      $type: "fontWeight",
      regular: value(400),
      medium: value(500),
      semibold: value(600),
      bold: value(700),
    },
    size: {
      $type: "dimension",
      micro: px(8.5),
      badge: px(9),
      caption: px(10),
      small: px(11),
      label: px(12),
      torrentName: px(12.5),
      body: px(13),
      bodyLarge: px(14),
      title: px(16),
      section: px(17),
      titleLarge: px(18),
      heading: px(20),
      display: px(22),
      wordmark: px(22),
      wordmarkLarge: px(33),
    },
    lineHeight: {
      $type: "number",
      none: value(1),
      tight: value(1.2),
      snug: value(1.35),
      normal: value(1.5),
    },
    letterSpacing: {
      $type: "number",
      $description: "Unitless values are multiples of the current font size (em).",
      tight: value(-0.01),
      wordmark: value(0.01),
      wide: value(0.02),
      wider: value(0.06),
      widest: value(0.08),
    },
  },

  space: {
    $type: "dimension",
    $description: "Pixel spacing scale used for gaps and padding.",
    0: px(0),
    1: px(1),
    2: px(2),
    3: px(3),
    4: px(4),
    5: px(5),
    6: px(6),
    7: px(7),
    8: px(8),
    10: px(10),
    12: px(12),
    14: px(14),
    16: px(16),
    18: px(18),
    20: px(20),
    24: px(24),
    28: px(28),
    32: px(32),
    40: px(40),
    64: px(64),
  },

  radius: {
    $type: "dimension",
    $description: "Remagnet uses square corners throughout.",
    none: px(0),
  },

  border: {
    width: {
      $type: "dimension",
      hairline: px(1),
      focus: px(2),
    },
  },

  stroke: {
    icon: {
      $type: "dimension",
      width: px(1.6),
    },
  },

  motion: {
    $description: "Durations and easing for progress and hover feedback.",
    duration: {
      $type: "duration",
      fast: ms(120),
      progress: ms(460),
      stagger: ms(160),
    },
    easing: {
      $type: "cubicBezier",
      $description: "Ease-out cubic, matching the square-cell progress animation.",
      outCubic: value([0.33, 1, 0.68, 1]),
    },
  },

  layout: {
    $type: "dimension",
    $description: "Fixed dimensions for the popup, options page and controls.",
    popup: {
      width: px(440),
      maxHeight: px(590),
      padding: px(14),
      gap: px(12),
    },
    torrentList: {
      maxHeight: px(400),
    },
    options: {
      maxWidth: px(680),
    },
    add: {
      maxWidth: px(600),
    },
    icon: {
      button: px(26),
      row: px(18),
      small: px(13),
      medium: px(14),
    },
    progress: {
      height: px(4),
    },
  },
};

export default tokens;
