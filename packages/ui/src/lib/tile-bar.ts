/**
 * Geometry and deterministic cell assignments for the square-cell progress bar.
 *
 * The canvas component and the README banner generator both use this module so
 * a rendered banner shows the same bar the popover draws, not a lookalike.
 */

export interface BarOptions {
  cell: number;
  gap: number;
  rows: number;
  jitter: number;
  dur: number;
  delay: number;
  counter: boolean;
  cTile: number;
  cGap: number;
  cSlots: number;
  cMargin: number;
}

export const BAR_DEFAULTS: BarOptions = {
  cell: 6,
  gap: 2,
  rows: 3,
  jitter: 7,
  dur: 460,
  delay: 160,
  counter: true,
  // Sized for "100": three glyph slots, each 3 tiles wide plus a gap.
  cTile: 4,
  cGap: 1,
  cSlots: 3,
  cMargin: 14,
};

/** 3x5 tile font for the inline percentage counter. */
export const TILE_FONT: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

export const SHADE_FACTORS = [0.82, 0.91, 1] as const;

/** Small deterministic PRNG so resizing does not reshuffle the cells. */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface BarLayout {
  width: number;
  /** Total grid height: `rows * step - gap`. */
  height: number;
  /** Room above and below for cell pops. */
  pad: number;
  step: number;
  cols: number;
  count: number;
  offsetX: number;
  /** Width reserved for the counter and its margin. */
  reserve: number;
  counterStep: number;
  counterCols: number;
  counterHeight: number;
  counterX: number;
  counterY: number;
  thresholds: Float32Array<ArrayBuffer>;
  shadeIndex: Uint8Array<ArrayBuffer>;
  delays: Float32Array<ArrayBuffer>;
  order: Uint32Array<ArrayBuffer>;
}

/**
 * Lay out the bar for a host width.
 *
 * Thresholds give every column a position between 0 and 1 (with a little
 * seeded jitter so the leading edge is ragged); sorting them produces the
 * order cells settle in. The same seed is used on every resize.
 */
export function barLayout(width: number, options: BarOptions = BAR_DEFAULTS): BarLayout {
  const { cell, gap, rows, jitter, delay, counter, cTile, cGap, cSlots, cMargin } = options;
  const step = cell + gap;
  const height = rows * step - gap;
  const pad = Math.ceil(cell * 3.5);
  const counterStep = cTile + cGap;
  const counterCols = counter ? cSlots * 4 - 1 : 0;
  const counterHeight = 5 * counterStep - cGap;
  const reserve = counter ? counterCols * counterStep - cGap + cMargin : 0;
  const cols = Math.max(1, Math.floor((width - reserve + gap) / step));
  const count = cols * rows;
  const offsetX = Math.max(0, Math.floor((width - (cols * step - gap + reserve)) / 2));
  const counterX = offsetX + cols * step - gap + cMargin;
  const counterY = pad + Math.round((height - counterHeight) / 2);

  const random = seededRandom(1337);
  const thresholds = new Float32Array(count);
  const shadeIndex = new Uint8Array(count);
  const delays = new Float32Array(count);

  const span = cols - 1 + jitter;
  for (let index = 0; index < count; index++) {
    const col = index % cols;
    thresholds[index] = (col + random() * jitter) / span;
    shadeIndex[index] = Math.floor(random() * SHADE_FACTORS.length);
    delays[index] = random() * delay;
  }

  const order = Uint32Array.from({ length: count }, (_, index) => index).sort(
    (a, b) => (thresholds[a] ?? 0) - (thresholds[b] ?? 0),
  );

  return {
    width,
    height,
    pad,
    step,
    cols,
    count,
    offsetX,
    reserve,
    counterStep,
    counterCols,
    counterHeight,
    counterX,
    counterY,
    thresholds,
    shadeIndex,
    delays,
    order,
  };
}

/** Right-align "5" / "42" / "100" into the reserved glyph slots. */
export function counterBitmap(percent: number, columns: number, slots: number): Uint8Array {
  const bitmap = new Uint8Array(columns * 5);
  const text = String(percent).padStart(slots, " ").slice(-slots);
  for (let slot = 0; slot < slots; slot++) {
    const glyph = TILE_FONT[text[slot] ?? ""];
    if (!glyph) continue;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row]?.[col] === "1") bitmap[row * columns + slot * 4 + col] = 1;
      }
    }
  }
  return bitmap;
}
