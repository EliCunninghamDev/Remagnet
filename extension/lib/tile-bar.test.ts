import { describe, expect, test } from "bun:test";
import { BAR_DEFAULTS, barLayout, counterBitmap } from "./tile-bar";

describe("barLayout", () => {
  test("uses the popover width for the same deterministic grid every time", () => {
    const layout = barLayout(410, BAR_DEFAULTS);

    expect(layout.cols).toBe(43);
    expect(layout.count).toBe(129);
    expect(layout.offsetX).toBe(0);
    expect(layout.counterX).toBe(356);
    expect(layout.counterY).toBe(20);
    expect(Array.from(layout.order.slice(0, 5))).toEqual([86, 0, 43, 44, 88]);
  });

  test("thresholds stay in progress order", () => {
    const layout = barLayout(410, BAR_DEFAULTS);
    const ordered = Array.from(layout.order, (index) => layout.thresholds[index] ?? 0);

    for (const threshold of layout.thresholds) {
      expect(threshold).toBeGreaterThanOrEqual(0);
      expect(threshold).toBeLessThanOrEqual(1);
    }
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  });
});

describe("counterBitmap", () => {
  test("right-aligns digits into the three glyph slots", () => {
    const lit = (percent: number) => {
      const bitmap = counterBitmap(percent, 11, 3);
      return bitmap.reduce((total, value) => total + value, 0);
    };

    expect(lit(5)).toBe(11);
    expect(lit(42)).toBe(20);
    expect(lit(100)).toBe(32);
  });
});
