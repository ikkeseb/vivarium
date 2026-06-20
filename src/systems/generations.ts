import type { PaintInfo, Params, RenderModel, Simulation, SystemDef } from '../core/types';
import { boolParam, numParam, rgba, rgbaToCss, strParam } from '../core/types';
import { hashParts } from '../core/hash';
import { mulberry32 } from '../core/prng';

// ─────────────────────────────────────────────────────────────────────────────
// Generations — multi-state outer-totalistic cellular automata.
//
// Cells live on a state ladder 0..C-1: 0 = dead, 1 = alive, 2..C-1 = "dying"
// (refractory) states that decay deterministically toward 0 and cannot be
// counted as live neighbours. Only state-1 cells count when totalling, which is
// what produces the characteristic gliders/spirals of Brian's Brain, Star Wars,
// Frogs, and friends. This generalises the 2-state Life-like core.
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerationsRule {
  /** survive[n] === true: a live (state-1) cell with n live neighbours stays alive. */
  survive: boolean[];
  /** birth[n] === true: a dead (state-0) cell with n live neighbours becomes alive. */
  birth: boolean[];
  /** Total number of states C (>= 2). */
  states: number;
}

/**
 * Parse a "S/B/C" rule string into survive/birth lookup tables (over neighbour
 * counts 0..8) plus the state count C.
 *
 * Format: survive digits, then birth digits, then the state count, all slash
 * separated. Brian's Brain = "/2/3" (survive none, birth on 2, C=3); Star Wars =
 * "345/2/4"; Frogs = "12/34/3". Parsing is tolerant of stray whitespace; missing
 * fields default to empty/2 and the state count is clamped to a minimum of 2.
 */
export function parseGenerations(rule: string): { survive: boolean[]; birth: boolean[]; states: number } {
  const survive = new Array<boolean>(9).fill(false);
  const birth = new Array<boolean>(9).fill(false);
  const parts = rule.replace(/\s+/g, '').split('/');
  const sField = parts[0] ?? '';
  const bField = parts[1] ?? '';
  const cField = parts[2] ?? '';
  for (const ch of sField) {
    const n = ch.charCodeAt(0) - 48;
    if (n >= 0 && n <= 8) survive[n] = true;
  }
  for (const ch of bField) {
    const n = ch.charCodeAt(0) - 48;
    if (n >= 0 && n <= 8) birth[n] = true;
  }
  const parsed = Number.parseInt(cField, 10);
  const states = Number.isFinite(parsed) ? Math.max(2, parsed) : 2;
  return { survive, birth, states };
}

// State-0 (dead) and state-1 (alive) anchor colours, matching the house palette.
const DEAD = rgba(8, 11, 17);
const ALIVE = rgba(94, 242, 196);

/**
 * Build a palette of length C: index 0 = dead, index 1 = bright accent, and the
 * dying states 2..C-1 fade smoothly from a warm cyan down toward the dead colour
 * so the refractory tail reads as a comet trail.
 */
function buildPalette(states: number): Uint32Array {
  const pal = new Uint32Array(states);
  pal[0] = DEAD;
  pal[1] = ALIVE;
  // Fade head (just past alive) toward the dark dead colour.
  const head = { r: 245, g: 196, b: 110 }; // warm amber for the freshest dying cell
  const tail = { r: 14, g: 18, b: 28 }; // nearly the dead colour for the oldest
  const span = states - 2; // number of dying states
  for (let s = 2; s < states; s++) {
    // t in [0,1): 0 at the first dying state, approaching 1 at the last.
    const t = span <= 1 ? 0 : (s - 2) / (span - 1);
    const r = Math.round(head.r + (tail.r - head.r) * t);
    const g = Math.round(head.g + (tail.g - head.g) * t);
    const b = Math.round(head.b + (tail.b - head.b) * t);
    pal[s] = rgba(r, g, b);
  }
  return pal;
}

export class GenerationsSim implements Simulation {
  readonly width: number;
  readonly height: number;
  generation = 0;

  private a: Uint8Array;
  private b: Uint8Array;
  private rule: GenerationsRule;
  private wrap: boolean;
  private palette: Uint32Array;

  constructor(width: number, height: number, rule: GenerationsRule, wrap: boolean) {
    this.width = width;
    this.height = height;
    this.rule = rule;
    this.wrap = wrap;
    this.a = new Uint8Array(width * height);
    this.b = new Uint8Array(width * height);
    this.palette = buildPalette(rule.states);
  }

  /** Number of distinct states C for this rule. */
  get states(): number {
    return this.rule.states;
  }

  /** Direct access to the current generation buffer (read/write). */
  get cells(): Uint8Array {
    return this.a;
  }

