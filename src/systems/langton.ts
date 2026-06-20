import type { PaintInfo, Params, RenderModel, Simulation, SystemDef } from '../core/types';
import { boolParam, numParam, rgba, strParam } from '../core/types';
import { hashParts } from '../core/hash';
import { mulberry32, randInt } from '../core/prng';

// ─────────────────────────────────────────────────────────────────────────────
// Langton's ant + turmites
//
// A grid of Uint8 cell colours (0..numColors-1) walked by one or more "ants".
// Each ant carries a position and a heading; on every tick it reads the colour
// under it, turns according to a per-colour turn rule, advances that colour, and
// steps forward one cell. The classic Langton's ant is the two-colour rule "RL".
// ─────────────────────────────────────────────────────────────────────────────

// Heading encoding: 0=North(dy=-1) 1=East(dx=+1) 2=South(dy=+1) 3=West(dx=-1).
const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;

/** A single turn instruction, derived from one character of the rule string. */
export const enum Turn {
  Left = 0, // dir = (dir + 3) & 3
  Right = 1, // dir = (dir + 1) & 3
  UTurn = 2, // dir = (dir + 2) & 3
  None = 3, // dir unchanged
}

/**
 * Parse a turn rule string over the alphabet {L,R,U,N} into per-colour turns.
 * The number of colours equals the string length. Unknown characters are
 * skipped; an empty/invalid result falls back to the classic "RL".
 */
export function parseRule(input: string): Turn[] {
  const turns: Turn[] = [];
  for (const ch of input.toUpperCase()) {
    switch (ch) {
      case 'L':
        turns.push(Turn.Left);
        break;
      case 'R':
        turns.push(Turn.Right);
        break;
      case 'U':
        turns.push(Turn.UTurn);
        break;
      case 'N':
        turns.push(Turn.None);
        break;
      default:
        // ignore whitespace / stray characters
        break;
    }
  }
  if (turns.length === 0) return [Turn.Right, Turn.Left];
  return turns;
}

/** Apply a turn to a heading, returning the new heading in {0,1,2,3}. */
export function applyTurn(dir: number, turn: Turn): number {
  switch (turn) {
    case Turn.Left:
      return (dir + 3) & 3;
    case Turn.Right:
      return (dir + 1) & 3;
    case Turn.UTurn:
      return (dir + 2) & 3;
    case Turn.None:
      return dir & 3;
    default:
      return dir & 3;
  }
}

/** Minimal read-only snapshot of an ant, exposed for tests/debug. */
export interface AntState {
  readonly x: number;
  readonly y: number;
  readonly dir: number;
}

export class LangtonSim implements Simulation {
  readonly width: number;
  readonly height: number;
  generation = 0;

  private grid: Uint8Array; // hashed state: cell colours
  private view: Uint8Array; // render scratch (grid + ant markers), never hashed

  private readonly turns: Turn[];
  private readonly numColors: number;
  private readonly wrap: boolean;
  private readonly seed: number;
  private readonly startMode: 'center' | 'random';
  private readonly antCount: number;

  // Ant state, kept in flat parallel arrays for cheap hashing.
  private readonly ax: Int32Array;
  private readonly ay: Int32Array;
  private readonly ad: Uint8Array; // headings 0..3

  private readonly palette: Uint32Array;
  private readonly markerIndex: number;

  constructor(
    width: number,
    height: number,
    turns: Turn[],
    antCount: number,
    wrap: boolean,
    startMode: 'center' | 'random',
    seed: number,
  ) {
    this.width = width;
    this.height = height;
    this.turns = turns;
    this.numColors = turns.length;
    this.wrap = wrap;
    this.startMode = startMode;
    this.seed = seed;
    this.antCount = Math.max(1, antCount);

    this.grid = new Uint8Array(width * height);
    this.view = new Uint8Array(width * height);

    this.ax = new Int32Array(this.antCount);
    this.ay = new Int32Array(this.antCount);
    this.ad = new Uint8Array(this.antCount);

    this.palette = buildPalette(this.numColors);
    this.markerIndex = this.palette.length - 1;

    this.placeAnts();
  }

