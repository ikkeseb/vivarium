import type { Params, PaintInfo, RenderModel, Simulation, SystemDef } from '../core/types';
import { numParam, rgba, strParam } from '../core/types';
import { mulberry32 } from '../core/prng';
import { hashParts } from '../core/hash';

// Elementary 1D cellular automata — Wolfram's 256 one-dimensional rules.
//
// A single row of W cells is evolved over time. We render the history as a 2D
// image: the newest generation lives on the BOTTOM row and older generations
// scroll upward as time advances.
//
// Wolfram rule convention: for the three neighbours (left, center, right), each
// 0/1, the next center state is
//     newState = (rule >> ((left << 2) | (center << 1) | right)) & 1.

// Two-state palette shared by every instance (built once).
const PALETTE = new Uint32Array([rgba(8, 11, 17), rgba(94, 242, 196)]);

/**
 * Pure transition: compute the next row from `prev` under the given Wolfram
 * `rule`. Off-grid neighbours wrap toroidally when `wrap` is true, otherwise
 * they are treated as 0. Exported for direct unit testing.
 */
export function elementaryRow(prev: Uint8Array, rule: number, wrap: boolean): Uint8Array {
  const w = prev.length;
  const next = new Uint8Array(w);
  for (let i = 0; i < w; i++) {
    let left: number;
    let right: number;
    if (wrap) {
      left = prev[(i - 1 + w) % w]!;
      right = prev[(i + 1) % w]!;
    } else {
      left = i > 0 ? prev[i - 1]! : 0;
      right = i < w - 1 ? prev[i + 1]! : 0;
    }
    const center = prev[i]!;
    const idx = (left << 2) | (center << 1) | right;
    next[i] = (rule >> idx) & 1;
  }
  return next;
}

class ElementarySim {
  readonly width: number;
  readonly height: number;
  generation = 0;

  private readonly rule: number;
  private readonly wrap: boolean;
  // 2D display history: data[y*W + x]; newest generation on the bottom row.
  private readonly data: Uint8Array;
  // The live current row that step() advances.
  private cur: Uint8Array;

  constructor(width: number, height: number, rule: number, wrap: boolean) {
    this.width = width;
    this.height = height;
    this.rule = rule & 0xff;
    this.wrap = wrap;
    this.data = new Uint8Array(width * height);
    this.cur = new Uint8Array(width);
  }

  /** Build the initial current row from the chosen seeding strategy. */
  seed(init: string, density: number, seedValue: number): void {
    const w = this.width;
    this.cur.fill(0);
    if (init === 'random') {
      const rng = mulberry32(seedValue);
      for (let i = 0; i < w; i++) this.cur[i] = rng() < density ? 1 : 0;
    } else if (init === 'left') {
      this.cur[0] = 1;
    } else {
      // 'single': a single live cell at the centre.
      this.cur[(w / 2) | 0] = 1;
    }
    this.writeCurToBottom();
    this.generation = 0;
  }

  private writeCurToBottom(): void {
    const w = this.width;
    const base = (this.height - 1) * w;
    this.data.set(this.cur, base);
  }

  step(): void {
    const w = this.width;
    const next = elementaryRow(this.cur, this.rule, this.wrap);
    // Scroll the display up by one row, then write the new row at the bottom.
    this.data.copyWithin(0, w);
    this.data.set(next, (this.height - 1) * w);
    this.cur = next;
    this.generation++;
  }

  render(): RenderModel {
    return {
      kind: 'cells',
      width: this.width,
      height: this.height,
      data: this.data,
      palette: PALETTE,
    };
  }

  hash(): string {
    return hashParts([this.data, this.cur, this.generation]);
  }

  paint(info: PaintInfo): void {
    const w = this.width;
    const r = Math.max(0, Math.floor(info.radius));
    const cx = Math.floor(info.x);
    const v = info.value ? 1 : 0;
    const base = (this.height - 1) * w;
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= w) continue;
      this.cur[x] = v;
      this.data[base + x] = v;
    }
  }

  clear(): void {
    this.data.fill(0);
    this.cur.fill(0);
    this.generation = 0;
  }
}

export const elementarySystem: SystemDef = {
  id: 'elementary',
  name: 'Elementary 1D',
  tagline: "Wolfram's 256 one-dimensional rules",
  description:
    'Stephen Wolfram’s elementary cellular automata: a single row of cells evolves ' +
    'by a rule that maps each cell’s three-neighbour state (left, center, right) to its ' +
    'next value. With 8 possible neighbourhoods there are exactly 2^8 = 256 rules. History ' +
    'scrolls upward, newest generation at the bottom. Rule 30 is chaotic, 90 draws a ' +
    'Sierpiński triangle, and 110 is Turing-complete.',
  category: '1d',
  renderKind: 'cells',
  brushStates: 2,
  brushColors: ['#0a0e14', '#5ef2c4'],
  params: [
    { kind: 'int', key: 'rule', label: 'Rule', min: 0, max: 255, step: 1, default: 30 },
    { kind: 'int', key: 'width', label: 'Width', min: 32, max: 512, step: 1, default: 240 },
    { kind: 'int', key: 'height', label: 'Height', min: 32, max: 300, step: 1, default: 160 },
    { kind: 'bool', key: 'wrap', label: 'Wrap edges', default: true },
    {
      kind: 'select',
      key: 'init',
      label: 'Seed',
      options: [
        { value: 'single', label: 'Single cell' },
        { value: 'random', label: 'Random' },
        { value: 'left', label: 'Single left' },
      ],
      default: 'single',
    },
    {
      kind: 'float',
      key: 'density',
      label: 'Random density',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      help: 'Fill fraction used by the Random seed.',
    },
  ],
  presets: [
    { id: 'rule30', label: 'Rule 30 (chaos)', params: { rule: 30, init: 'single' } },
    { id: 'rule90', label: 'Rule 90 (Sierpinski)', params: { rule: 90, init: 'single' } },
    { id: 'rule110', label: 'Rule 110 (Turing-complete)', params: { rule: 110, init: 'single' } },
    { id: 'rule184', label: 'Rule 184 (traffic)', params: { rule: 184, init: 'random' } },
    { id: 'rule73', label: 'Rule 73', params: { rule: 73, init: 'random' } },
  ],
  create(params: Params, seed: number): Simulation {
    const width = numParam(params, 'width', 240);
    const height = numParam(params, 'height', 160);
    const rule = numParam(params, 'rule', 30);
    const wrap = params['wrap'] !== false;
    const init = strParam(params, 'init', 'single');
    const density = numParam(params, 'density', 0.5);
    const sim = new ElementarySim(width, height, rule, wrap);
    sim.seed(init, density, seed);
    return sim;
  },
};