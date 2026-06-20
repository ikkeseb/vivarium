import type { PaintInfo, RenderModel, Simulation } from '../core/types';
import { rgba } from '../core/types';
import { hashParts } from '../core/hash';
import { mulberry32 } from '../core/prng';

// Shared engine for all 2-state, outer-totalistic "Life-like" cellular automata.
// A rule is birth/survival sets over neighbour counts 0..8. Conway, HighLife,
// Day & Night, Seeds, Replicator, … are all just different rules over this core.

export interface LifeRule {
  /** birth[n] === true means a dead cell with n live neighbours becomes alive. */
  birth: boolean[];
  /** survive[n] === true means a live cell with n live neighbours stays alive. */
  survive: boolean[];
}

/** Parse "B3/S23" (or the equivalent "23/3" survival/birth) into a LifeRule. */
export function parseRule(input: string): LifeRule {
  const birth = new Array<boolean>(9).fill(false);
  const survive = new Array<boolean>(9).fill(false);
  const s = input.toUpperCase().replace(/\s+/g, '');
  const bs = s.match(/^B([0-8]*)\/S([0-8]*)$/);
  if (bs) {
    for (const c of bs[1]!) birth[Number(c)] = true;
    for (const c of bs[2]!) survive[Number(c)] = true;
    return { birth, survive };
  }
  const sb = s.match(/^([0-8]*)\/([0-8]*)$/);
  if (sb) {
    for (const c of sb[1]!) survive[Number(c)] = true;
    for (const c of sb[2]!) birth[Number(c)] = true;
  }
  return { birth, survive };
}

export function formatRule(r: LifeRule): string {
  let b = '';
  let s = '';
  for (let i = 0; i <= 8; i++) {
    if (r.birth[i]) b += i;
    if (r.survive[i]) s += i;
  }
  return `B${b}/S${s}`;
}

const DEAD = rgba(8, 11, 17);
const ALIVE = rgba(94, 242, 196);

export class LifelikeSim implements Simulation {
  readonly width: number;
  readonly height: number;
  generation = 0;

  private a: Uint8Array;
  private b: Uint8Array;
  private rule: LifeRule;
  private wrap: boolean;
  private palette: Uint32Array;

  constructor(width: number, height: number, rule: LifeRule, wrap: boolean) {
    this.width = width;
    this.height = height;
    this.rule = rule;
    this.wrap = wrap;
    this.a = new Uint8Array(width * height);
    this.b = new Uint8Array(width * height);
    this.palette = new Uint32Array([DEAD, ALIVE]);
  }

  /** Direct access to the current generation buffer (read/write). */
  get cells(): Uint8Array {
    return this.a;
  }

  set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.a[y * this.width + x] = v ? 1 : 0;
  }

  randomFill(seed: number, density: number): void {
    const rng = mulberry32(seed);
    const a = this.a;
    for (let i = 0; i < a.length; i++) a[i] = rng() < density ? 1 : 0;
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
    const birth = this.rule.birth;
    const survive = this.rule.survive;
    const wrap = this.wrap;

    for (let y = 0; y < H; y++) {
      const y0 = y * W;
      const up = y > 0 ? y0 - W : wrap ? (H - 1) * W : -1;
      const dn = y < H - 1 ? y0 + W : wrap ? 0 : -1;
      for (let x = 0; x < W; x++) {
        const xl = x > 0 ? x - 1 : wrap ? W - 1 : -1;
        const xr = x < W - 1 ? x + 1 : wrap ? 0 : -1;
        let n = 0;
        if (up >= 0) {
          if (xl >= 0) n += a[up + xl]!;
          n += a[up + x]!;
          if (xr >= 0) n += a[up + xr]!;
        }
        if (xl >= 0) n += a[y0 + xl]!;
        if (xr >= 0) n += a[y0 + xr]!;
        if (dn >= 0) {
          if (xl >= 0) n += a[dn + xl]!;
          n += a[dn + x]!;
          if (xr >= 0) n += a[dn + xr]!;
        }
        const alive = a[y0 + x]!;
        b[y0 + x] = (alive ? survive[n] : birth[n]) ? 1 : 0;
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
    const v = info.value ? 1 : 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        this.set(cx + dx, cy + dy, v);
      }
    }
  }
}
