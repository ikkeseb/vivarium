import type { PaintInfo, Params, RenderModel, Simulation, SystemDef } from '../core/types';
import { boolParam, numParam, rgba, rgbaToCss } from '../core/types';
import { hashParts } from '../core/hash';

// ─────────────────────────────────────────────────────────────────────────────
// Wireworld — Brian Silverman's electron-on-a-circuit cellular automaton.
//
// Four states drive everything:
//   0 empty       — inert background
//   1 head        — the leading edge of an electron
//   2 tail        — the trailing edge (keeps signals one-directional)
//   3 conductor   — wire
//
// Transition rules (Moore neighbourhood):
//   empty     -> empty
//   head      -> tail
//   tail      -> conductor
//   conductor -> head  iff exactly 1 or 2 of its 8 neighbours are heads,
//                      otherwise it stays conductor.
//
// The head→tail→conductor cycle is what makes an electron a moving pair (head
// in front, tail behind) that propagates forward while the tail blocks it from
// running backwards — so wires carry directed pulses and loops oscillate forever.
// Fully deterministic with no RNG: presets stamp fixed circuits.
// ─────────────────────────────────────────────────────────────────────────────

export const EMPTY = 0;
export const HEAD = 1;
export const TAIL = 2;
export const COND = 3;
const STATES = 4;

// On-brand palette: dim teal wires at rest, a bright mint signal head, a cooler
// fading tail, near-black empty space.
const PALETTE = new Uint32Array([
  rgba(8, 11, 17), // empty
  rgba(120, 245, 210), // head — bright mint signal
  rgba(70, 150, 130), // tail — cooler fading trail
  rgba(36, 64, 58), // conductor — recessive teal wire
]);

export class WireworldSim implements Simulation {
  readonly width: number;
  readonly height: number;
  generation = 0;

  private a: Uint8Array;
  private b: Uint8Array;
  private wrap: boolean;

  constructor(width: number, height: number, wrap: boolean) {
    this.width = width;
    this.height = height;
    this.wrap = wrap;
    this.a = new Uint8Array(width * height);
    this.b = new Uint8Array(width * height);
  }

  /** Direct access to the current generation buffer (read/write). */
  get cells(): Uint8Array {
    return this.a;
  }

  set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    let s = v % STATES;
    if (s < 0) s += STATES;
    this.a[y * this.width + x] = s;
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
    const wrap = this.wrap;

    for (let y = 0; y < H; y++) {
      const y0 = y * W;
      const up = y > 0 ? y0 - W : wrap ? (H - 1) * W : -1;
      const dn = y < H - 1 ? y0 + W : wrap ? 0 : -1;
      for (let x = 0; x < W; x++) {
        const cell = a[y0 + x]!;
        let next: number;
        if (cell === EMPTY) {
          next = EMPTY;
        } else if (cell === HEAD) {
          next = TAIL;
        } else if (cell === TAIL) {
          next = COND;
        } else {
          // Conductor: count Moore neighbours that are electron heads.
          const xl = x > 0 ? x - 1 : wrap ? W - 1 : -1;
          const xr = x < W - 1 ? x + 1 : wrap ? 0 : -1;
          let n = 0;
          if (up >= 0) {
            if (xl >= 0 && a[up + xl]! === HEAD) n++;
            if (a[up + x]! === HEAD) n++;
            if (xr >= 0 && a[up + xr]! === HEAD) n++;
          }
          if (xl >= 0 && a[y0 + xl]! === HEAD) n++;
          if (xr >= 0 && a[y0 + xr]! === HEAD) n++;
          if (dn >= 0) {
            if (xl >= 0 && a[dn + xl]! === HEAD) n++;
            if (a[dn + x]! === HEAD) n++;
            if (xr >= 0 && a[dn + xr]! === HEAD) n++;
          }
          next = n === 1 || n === 2 ? HEAD : COND;
        }
        b[y0 + x] = next;
      }
    }

