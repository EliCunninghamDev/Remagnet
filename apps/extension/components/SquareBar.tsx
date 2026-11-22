import { createEffect, onCleanup, onMount } from "solid-js";

export type BarPhase = "fetch" | "zip" | "done";

interface BarOptions {
  cell: number;
  gap: number;
  rows: number;
  jitter: number;
  dur: number;
  delay: number;
  track: string;
  accent: readonly [number, number, number];
  hot: readonly [number, number, number];
}

const DEFAULTS: BarOptions = {
  cell: 6,
  gap: 2,
  rows: 5,
  jitter: 7,
  dur: 460,
  delay: 160,
  track: "#151a21",
  accent: [56, 225, 168],
  hot: [220, 255, 242],
};

const SHADE_FACTORS = [0.7, 0.8, 0.88, 0.95, 1] as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeOutBack = (t: number) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

/** Small deterministic PRNG so resizing does not reshuffle the cells. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

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
  private readonly shades: string[];

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
  private sweep: { pos: number; speed: number; width: number; loop: boolean } | null = null;
  private phase: BarPhase | null = null;
  private frame = 0;
  private lastFrame = 0;
  private lastPercent = -1;

  constructor(host: HTMLElement, options: Partial<BarOptions> = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.host = host;
    this.step = this.o.cell + this.o.gap;
    this.height = this.o.rows * this.step - this.o.gap;
    this.pad = Math.ceil(this.o.cell * 3.5);
    this.reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.shades = SHADE_FACTORS.map((factor) => {
      const [r, g, b] = this.o.accent;
      return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
    });

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
    if (value < this.displayed - 1e-3) {
      this.displayed = value;
      this.rebuild(value);
    }
    this.target = value;
    const percent = Math.round(value * 100);
    if (percent !== this.lastPercent) {
      this.lastPercent = percent;
      this.host.setAttribute("aria-valuenow", String(percent));
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
    this.lastPercent = Math.round(value * 100);
    this.host.setAttribute("aria-valuenow", String(this.lastPercent));
    this.rebuild(value);
  }

  setPhase(phase: BarPhase, animate = true): void {
    // Polling re-renders the cards, but a phase only changes on a real state
    // transition. Ignore repeats so the zip/ready sweep plays once.
    if (phase === this.phase) return;
    this.phase = phase;
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

    const { gap, rows, jitter } = this.o;
    const cols = Math.max(1, Math.floor((width + gap) / this.step));
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
    this.cols = cols;
    this.count = cols * rows;
    this.offsetX = Math.floor((width - (cols * this.step - gap)) / 2);

    const random = seededRandom(1337);
    const count = this.count;
    this.thresholds = new Float32Array(count);
    this.shadeIndex = new Uint8Array(count);
    this.delays = new Float32Array(count);
    this.starts = new Float64Array(count);
    this.states = new Uint8Array(count);

    const span = cols - 1 + jitter;
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      this.thresholds[i] = (col + random() * jitter) / span;
      this.shadeIndex[i] = Math.floor(random() * this.shades.length);
      this.delays[i] = random() * this.o.delay;
    }

    this.order = Uint32Array.from({ length: count }, (_, i) => i).sort(
      (a, b) => (this.thresholds[a] ?? 0) - (this.thresholds[b] ?? 0),
    );
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
    this.bctx.fillStyle = this.o.track;
    this.bctx.fillRect(x, y, this.o.cell, this.o.cell);
  }

  private drawSettled(index: number): void {
    if (!this.bctx) return;
    const [x, y] = this.coordinates(index);
    this.bctx.fillStyle = this.shades[this.shadeIndex[index] ?? 0] ?? "#38e1a8";
    this.bctx.fillRect(x, y, this.o.cell, this.o.cell);
    this.states[index] = 2;
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
      const [ar, ag, ab] = this.o.accent;
      const factor = SHADE_FACTORS[this.shadeIndex[index] ?? 0] ?? 1;
      const [hr, hg, hb] = this.o.hot;
      context.globalAlpha = Math.min(1, t * 4);
      context.fillStyle = `rgb(${
        (hr + (ar * factor - hr) * eased) | 0
      },${(hg + (ag * factor - hg) * eased) | 0},${(hb + (ab * factor - hb) * eased) | 0})`;
      context.fillRect(centerX - size / 2, centerY - size / 2, size, size);
    }

    if (sweep) {
      sweep.pos += sweep.speed * delta;
      context.fillStyle = "#fff";
      const low = Math.floor(sweep.pos - sweep.width);
      const high = Math.ceil(sweep.pos + sweep.width);
      for (let row = 0; row < rows; row++) {
        for (let col = Math.max(0, low - row); col <= Math.min(this.cols - 1, high - row); col++) {
          const index = row * this.cols + col;
          if (this.states[index] !== 2) continue;
          const distance = Math.abs(col + row - sweep.pos) / sweep.width;
          if (distance >= 1) continue;
          context.globalAlpha = (1 - distance) ** 2 * 0.6;
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
