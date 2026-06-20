import type { Params, PaintInfo, RenderModel, Simulation, SystemDef } from '../core/types';
import { boolParam, numParam, rgba, strParam } from '../core/types';
import { hashParts } from '../core/hash';
import { mulberry32 } from '../core/prng';
import { wrapState } from '../core/wrap';

// Cyclic Cellular Automaton (David Griffeath).
//
// States 0..C-1 are arranged in a cycle. A cell in state s "looks ahead" to the
// next state (s+1) mod C: if at least `threshold` of its neighbours are already
// in that successor state, the cell advances to it; otherwise it stays put. The
// cyclic dominance (each state is eaten by the next) drives random soup through
// debris and droplets into self-organising spiral waves and demons.

export type Neighborhood = 'moore' | 'neumann';

/** One relative neighbour offset (centre excluded). */
interface Offset {
  dx: number;
  dy: number;
}

/**
 * Build the neighbour offsets for a Moore (Chebyshev) or von Neumann (Manhattan)
 * ball of the given range, excluding the centre cell. Pure + exported so the
 * known-outcome / shape tests can assert on it directly.
 */
export function buildOffsets(neighborhood: Neighborhood, range: number): Offset[] {
  const out: Offset[] = [];
  const r = Math.max(1, range | 0);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      const within = neighborhood === 'neumann' ? Math.abs(dx) + Math.abs(dy) <= r : true; // Moore: full box
      if (within) out.push({ dx, dy });
    }
  }
  return out;
}

/**
 * Apply one cyclic-CA transition to `src`, writing into `dst`.
 * Exported as a pure helper so behaviour can be unit-tested without a Sim.
 */
export function stepGrid(
  src: Uint8Array,
  dst: Uint8Array,
  width: number,
  height: number,
  states: number,
  threshold: number,
  offsets: ReadonlyArray<Offset>,
  wrap: boolean,
): void {
  const W = width;
  const H = height;
  const C = states;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const s = src[i]!;
      const next = s + 1 === C ? 0 : s + 1; // (s+1) mod C
      let count = 0;
      for (let k = 0; k < offsets.length; k++) {
        const o = offsets[k]!;
        let nx = x + o.dx;
        let ny = y + o.dy;
        if (wrap) {
          // Toroidal wrap. Offsets never exceed ±range (<=3 <= dimension), so a
          // single fold-back is sufficient for the supported grid sizes.
          if (nx < 0) nx += W;
          else if (nx >= W) nx -= W;
          if (ny < 0) ny += H;
          else if (ny >= H) ny -= H;
        } else if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
          continue;
        }
        if (src[ny * W + nx]! === next) count++;
      }
      dst[i] = count >= threshold ? next : s;
    }
  }
}

/** HSL->packed-RGBA. h in [0,1), s,l in [0,1]. Used to spread C hues evenly. */
function hslToRgba(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c);
  };
  return rgba(f(0), f(8), f(4));
}

/** C colours stepped evenly around the hue wheel (full sat, mid-high lightness). */
function buildPalette(states: number): Uint32Array {
  const pal = new Uint32Array(states);
  for (let i = 0; i < states; i++) {
    const h = (i / states) % 1;
    pal[i] = hslToRgba(h, 1, 0.58);
  }
  return pal;
}

/** Matching CSS swatch colours for the brush UI. */
function buildBrushColors(states: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < states; i++) {
    const h = ((i / states) * 360) % 360;
    out.push(`hsl(${h.toFixed(1)},100%,58%)`);
  }
  return out;
}

export class CyclicSim implements Simulation {
  readonly width: number;
  readonly height: number;
  generation = 0;

  private a: Uint8Array;
  private b: Uint8Array;
  private readonly states: number;
  private readonly threshold: number;
  private readonly wrap: boolean;
  private readonly offsets: ReadonlyArray<Offset>;
  private readonly palette: Uint32Array;

  constructor(
    width: number,
    height: number,
    states: number,
    threshold: number,
    neighborhood: Neighborhood,
    range: number,
    wrap: boolean,
  ) {
    this.width = width;
    this.height = height;
    this.states = Math.max(3, states | 0);
    this.threshold = Math.max(1, threshold | 0);
    this.wrap = wrap;
    this.offsets = buildOffsets(neighborhood, range);
    this.a = new Uint8Array(width * height);
    this.b = new Uint8Array(width * height);
    this.palette = buildPalette(this.states);
  }