    this.a = b;
    this.b = a;
    this.generation++;
  }

  render(): RenderModel {
    return { kind: 'cells', width: this.width, height: this.height, data: this.a, palette: PALETTE };
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

/**
 * Stamp a 1-cell-wide rectangular conductor ring with its interior left empty,
 * then inject circulating electrons. A single electron is a head with a tail
 * immediately behind it; the tail keeps it travelling one way around the loop.
 * Both electrons run clockwise (top edge → right), half a lap apart, so they
 * never collide.
 */
export function stampRing(
  sim: WireworldSim,
  x0: number,
  y0: number,
  w: number,
  h: number,
  electrons: number,
): void {
  if (w < 5 || h < 5) return;
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  // Edges WITHOUT the four corners. The corners are left empty so the signal
  // turns each corner with a single clean diagonal step; a literal 1-wide
  // orthogonal corner would couple diagonally (the cell before the corner is a
  // Moore-neighbour of the cell after it) and shred the electron into a mess.
  for (let x = x0 + 1; x <= x1 - 1; x++) {
    sim.set(x, y0, COND);
    sim.set(x, y1, COND);
  }
  for (let y = y0 + 1; y <= y1 - 1; y++) {
    sim.set(x0, y, COND);
    sim.set(x1, y, COND);
  }
  // Electron 1: on the top edge, head ahead of (right of) its tail → clockwise.
  sim.set(x0 + 1, y0, TAIL);
  sim.set(x0 + 2, y0, HEAD);
  if (electrons >= 2) {
    // Electron 2: on the bottom edge, head left of its tail → also clockwise,
    // half a lap away, so the two never collide.
    sim.set(x1 - 1, y1, TAIL);
    sim.set(x1 - 2, y1, HEAD);
  }
}

/** Tile the canvas with a tidy 3×2 grid of rings, each isolated by a margin so
 *  no two wires touch (diagonal coupling would corrupt the signals). */
function stampLoops(sim: WireworldSim, W: number, H: number): void {
  const cols = 3;
  const rows = 2;
  const cw = Math.floor(W / cols);
  const ch = Math.floor(H / rows);
  const margin = Math.max(2, Math.floor(Math.min(cw, ch) * 0.14));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cw + margin;
      const y0 = r * ch + margin;
      const w = cw - margin * 2;
      const h = ch - margin * 2;
      // Alternate one/two electrons so the loops beat against each other.
      stampRing(sim, x0, y0, w, h, (c + r) % 2 === 0 ? 2 : 1);
    }
  }
}

export const wireworldSystem: SystemDef = {
  id: 'wireworld',
  name: 'Wireworld',
  tagline: 'Electrons racing through logic circuits',
  description:
    "Brian Silverman's Wireworld: a four-state automaton tuned for building digital " +
    'logic. Conductors are wire; an electron is a head followed by a tail, and a wire ' +
    'cell turns into a head only when 1 or 2 of its neighbours are heads — so pulses ' +
    'travel one way and never smear. Loops oscillate forever; with diodes and gates you ' +
    'can wire up real circuitry. Paint conductor, then drop a head to fire a pulse.',
  category: 'classic',
  renderKind: 'cells',
  brushStates: STATES,
  brushColors: Array.from(PALETTE, (v) => rgbaToCss(v)),
  params: [
    { kind: 'int', key: 'width', label: 'Width', min: 24, max: 320, step: 1, default: 160 },
    { kind: 'int', key: 'height', label: 'Height', min: 24, max: 240, step: 1, default: 110 },
    { kind: 'bool', key: 'wrap', label: 'Wrap edges', default: false },
  ],
  presets: [
    { id: 'loops', label: 'Oscillating loops' },
    { id: 'empty', label: 'Empty board' },
  ],
  create(params: Params, _seed: number, preset?: string): Simulation {
    const width = numParam(params, 'width', 160);
    const height = numParam(params, 'height', 110);
    const wrap = boolParam(params, 'wrap', false);
    const sim = new WireworldSim(width, height, wrap);
    switch (preset) {
      case 'empty':
        break;
      case 'loops':
      default:
        stampLoops(sim, width, height);
        break;
    }
    return sim;
  },
};
