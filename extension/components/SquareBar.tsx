import { createEffect, onCleanup, onMount } from "solid-js";
import {
  BAR_DEFAULTS,
  type BarOptions,
  barLayout,
  counterBitmap,
  SHADE_FACTORS,
} from "../lib/tile-bar";

export type BarPhase = "idle" | "fetch" | "zip" | "done";

type Rgb = readonly [number, number, number];

const FALLBACK: Record<BarPhase, string> = {
  idle: "#4a4e52",
  fetch: "#70a3d2",
  zip: "#cfa65e",
  done: "#84bc98",
};

const TILE_VARS = ["--tile-0", "--tile-1", "--tile-2"] as const;
const IDLE_FALLBACK = ["#4a4e52", "#52565a", "#5a5e62"] as const;

function parseColor(value: string): Rgb | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex?.[1]) {
    const parts = hex[1];
    return [
      Number.parseInt(parts.slice(0, 2), 16),
      Number.parseInt(parts.slice(2, 4), 16),
      Number.parseInt(parts.slice(4, 6), 16),
    ];
  }

  const rgb = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(value);
  if (rgb) {
    return [Math.round(Number(rgb[1])), Math.round(Number(rgb[2])), Math.round(Number(rgb[3]))];
  }

  return null;
}

function rgbCss([r, g, b]: Rgb, factor = 1): string {
  return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
}

/** Lift a phase color toward the panel's light gray for the pop-in highlight. */
function lighten(color: Rgb): Rgb {
  const target: Rgb = [230, 232, 234];
  return [
    color[0] + (target[0] - color[0]) * 0.55,
    color[1] + (target[1] - color[1]) * 0.55,
    color[2] + (target[2] - color[2]) * 0.55,
  ];
}