  /** Seed ant positions/headings from the chosen start mode (deterministic). */
  private placeAnts(): void {
    const rng = mulberry32(this.seed);
    const cx = this.width >> 1;
    const cy = this.height >> 1;
    for (let i = 0; i < this.antCount; i++) {
      if (this.startMode === 'random') {
        this.ax[i] = randInt(rng, this.width);
        this.ay[i] = randInt(rng, this.height);
        this.ad[i] = randInt(rng, 4);
      } else {
        // All ants start at centre facing North; for swarms they overlap and
        // diverge as soon as the grid under them differs.
        this.ax[i] = cx;
        this.ay[i] = cy;
        this.ad[i] = 0;
      }
    }
  }

  /** Read-only ant snapshot, for known-outcome tests and debugging. */
  ant(i = 0): AntState {
    return { x: this.ax[i]!, y: this.ay[i]!, dir: this.ad[i]! };
  }

  /** Number of ants on the plane. */
  get ants(): number {
    return this.antCount;
  }

  /** Direct read access to cell colours (for tests). */
  get cells(): Uint8Array {
    return this.grid;
  }

  step(): void {
    const W = this.width;
    const H = this.height;
    const grid = this.grid;
    const turns = this.turns;
    const nc = this.numColors;
    const wrap = this.wrap;

    // Ants are processed in array order against the live grid. They very rarely
    // share a cell within one tick, so ordering is not observable in practice;
    // we document the in-order, in-place choice for determinism.
    for (let i = 0; i < this.antCount; i++) {
      const x = this.ax[i]!;
      const y = this.ay[i]!;
      const idx = y * W + x;
      const c = grid[idx]!;

      // Turn according to this colour's rule, then advance the colour.
      const dir = applyTurn(this.ad[i]!, turns[c]!);
      this.ad[i] = dir;
      grid[idx] = (c + 1) % nc;

      // Move one cell forward, wrapping (or clamping when wrap is off).
      let nx = x + DX[dir]!;
      let ny = y + DY[dir]!;
      if (wrap) {
        if (nx < 0) nx = W - 1;
        else if (nx >= W) nx = 0;
        if (ny < 0) ny = H - 1;
        else if (ny >= H) ny = 0;
      } else {
        if (nx < 0) nx = 0;
        else if (nx >= W) nx = W - 1;
        if (ny < 0) ny = 0;
        else if (ny >= H) ny = H - 1;
      }
      this.ax[i] = nx;
      this.ay[i] = ny;
    }

    this.generation++;
  }

  render(): RenderModel {
    // Copy the colour grid, then overlay each ant cell with the marker colour.
    this.view.set(this.grid);
    for (let i = 0; i < this.antCount; i++) {
      this.view[this.ay[i]! * this.width + this.ax[i]!] = this.markerIndex;
    }
    return { kind: 'cells', width: this.width, height: this.height, data: this.view, palette: this.palette };
  }

  hash(): string {
    // Fold the colour grid plus every ant's position/heading and the generation.
    // The render view (which carries transient ant markers) is deliberately
    // excluded so the fingerprint reflects true simulation state only.
    return hashParts([this.grid, this.ax, this.ay, this.ad, this.generation]);
  }

  paint(info: PaintInfo): void {
    const cx = Math.round(info.x);
    const cy = Math.round(info.y);
    const r = Math.max(0, Math.round(info.radius));
    const v = ((Math.round(info.value) % this.numColors) + this.numColors) % this.numColors;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
        this.grid[y * this.width + x] = v;
      }
    }
  }

  clear(): void {
    this.grid.fill(0);
    this.generation = 0;
    this.placeAnts();
  }
}

// ── Palette ──────────────────────────────────────────────────────────────────