  set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const C = this.rule.states;
    // Clamp into [0, C) by wrapping; keeps painted values valid palette indices.
    let s = v % C;
    if (s < 0) s += C;
    this.a[y * this.width + x] = s;
  }

  /** Seed only living (state-1) cells with the given probability; never dying ones. */
  randomFill(seed: number, density: number): void {
    const rng = mulberry32(seed);
    const a = this.a;
    for (let i = 0; i < a.length; i++) a[i] = rng() < density ? 1 : 0;
    this.generation = 0;
  }

  clear(): void {
    this.a.fill(0);
    this.generation = 0;
  }

  step(): void {
    const W = this.width;
    const H = this.height;
    const a = this.a;
    const b = this.b;
    const survive = this.rule.survive;
    const birth = this.rule.birth;
    const C = this.rule.states;
    const wrap = this.wrap;

    for (let y = 0; y < H; y++) {
      const y0 = y * W;
      const up = y > 0 ? y0 - W : wrap ? (H - 1) * W : -1;
      const dn = y < H - 1 ? y0 + W : wrap ? 0 : -1;
      for (let x = 0; x < W; x++) {
        const xl = x > 0 ? x - 1 : wrap ? W - 1 : -1;
        const xr = x < W - 1 ? x + 1 : wrap ? 0 : -1;

        // Count Moore neighbours that are exactly state 1 (alive).
        let n = 0;
        if (up >= 0) {
          if (xl >= 0 && a[up + xl]! === 1) n++;
          if (a[up + x]! === 1) n++;
          if (xr >= 0 && a[up + xr]! === 1) n++;
        }
        if (xl >= 0 && a[y0 + xl]! === 1) n++;
        if (xr >= 0 && a[y0 + xr]! === 1) n++;
        if (dn >= 0) {
          if (xl >= 0 && a[dn + xl]! === 1) n++;
          if (a[dn + x]! === 1) n++;
          if (xr >= 0 && a[dn + xr]! === 1) n++;
        }

        const cell = a[y0 + x]!;
        let next: number;
        if (cell === 0) {
          next = birth[n] ? 1 : 0;
        } else if (cell === 1) {
          next = survive[n] ? 1 : 2;
        } else {
          // Refractory: advance along the dying ladder; recover to dead at C.
          next = cell + 1 >= C ? 0 : cell + 1;
        }
        b[y0 + x] = next;
      }
    }

    this.a = b;
    this.b = a;
    this.generation++;
  }

  render(): RenderModel {
    return { kind: 'cells', width: this.width, height: this.height, data: this.a, palette: this.palette };
  }

  hash(): string {
    return hashParts([this.a, this.generation]);
  }

  paint(info: PaintInfo): void {
    const cx = Math.round(info.x);
    const cy = Math.round(info.y);
    const r = Math.max(0, Math.round(info.radius));
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        this.set(cx + dx, cy + dy, info.value);
      }
    }
  }
}

export const generationsSystem: SystemDef = {
  id: 'generations',
  name: 'Generations',
  tagline: 'Life with fading, refractory states',
  description:
    'Outer-totalistic cellular automata with a refractory tail. Cells climb a state ' +
    'ladder 0..C-1: dead, alive, then a sequence of "dying" states that fade out and ' +
    'cannot be reborn until they reach 0 again. Only living cells count as neighbours, ' +
    "which gives Brian's Brain its restless gliders and Star Wars its drifting ships. " +
    'Rule format is S/B/C — survival counts, birth counts, then the number of states.',
  category: 'classic',
  renderKind: 'cells',
  // Build brush metadata for the default Brian's Brain rule (C=3).
  brushStates: parseGenerations('/2/3').states,
  brushColors: Array.from(buildPalette(parseGenerations('/2/3').states), (v) => rgbaToCss(v)),
  params: [
    {
      kind: 'rule',
      key: 'rule',
      label: 'Rule (S/B/C)',
      default: '/2/3',
      placeholder: 'e.g. /2/3, 345/2/4',
      help: 'Survival counts / birth counts / number of states. Only state-1 cells count as neighbours.',
    },
    { kind: 'int', key: 'width', label: 'Width', min: 32, max: 320, step: 1, default: 160 },
    { kind: 'int', key: 'height', label: 'Height', min: 32, max: 240, step: 1, default: 110 },
    { kind: 'bool', key: 'wrap', label: 'Wrap edges', default: true },
    {
      kind: 'float',
      key: 'density',
      label: 'Random density',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.2,
      help: 'Fraction of cells seeded alive (state 1) by the random fill.',
    },
  ],
  presets: [
    { id: 'brain', label: "Brian's Brain (/2/3)", params: { rule: '/2/3' } },
    { id: 'starwars', label: 'Star Wars (345/2/4)', params: { rule: '345/2/4' } },
    { id: 'frogs', label: 'Frogs (12/34/3)', params: { rule: '12/34/3' } },
    { id: 'bombers', label: 'Bombers (345/24/25)', params: { rule: '345/24/25' } },
  ],
  create(params: Params, seed: number, _preset?: string): Simulation {
    const width = numParam(params, 'width', 160);
    const height = numParam(params, 'height', 110);
    const wrap = boolParam(params, 'wrap', true);
    const density = numParam(params, 'density', 0.2);
    const ruleStr = strParam(params, 'rule', '/2/3');
    const rule = parseGenerations(ruleStr);
    const sim = new GenerationsSim(width, height, rule, wrap);
    sim.randomFill(seed, density);
    return sim;
  },
};