/** Resolve a themed CSS custom property from the bar's own element. */
function cssColor(host: HTMLElement, name: string, fallback: string): Rgb {
  const raw = getComputedStyle(host).getPropertyValue(name).trim();
  return parseColor(raw) ?? parseColor(fallback) ?? [128, 128, 128];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeOutBack = (t: number) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

/**
 * Canvas grid progress bar.
 *
 * Two canvases: `base` holds the track and settled cells (drawn incrementally
 * and never cleared) while `fx` only draws the few cells that are mid-pop plus
 * the zip/done sweep. The animation loop runs only while something moves, so an
 * idle popover costs no frames.
 */
class SquareBarCanvas {
  private readonly o: BarOptions;
  private readonly host: HTMLElement;
  private readonly step: number;
  private readonly height: number;
  private readonly pad: number;
  private readonly reduce: boolean;
  private readonly base: HTMLCanvasElement;
  private readonly fx: HTMLCanvasElement;
  private readonly observer: ResizeObserver;
  private readonly colors: Record<BarPhase, Rgb>;
  private readonly shades: Record<BarPhase, string[]>;
  private readonly hot: Record<BarPhase, Rgb>;
  private readonly track: string;
  private readonly sweepColor: string;
  private readonly counterText: Rgb;

  private bctx: CanvasRenderingContext2D | null = null;
  private fctx: CanvasRenderingContext2D | null = null;
  private width = 0;
  private canvasHeight = 0;
  private cols = 1;
  private count = 0;
  private offsetX = 0;

  private thresholds = new Float32Array(0);
  private shadeIndex = new Uint8Array(0);
  private delays = new Float32Array(0);
  private starts = new Float64Array(0);
  private states = new Uint8Array(0);
  private order = new Uint32Array(0);

  private displayed = 0;
  private target = 0;
  private pointer = 0;
  private animating: number[] = [];

  private counterCols = 0;
  private counterStep = 5;
  private counterX = 0;
  private counterY = 0;
  private counterTarget = new Uint8Array(0);
  private counterStates = new Uint8Array(0);
  private counterActive = new Uint8Array(0);
  private counterStarts = new Float64Array(0);
  private counterAnimating: number[] = [];
  private counterPercent = 0;

  private sweep: { pos: number; speed: number; width: number; loop: boolean } | null = null;
  private phase: BarPhase | null = null;
  private frame = 0;
  private lastFrame = 0;
  private lastPercent = -1;

  constructor(host: HTMLElement, options: Partial<BarOptions> = {}) {
    this.o = { ...BAR_DEFAULTS, ...options };
    this.host = host;
    this.step = this.o.cell + this.o.gap;
    this.height = this.o.rows * this.step - this.o.gap;
    this.pad = Math.ceil(this.o.cell * 3.5);
    this.reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const idle = TILE_VARS.map((name, index) => {
      return cssColor(host, name, IDLE_FALLBACK[index] ?? IDLE_FALLBACK[0]);
    });
    this.colors = {
      idle: idle[0] ?? [74, 78, 82],
      fetch: cssColor(host, "--accent", FALLBACK.fetch),
      zip: cssColor(host, "--warn", FALLBACK.zip),
      done: cssColor(host, "--done", FALLBACK.done),
    };
    this.shades = {
      idle: idle.map((color) => rgbCss(color)),
      fetch: SHADE_FACTORS.map((factor) => rgbCss(this.colors.fetch, factor)),
      zip: SHADE_FACTORS.map((factor) => rgbCss(this.colors.zip, factor)),
      done: SHADE_FACTORS.map((factor) => rgbCss(this.colors.done, factor)),
    };
    this.hot = {
      idle: lighten(idle[2] ?? this.colors.idle),
      fetch: lighten(this.colors.fetch),
      zip: lighten(this.colors.zip),
      done: lighten(this.colors.done),
    };
    this.track = rgbCss(cssColor(host, "--track", "#1d1f21"));
    this.sweepColor = rgbCss(cssColor(host, "--sweep", "#e4e7e9"));
    this.counterText = cssColor(host, "--text", "#cfd1d3");

    host.style.position = "relative";
    host.style.height = `${this.height}px`;
    host.setAttribute("role", "progressbar");
    host.setAttribute("aria-valuemin", "0");
    host.setAttribute("aria-valuemax", "100");
    host.setAttribute("aria-valuenow", "0");

    const createCanvas = () => {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = `position:absolute;left:0;top:${-this.pad}px;width:100%;height:${this.height + this.pad * 2}px;pointer-events:none`;
      host.appendChild(canvas);
      return canvas;
    };

    this.base = createCanvas();
    this.fx = createCanvas();
    this.observer = new ResizeObserver(() => {
      this.layout();
      this.rebuild(this.displayed);
    });
    this.observer.observe(host);
    this.layout();
    this.rebuild(0);
  }

  setProgress(progress: number): void {
    const value = clamp(progress, 0, 1);
    // Floor the readout so 100% never appears before the torrent is complete.
    const percent = Math.floor(value * 100 + 1e-6);
    if (value < this.displayed - 1e-3) {
      this.displayed = value;
      this.counterPercent = percent;
      this.rebuild(value);
    } else {
      this.setCounter(percent, performance.now());
    }
    this.target = value;
    if (percent !== this.lastPercent) {
      this.lastPercent = percent;
      this.host.setAttribute("aria-valuenow", String(percent));
      this.host.setAttribute("aria-valuetext", `${percent}%`);
    }
    this.wake();
  }

  /**
   * Start from an already-downloaded position without animating the fill.
   * Opening the popover should show the torrent where it is, not replay it.
   */
  jumpTo(progress: number): void {
    const value = clamp(progress, 0, 1);
    this.displayed = value;
    this.target = value;
    this.counterPercent = Math.floor(value * 100 + 1e-6);
    this.lastPercent = this.counterPercent;
    this.host.setAttribute("aria-valuenow", String(this.lastPercent));
    this.host.setAttribute("aria-valuetext", `${this.lastPercent}%`);
    this.rebuild(value);
  }

  setPhase(phase: BarPhase, animate = true): void {
    // Polling re-renders the cards, but a phase only changes on a real state
    // transition. Ignore repeats so the zip/ready sweep plays once.
    if (phase === this.phase) return;
    this.phase = phase;
    this.host.dataset.phase = phase;
    // Settled tiles are phase-colored, so repaint them before starting the
    // sweep. This also clears any in-flight pop animations from the old phase.
    this.rebuild(this.displayed);
    if (this.reduce) {
      this.sweep = null;
      return;
    }
    if (phase === "zip") this.sweep = { pos: -16, speed: 38, width: 14, loop: true };
    else if (phase === "done" && animate) {
      this.sweep = { pos: -20, speed: 110, width: 20, loop: false };
    } else this.sweep = null;
    this.wake();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.base.remove();
    this.fx.remove();
  }

  private layout(): void {
    const width = this.host.clientWidth;
    if (!width) return;

    const layout = barLayout(width, this.o);
    const canvasHeight = this.height + this.pad * 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    for (const canvas of [this.base, this.fx]) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(canvasHeight * dpr);
    }

    const bctx = this.base.getContext("2d");
    const fctx = this.fx.getContext("2d");
    if (!bctx || !fctx) return;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.bctx = bctx;
    this.fctx = fctx;

    this.width = width;
    this.canvasHeight = canvasHeight;
    this.cols = layout.cols;
    this.count = layout.count;
    this.offsetX = layout.offsetX;
    this.counterStep = layout.counterStep;
    this.counterCols = layout.counterCols;
    this.counterX = layout.counterX;
    this.counterY = layout.counterY;

    const counterCount = this.counterCols * 5;
    this.counterTarget = new Uint8Array(counterCount);
    this.counterStates = new Uint8Array(counterCount);
    this.counterActive = new Uint8Array(counterCount);
    this.counterStarts = new Float64Array(counterCount);
    this.counterAnimating.length = 0;

    const count = this.count;
    this.thresholds = layout.thresholds;
    this.shadeIndex = layout.shadeIndex;
    this.delays = layout.delays;
    this.order = layout.order;
    this.starts = new Float64Array(count);
    this.states = new Uint8Array(count);
  }

  private coordinates(index: number): [number, number] {
    return [
      this.offsetX + (index % this.cols) * this.step,
      this.pad + Math.floor(index / this.cols) * this.step,
    ];
  }

  private drawTrack(index: number): void {
    if (!this.bctx) return;
    const [x, y] = this.coordinates(index);
    this.bctx.fillStyle = this.track;
    this.bctx.fillRect(x, y, this.o.cell, this.o.cell);
  }

  private drawSettled(index: number): void {
    if (!this.bctx) return;
    const [x, y] = this.coordinates(index);
    const shades = this.shades[this.phase ?? "fetch"];
    this.bctx.fillStyle = shades[this.shadeIndex[index] ?? 0] ?? shades[0] ?? "#4a4e52";
    this.bctx.fillRect(x, y, this.o.cell, this.o.cell);
    this.states[index] = 2;
  }

  /** Counter tiles follow the phase, but idle stays readable text gray. */
  private counterColor(): Rgb {
    if (this.phase === null || this.phase === "idle") return this.counterText;
    return this.colors[this.phase];
  }

  private counterCoordinates(index: number): [number, number] {
    return [
      this.counterX + (index % this.counterCols) * this.counterStep,
      this.counterY + Math.floor(index / this.counterCols) * this.counterStep,
    ];
  }

  /** Right-align "5" / "42" / "100" into the reserved glyph slots. */
  private counterBitmap(percent: number): Uint8Array {
    if (!this.o.counter) return new Uint8Array(0);
    return counterBitmap(percent, this.counterCols, this.o.cSlots);
  }

  private drawCounterTrack(index: number): void {
    if (!this.bctx) return;
    const [x, y] = this.counterCoordinates(index);
    this.bctx.fillStyle = this.track;
    this.bctx.fillRect(x, y, this.o.cTile, this.o.cTile);
    this.counterStates[index] = 0;
  }

  private drawCounterLit(index: number): void {
    if (!this.bctx) return;
    const [x, y] = this.counterCoordinates(index);
    this.bctx.fillStyle = rgbCss(this.counterColor());
    this.bctx.fillRect(x, y, this.o.cTile, this.o.cTile);
    this.counterStates[index] = 2;
  }

  /**
   * Animate only the tiles whose state differs, so 42 → 43 pops the single
   * segment that changed while the rest of the readout stays put.
   */
  private setCounter(percent: number, now: number): void {
    if (!this.o.counter || percent === this.counterPercent) return;
    this.counterPercent = percent;

    const bitmap = this.counterBitmap(percent);
    for (let index = 0; index < bitmap.length; index++) {
      const lit = bitmap[index] === 1;
      if (lit === (this.counterTarget[index] === 1)) continue;
      this.counterTarget[index] = lit ? 1 : 0;

      const state = this.counterStates[index] ?? 0;
      if (this.reduce) {
        if (lit) this.drawCounterLit(index);
        else this.drawCounterTrack(index);
        continue;
      }

      if (lit) {
        if (state === 1 || state === 2) continue;
        this.counterStates[index] = 1;
        // Left-to-right ripple across the readout.
        this.counterStarts[index] = now + (index % this.counterCols) * 9;
      } else {
        if (state === 0 || state === 3) continue;
        if (state === 2) this.drawCounterTrack(index);
        this.counterStates[index] = 3;
        this.counterStarts[index] = now;
      }

      if (!this.counterActive[index]) {
        this.counterActive[index] = 1;
        this.counterAnimating.push(index);
      }
    }
  }

  private rebuild(progress: number): void {
    if (!this.bctx || !this.fctx) return;
    this.bctx.clearRect(0, 0, this.width, this.canvasHeight);
    this.fctx.clearRect(0, 0, this.width, this.canvasHeight);
    this.animating.length = 0;
    this.states.fill(0);
    this.pointer = 0;
    for (let i = 0; i < this.count; i++) this.drawTrack(i);
    while (
      this.pointer < this.count &&
      (this.thresholds[this.order[this.pointer] ?? 0] ?? 1) <= progress
    ) {
      this.drawSettled(this.order[this.pointer] ?? 0);
      this.pointer++;
    }

    if (this.o.counter) {
      this.counterAnimating.length = 0;
      this.counterActive.fill(0);
      this.counterTarget.fill(0);
      for (let i = 0; i < this.counterTarget.length; i++) this.drawCounterTrack(i);
      const bitmap = this.counterBitmap(this.counterPercent);
      for (let i = 0; i < bitmap.length; i++) {
        if (!bitmap[i]) continue;
        this.counterTarget[i] = 1;
        this.drawCounterLit(i);
      }
    }
  }

  private wake(): void {
    if (!this.frame) {
      this.lastFrame = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number): void => {
    this.frame = 0;
    const sweep = this.sweep;

    // The endless zip sweep runs at roughly 30fps; everything else follows the
    // display refresh rate.
    if (
      sweep?.loop &&
      this.animating.length === 0 &&
      this.counterAnimating.length === 0 &&
      now - this.lastFrame < 30 &&
      Math.abs(this.target - this.displayed) < 1e-4
    ) {
      this.frame = requestAnimationFrame(this.tick);
      return;
    }

    const delta = Math.min(0.05, (now - this.lastFrame) / 1000 || 0.016);
    this.lastFrame = now;

    const difference = this.target - this.displayed;
    if (Math.abs(difference) > 1e-4) {
      this.displayed += this.reduce ? difference : difference * (1 - Math.exp(-delta * 5));
      if (Math.abs(this.target - this.displayed) < 2e-4) this.displayed = this.target;
    }

    while (
      this.pointer < this.count &&
      (this.thresholds[this.order[this.pointer] ?? 0] ?? 1) <= this.displayed + 1e-9
    ) {
      const index = this.order[this.pointer] ?? 0;
      this.pointer++;
      if (this.reduce) {
        this.drawSettled(index);
      } else {
        this.states[index] = 1;
        this.starts[index] = now + (this.delays[index] ?? 0);
        this.animating.push(index);
      }
    }

    const context = this.fctx;
    if (!context) return;
    const { cell, dur, rows } = this.o;
    const middle = (rows - 1) / 2;
    context.clearRect(0, 0, this.width, this.canvasHeight);

    for (let k = this.animating.length - 1; k >= 0; k--) {
      const index = this.animating[k] ?? 0;
      const t = (now - (this.starts[index] ?? 0)) / dur;
      if (t < 0) continue;
      if (t >= 1) {
        this.drawSettled(index);
        const last = this.animating.pop();
        if (last !== undefined && k < this.animating.length) this.animating[k] = last;
        continue;
      }

      const [x, y] = this.coordinates(index);
      const row = Math.floor(index / this.cols);
      const eased = easeOutCubic(t);
      const size = easeOutBack(t) * cell;
      const direction = row < middle ? -1 : row > middle ? 1 : 0;
      const centerX = x + cell / 2 + (direction === 0 ? -(1 - eased) * cell * 4 : 0);
      const centerY = y + cell / 2 + (1 - eased) * direction * cell * 2.6;
      const [ar, ag, ab] = this.colors[this.phase ?? "fetch"];
      const factor = SHADE_FACTORS[this.shadeIndex[index] ?? 0] ?? 1;
      const [hr, hg, hb] = this.hot[this.phase ?? "fetch"];
      context.globalAlpha = Math.min(1, t * 4);
      context.fillStyle = `rgb(${
        (hr + (ar * factor - hr) * eased) | 0
      },${(hg + (ag * factor - hg) * eased) | 0},${(hb + (ab * factor - hb) * eased) | 0})`;
      context.fillRect(centerX - size / 2, centerY - size / 2, size, size);
    }

    const counterTile = this.o.cTile;
    const [cr, cg, cb] = this.counterColor();
    const [chr, chg, chb] =
      this.phase === null || this.phase === "idle"
        ? lighten(this.counterText)
        : this.hot[this.phase];
    context.globalAlpha = 1;

    for (let k = this.counterAnimating.length - 1; k >= 0; k--) {
      const index = this.counterAnimating[k] ?? 0;
      const elapsed = now - (this.counterStarts[index] ?? 0);
      if (elapsed < 0) continue;
      const [x, y] = this.counterCoordinates(index);

      if (this.counterStates[index] === 1) {
        const t = elapsed / 260;
        if (t >= 1) {
          this.drawCounterLit(index);
          this.counterActive[index] = 0;
          const last = this.counterAnimating.pop();
          if (last !== undefined && k < this.counterAnimating.length) {
            this.counterAnimating[k] = last;
          }
          continue;
        }
        const eased = easeOutCubic(t);
        const size = easeOutBack(t) * counterTile;
        context.globalAlpha = Math.min(1, t * 4);
        context.fillStyle = `rgb(${
          (chr + (cr - chr) * eased) | 0
        },${(chg + (cg - chg) * eased) | 0},${(chb + (cb - chb) * eased) | 0})`;
        context.fillRect(
          x + counterTile / 2 - size / 2,
          y + counterTile / 2 - size / 2,
          size,
          size,
        );
      } else {
        const t = elapsed / 150;
        if (t >= 1) {
          this.counterStates[index] = 0;
          this.counterActive[index] = 0;
          const last = this.counterAnimating.pop();
          if (last !== undefined && k < this.counterAnimating.length) {
            this.counterAnimating[k] = last;
          }
          continue;
        }
        // The base tile went dark already; fade the old lit tile out on fx.
        context.globalAlpha = 1 - t;
        context.fillStyle = rgbCss(this.counterColor());
        context.fillRect(x, y, counterTile, counterTile);
      }
    }
    context.globalAlpha = 1;

    if (sweep) {
      sweep.pos += sweep.speed * delta;
      context.fillStyle = this.sweepColor;
      const low = Math.floor(sweep.pos - sweep.width);
      const high = Math.ceil(sweep.pos + sweep.width);
      for (let row = 0; row < rows; row++) {
        for (let col = Math.max(0, low - row); col <= Math.min(this.cols - 1, high - row); col++) {
          const index = row * this.cols + col;
          if (this.states[index] !== 2) continue;
          const distance = Math.abs(col + row - sweep.pos) / sweep.width;
          if (distance >= 1) continue;
          context.globalAlpha = (1 - distance) ** 2 * 0.3;
          const [x, y] = this.coordinates(index);
          context.fillRect(x, y, cell, cell);
        }
      }
      if (sweep.pos - sweep.width > this.cols + rows) {
        if (sweep.loop) sweep.pos = -sweep.width;
        else {
          this.sweep = null;
          context.clearRect(0, 0, this.width, this.canvasHeight);
        }
      }
    }
    context.globalAlpha = 1;

    if (
      this.animating.length ||
      this.counterAnimating.length ||
      Math.abs(this.target - this.displayed) > 1e-4 ||
      this.sweep !== null
    ) {
      this.frame = requestAnimationFrame(this.tick);
    }
  };
}

interface SquareBarProps {
  progress: number;
  phase: BarPhase;
}

/** Solid wrapper around the canvas bar, used by each torrent card. */
export default function SquareBar(props: SquareBarProps) {
  let host: HTMLDivElement | undefined;
  let bar: SquareBarCanvas | undefined;

  onMount(() => {
    if (!host) return;
    bar = new SquareBarCanvas(host);
    // Show the current position immediately; do not replay the fill or the
    // completed sweep just because the popover was reopened.
    bar.jumpTo(props.progress);
    bar.setPhase(props.phase, false);
  });

  createEffect(() => {
    bar?.setProgress(props.progress);
  });

  createEffect(() => {
    bar?.setPhase(props.phase);
  });

  onCleanup(() => {
    bar?.destroy();
    bar = undefined;
  });

  return <div class="square-bar" ref={host} />;
}