const BACKGROUND = rgba(8, 11, 17); // colour 0
const MARKER = rgba(255, 90, 140); // bright ant overlay

/**
 * Build a palette of `numColors` colours plus one trailing marker entry. Colour
 * 0 is the dark background; the remaining colours sweep a pleasant hue wheel.
 */
function buildPalette(numColors: number): Uint32Array {
  const out = new Uint32Array(numColors + 1);
  out[0] = BACKGROUND;
  for (let c = 1; c < numColors; c++) {
    // Spread hues around the wheel; keep saturation/value high but not garish.
    const hue = ((c - 1) / Math.max(1, numColors - 1)) * 360;
    out[c] = hsvToRgba(hue, 0.62, 0.92);
  }
  out[numColors] = MARKER;
  return out;
}

/** HSV (h in [0,360), s,v in [0,1]) to packed RGBA. */
function hsvToRgba(h: number, s: number, v: number): number {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = v - c;
  return rgba(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}

// ── System definition ──────────────────────────────────────────────────────────

// Brush states are capped small so the swatch UI stays usable on long rules.
const BRUSH_CAP = 8;

export const langtonSystem: SystemDef = {
  id: 'langton',
  name: "Langton's Ant",
  tagline: 'Turmites: ants that rewrite the plane',
  description:
    "Langton's ant is the simplest turmite: a single agent that turns by the colour " +
    'beneath it, flips that colour, and steps forward. From total chaos it spontaneously ' +
    'builds an endless diagonal "highway" after ~10,000 steps. Longer turn rules over ' +
    'the alphabet L/R/U/N (one letter per colour) yield wildly different worlds — try ' +
    'RLR, the LLRRRLRLRLLR highway, or a six-ant swarm.',
  category: 'agent',
  brushStates: BRUSH_CAP,
  brushColors: ['#080b11', '#5ef2c4', '#f2c45e', '#7c8cf2', '#f25e8c', '#5ef27c', '#c45ef2', '#f2925e'],
  params: [
    {
      kind: 'rule',
      key: 'rule',
      label: 'Turn rule',
      default: 'RL',
      placeholder: 'e.g. RL, RLR, LLRRRLRLRLLR',
      help: 'One of L/R/U/N per colour',
    },
    { kind: 'int', key: 'width', label: 'Width', min: 32, max: 400, step: 1, default: 200 },
    { kind: 'int', key: 'height', label: 'Height', min: 32, max: 300, step: 1, default: 140 },
    { kind: 'int', key: 'ants', label: 'Ants', min: 1, max: 16, step: 1, default: 1 },
    { kind: 'bool', key: 'wrap', label: 'Wrap edges', default: true },
    {
      kind: 'select',
      key: 'start',
      label: 'Start',
      options: [
        { value: 'center', label: 'Centre' },
        { value: 'random', label: 'Random (seeded)' },
      ],
      default: 'center',
    },
  ],
  presets: [
    { id: 'langton', label: "Langton's ant (RL)", params: { rule: 'RL', ants: 1, start: 'center' } },
    { id: 'rlr', label: 'RLR (symmetric)', params: { rule: 'RLR' } },
    { id: 'highway', label: 'LLRRRLRLRLLR', params: { rule: 'LLRRRLRLRLLR' } },
    { id: 'rrll', label: 'RRLL (chaos)', params: { rule: 'RRLL' } },
    { id: 'swarm', label: 'Ant swarm', params: { rule: 'RL', ants: 8, start: 'random' } },
  ],
  create(params: Params, seed: number, _preset?: string): Simulation {
    const width = numParam(params, 'width', 200);
    const height = numParam(params, 'height', 140);
    const ants = numParam(params, 'ants', 1);
    const wrap = boolParam(params, 'wrap', true);
    const start = strParam(params, 'start', 'center') === 'random' ? 'random' : 'center';
    const turns = parseRule(strParam(params, 'rule', 'RL'));
    return new LangtonSim(width, height, turns, ants, wrap, start, seed);
  },
};