  /** Direct access to the current generation buffer (read only in practice). */
  get cells(): Uint8Array {
    return this.a;
  }

  /** Number of states in the cycle. */
  get stateCount(): number {
    return this.states;
  }

  /** Seed every cell with a uniform random state in [0, C). Resets generation. */
  randomFill(seed: number): void {
    const rng = mulberry32(seed);
    const a = this.a;
    const C = this.states;
    for (let i = 0; i < a.length; i++) a[i] = Math.floor(rng() * C);
    this.generation = 0;
  }

  clear(): void {
    this.a.fill(0);
    this.generation = 0;
  }

  step(): void {
    stepGrid(
      this.a,
      this.b,
      this.width,
      this.height,
      this.states,
      this.threshold,
      this.offsets,
      this.wrap,
    );
    const tmp = this.a;
    this.a = this.b;
    this.b = tmp;
    this.generation++;
  }

  render(): RenderModel {
    return {
      kind: 'cells',
      width: this.width,
      height: this.height,
      data: this.a,
      palette: this.palette,
    };
  }

  hash(): string {
    return hashParts([this.a, this.generation]);
  }

  paint(info: PaintInfo): void {
    const cx = Math.round(info.x);
    const cy = Math.round(info.y);
    const r = Math.max(0, Math.round(info.radius));
    // Cycle the painted value into a valid state; negatives folded up.
    const v = wrapState(Math.round(info.value), this.states);
    const W = this.width;
    const H = this.height;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        this.a[y * W + x] = v;
      }
    }
  }
}

export const cyclicSystem: SystemDef = {
  id: 'cyclic',
  name: 'Cyclic CA',
  tagline: 'Spiral waves from cyclic dominance',
  description:
    'A Cyclic Cellular Automaton: states are arranged in a ring, and each cell ' +
    'advances to its successor state once enough neighbours already hold it. From a ' +
    'random soup the rule sweeps through debris and droplets into self-organising ' +
    'spiral waves and rotating "demons". Greenberg-Hastings excitable media is the ' +
    '3-state special case.',
  category: 'classic',
  renderKind: 'cells',
  params: [
    { kind: 'int', key: 'states', label: 'States', min: 3, max: 16, step: 1, default: 12 },
    { kind: 'int', key: 'threshold', label: 'Threshold', min: 1, max: 8, step: 1, default: 1 },
    { kind: 'int', key: 'range', label: 'Neighbourhood range', min: 1, max: 3, step: 1, default: 1 },
    {
      kind: 'select',
      key: 'neighborhood',
      label: 'Neighbourhood',
      options: [
        { value: 'moore', label: 'Moore' },
        { value: 'neumann', label: 'Von Neumann' },
      ],
      default: 'moore',
    },
    { kind: 'int', key: 'width', label: 'Width', min: 32, max: 320, step: 1, default: 170 },
    { kind: 'int', key: 'height', label: 'Height', min: 32, max: 240, step: 1, default: 120 },
    { kind: 'bool', key: 'wrap', label: 'Wrap edges', default: true },
  ],
  presets: [
    { id: 'random', label: 'Random soup' },
    { id: 'gh', label: 'Greenberg-Hastings (3-state)', params: { states: 3, threshold: 1, range: 1 } },
    { id: 'spirals', label: 'Spirals (Cyclic 16)', params: { states: 16, threshold: 1, range: 1 } },
    {
      id: 'demons',
      label: 'Perfect demons',
      params: { states: 8, threshold: 3, range: 1, neighborhood: 'moore' },
    },
  ],
  brushStates: 16,
  brushColors: buildBrushColors(16),
  create(params: Params, seed: number, _preset?: string): Simulation {
    const states = numParam(params, 'states', 12);
    const threshold = numParam(params, 'threshold', 1);
    const range = numParam(params, 'range', 1);
    const neighborhood = strParam(params, 'neighborhood', 'moore') === 'neumann' ? 'neumann' : 'moore';
    const width = numParam(params, 'width', 170);
    const height = numParam(params, 'height', 120);
    const wrap = boolParam(params, 'wrap', true);
    const sim = new CyclicSim(width, height, states, threshold, neighborhood, range, wrap);
    sim.randomFill(seed);
    return sim;
  },
};
