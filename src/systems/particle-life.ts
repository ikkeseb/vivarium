import type { PaintInfo, Params, RenderModel, Simulation, SystemDef } from '../core/types';
import { numParam, rgba, strParam } from '../core/types';
import { hashParts } from '../core/hash';
import { mulberry32, randRange } from '../core/prng';

// ─────────────────────────────────────────────────────────────────────────────
// Particle Life — coloured species drifting in a continuous toroidal world,
// pushed around by a per-species attraction/repulsion matrix. Each particle
// feels a short-range universal repulsion (so they never collapse to a point)
// plus a medium-range force whose sign and strength come from M[mine][theirs].
// Asymmetric matrices produce chasing, clustering, membranes and "cells".
//
// Performance: a uniform spatial grid (cell size >= rmax) restricts each
// particle's neighbour search to the 3×3 surrounding cells (toroidal), keeping
// the per-step cost ~O(N) instead of O(N²). The bins are rebuilt every step.
// ─────────────────────────────────────────────────────────────────────────────

const BACKGROUND = rgba(6, 8, 12);
const PARTICLE_RADIUS = 2.2;

/** Wrap a coordinate into [0, size) for a toroidal world. */
function wrap(v: number, size: number): number {
  // v can be moderately out of range after one integration step; a single
  // modulo (with the +size correction for negatives) is enough and branch-light.
  let r = v % size;
  if (r < 0) r += size;
  return r;
}

/** Smallest signed delta a-b on a periodic axis of the given size. */
function toroidalDelta(a: number, b: number, size: number): number {
  let d = a - b;
  if (d > size * 0.5) d -= size;
  else if (d < -size * 0.5) d += size;
  return d;
}

/**
 * Build the k×k force matrix M (values in [-1,1]) from the seed. The preset
 * biases the *structure* of the matrix but every value still comes from the
 * same deterministic stream, so seed alone reproduces the run.
 *
 *  - 'clusters'        : strong self-attraction on the diagonal → blobs per species.
 *  - 'chase'           : cyclic predator chains (i chases i+1, flees i-1).
 *  - 'random'/default  : fully random matrix.
 */
export function buildMatrix(
  rng: () => number,
  k: number,
  preset: string | undefined,
): Float32Array {
  const m = new Float32Array(k * k);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      let v = randRange(rng, -1, 1);
      if (preset === 'clusters') {
        // Diagonal pulls a species toward itself; off-diagonal mildly repels.
        v = i === j ? 0.5 + 0.5 * rng() : -0.4 * rng();
      } else if (preset === 'chase') {
        // Cyclic chains: attract the next species, repel the previous one.
        if (j === (i + 1) % k) v = 0.6 + 0.4 * rng();
        else if (j === (i + k - 1) % k) v = -(0.6 + 0.4 * rng());
        else v = randRange(rng, -0.3, 0.3);
      }
      m[i * k + j] = v;
    }
  }
  return m;
}

/**
 * Pure force law for an ordered interaction (a particle of species `si`
 * affected by a neighbour of species `sj`). `r` is the normalised distance
 * d/rmax in [0,1). Exported so the known-outcome can be checked in isolation.
 */
export function force(r: number, beta: number, attraction: number): number {
  if (r >= 1) return 0;
  if (r < beta) return r / beta - 1; // universal short-range repulsion
  return attraction * (1 - Math.abs(2 * r - 1 - beta) / (1 - beta));
}

/** k visually-distinct hues around the wheel, returned as packed RGBA. */
function buildPalette(k: number): Uint32Array {
  const pal = new Uint32Array(k);
  for (let i = 0; i < k; i++) pal[i] = hueToRgba((i / k) * 360);
  return pal;
}

/** k CSS colours matching the render palette (for brush swatches). */
function buildBrushColors(k: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < k; i++) {
    const v = hueToRgba((i / k) * 360);
    const rr = v & 0xff;
    const gg = (v >>> 8) & 0xff;
    const bb = (v >>> 16) & 0xff;
    out.push(`rgb(${rr},${gg},${bb})`);
  }
  return out;
}

/** Fully-saturated, bright HSV→RGBA at the given hue (S=0.85, V=1). */
function hueToRgba(hue: number): number {
  const h = (hue % 360) / 60;
  const s = 0.85;
  const v = 1;
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const mm = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) {
    r = c;
    g = x;
  } else if (h < 2) {
    r = x;
    g = c;
  } else if (h < 3) {
    g = c;
    b = x;
  } else if (h < 4) {
    g = x;
    b = c;
  } else if (h < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return rgba(
    Math.round((r + mm) * 255),
    Math.round((g + mm) * 255),
    Math.round((b + mm) * 255),
  );
}

export class ParticleLifeSim implements Simulation {
  // The renderer treats the world as `width × height`; for Particle Life the
  // world is square (`world × world`), so both equal the world size.
  readonly width: number;
  readonly height: number;
  generation = 0;

  private readonly world: number;
  private readonly count: number;
  private readonly k: number;
  private readonly rmax: number;
  private readonly beta: number;
  private readonly forceFactor: number;
  private readonly friction: number;
  private readonly dt: number;
  private readonly seed: number;

  // Persistent state buffers (never reallocated after construction).
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private readonly vxs: Float32Array;
  private readonly vys: Float32Array;
  private readonly species: Uint8Array;
  private readonly matrix: Float32Array;
  private readonly palette: Uint32Array;

  // Uniform spatial grid (rebuilt each step).
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellSize: number;
  private readonly cellStart: Int32Array; // length cols*rows+1, CSR-style offsets
  private readonly cellCount: Int32Array; // scratch counters, length cols*rows
  private readonly order: Int32Array; // particle indices sorted by cell
  // Scratch for de-duplicating the 3×3 neighbour cells when the grid is tiny
  // (cols/rows < 3): toroidal wrap would otherwise visit a cell twice and
  // double-count its particles' forces. At most 9 distinct cells per particle.
  private readonly seenCells = new Int32Array(9);

  constructor(
    world: number,
    count: number,
    species: number,
    rmax: number,
    beta: number,
    forceFactor: number,
    friction: number,
    dt: number,
    seed: number,
    preset: string | undefined,
  ) {
    this.world = world;
    this.width = world;
    this.height = world;
    this.count = count;
    this.k = species;
    this.rmax = rmax;
    this.beta = beta;
    this.forceFactor = forceFactor;
    this.friction = friction;
    this.dt = dt;
    this.seed = seed;

    const rng = mulberry32(seed);
    // Matrix first so positions are seeded from a deterministic, fixed point in
    // the stream regardless of k (k affects matrix length but the order is set).
    this.matrix = buildMatrix(rng, this.k, preset);

    this.xs = new Float32Array(count);
    this.ys = new Float32Array(count);
    this.vxs = new Float32Array(count);
    this.vys = new Float32Array(count);
    this.species = new Uint8Array(count);
    this.seedParticles(rng);

    this.palette = buildPalette(this.k);

    // Grid: at least one cell, cell size >= rmax so a 3×3 search covers rmax.
    this.cols = Math.max(1, Math.floor(world / rmax));
    this.rows = this.cols;
    this.cellSize = world / this.cols;
    const cells = this.cols * this.rows;
    this.cellStart = new Int32Array(cells + 1);
    this.cellCount = new Int32Array(cells);
    this.order = new Int32Array(count);
  }

  /** Lay out particles with random positions, zero velocity, random species. */
  private seedParticles(rng: () => number): void {
    const w = this.world;
    for (let i = 0; i < this.count; i++) {
      this.xs[i] = rng() * w;
      this.ys[i] = rng() * w;
      this.vxs[i] = 0;
      this.vys[i] = 0;
      this.species[i] = Math.floor(rng() * this.k) % this.k;
    }
  }

  /** Re-randomise positions/velocities/species from the original seed. */
  clear(): void {
    // Re-consume the matrix span first so particle layout matches construction.
    const rng = mulberry32(this.seed);
    for (let i = 0; i < this.k * this.k; i++) rng();
    this.seedParticles(rng);
    this.generation = 0;
  }

  private cellIndex(x: number, y: number): number {
    let cx = Math.floor(x / this.cellSize);
    let cy = Math.floor(y / this.cellSize);
    if (cx >= this.cols) cx = this.cols - 1;
    if (cy >= this.rows) cy = this.rows - 1;
    if (cx < 0) cx = 0;
    if (cy < 0) cy = 0;
    return cy * this.cols + cx;
  }

  /** Rebuild the CSR bins (cellStart offsets + order array) for this frame. */
  private rebuildGrid(): void {
    const cells = this.cols * this.rows;
    this.cellCount.fill(0);
    for (let i = 0; i < this.count; i++) {
      this.cellCount[this.cellIndex(this.xs[i]!, this.ys[i]!)]!++;
    }
    // Prefix-sum the counts into start offsets.
    let acc = 0;
    for (let c = 0; c < cells; c++) {
      this.cellStart[c] = acc;
      acc += this.cellCount[c]!;
    }
    this.cellStart[cells] = acc;
    // Scatter particle indices into `order`, using cellCount as a cursor.
    this.cellCount.fill(0);
    for (let i = 0; i < this.count; i++) {
      const c = this.cellIndex(this.xs[i]!, this.ys[i]!);
      this.order[this.cellStart[c]! + this.cellCount[c]!] = i;
      this.cellCount[c]!++;
    }
  }

  step(): void {
    this.rebuildGrid();

    const {
      xs,
      ys,
      vxs,
      vys,
      species,
      matrix,
      world,
      rmax,
      beta,
      forceFactor,
      friction,
      dt,
      cols,
      rows,
      cellStart,
      order,
      k,
    } = this;
    const invRmax = 1 / rmax;

    for (let i = 0; i < this.count; i++) {
      const xi = xs[i]!;
      const yi = ys[i]!;
      const si = species[i]! * k;
      let ax = 0;
      let ay = 0;

      const cx = Math.min(cols - 1, Math.max(0, Math.floor(xi / this.cellSize)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor(yi / this.cellSize)));

      // Scan the 3×3 block of cells around particle i, wrapping toroidally.
      // De-duplicate cells so a tiny grid (cols/rows < 3) never counts a
      // neighbour cell more than once.
      const seen = this.seenCells;
      let seenN = 0;
      for (let oy = -1; oy <= 1; oy++) {
        let ny = cy + oy;
        if (ny < 0) ny += rows;
        else if (ny >= rows) ny -= rows;
        for (let ox = -1; ox <= 1; ox++) {
          let nx = cx + ox;
          if (nx < 0) nx += cols;
          else if (nx >= cols) nx -= cols;
          const cell = ny * cols + nx;
          let dup = false;
          for (let s = 0; s < seenN; s++) {
            if (seen[s] === cell) {
              dup = true;
              break;
            }
          }
          if (dup) continue;
          seen[seenN++] = cell;
          const begin = cellStart[cell]!;
          const end = cellStart[cell + 1]!;
          for (let p = begin; p < end; p++) {
            const j = order[p]!;
            if (j === i) continue;
            const dx = toroidalDelta(xs[j]!, xi, world);
            const dy = toroidalDelta(ys[j]!, yi, world);
            const d2 = dx * dx + dy * dy;
            if (d2 <= 0) continue;
            const d = Math.sqrt(d2);
            const r = d * invRmax;
            if (r >= 1) continue;
            const f = force(r, beta, matrix[si + species[j]!]!);
            const inv = f / d;
            ax += dx * inv;
            ay += dy * inv;
          }
        }
      }

      ax *= forceFactor;
      ay *= forceFactor;
      // Semi-implicit Euler with velocity damping.
      const nvx = vxs[i]! * friction + ax * dt;
      const nvy = vys[i]! * friction + ay * dt;
      vxs[i] = nvx;
      vys[i] = nvy;
      xs[i] = wrap(xi + nvx * dt, world);
      ys[i] = wrap(yi + nvy * dt, world);
    }

    this.generation++;
  }

  render(): RenderModel {
    return {
      kind: 'particles',
      width: this.width,
      height: this.height,
      count: this.count,
      xs: this.xs,
      ys: this.ys,
      species: this.species,
      palette: this.palette,
      radius: PARTICLE_RADIUS,
      background: BACKGROUND,
    };
  }

  hash(): string {
    // Fold positions, velocities and generation. Count is fixed, so equal
    // seeds + equal steps reproduce the same fingerprint.
    return hashParts([this.xs, this.ys, this.vxs, this.vys, this.generation]);
  }

  /**
   * Painting relocates the few particles nearest the cursor onto it and recolours
   * them to `info.value`. Choosing existing particles (rather than spawning new
   * ones) keeps `count` — and therefore the hash layout — stable, while still
   * letting the user seed a species cluster wherever they click.
   */
  paint(info: PaintInfo): void {
    const target = ((info.value % this.k) + this.k) % this.k;
    // How many particles to grab scales with brush radius (at least one).
    const grab = Math.max(1, Math.min(this.count, Math.round(info.radius)));
    // Find the `grab` nearest particles by toroidal distance (small grab → cheap).
    const best: number[] = [];
    const bestD: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const dx = toroidalDelta(this.xs[i]!, info.x, this.world);
      const dy = toroidalDelta(this.ys[i]!, info.y, this.world);
      const d2 = dx * dx + dy * dy;
      // Insert into the small sorted shortlist if it beats the current worst.
      if (best.length < grab) {
        best.push(i);
        bestD.push(d2);
      } else {
        let worst = 0;
        for (let s = 1; s < best.length; s++) if (bestD[s]! > bestD[worst]!) worst = s;
        if (d2 < bestD[worst]!) {
          best[worst] = i;
          bestD[worst] = d2;
        }
      }
    }
    for (const i of best) {
      this.xs[i] = info.x;
      this.ys[i] = info.y;
      this.vxs[i] = 0;
      this.vys[i] = 0;
      this.species[i] = target;
    }
  }
}

export const particleLifeSystem: SystemDef = {
  id: 'particle-life',
  name: 'Particle Life',
  tagline: 'Emergent life from coloured forces',
  description:
    'Thousands of coloured particles in a wrap-around world, governed only by a ' +
    'per-species attraction/repulsion matrix and a universal short-range repulsion. ' +
    'From these two rules emerge cells, membranes, predators and self-replicating ' +
    'blobs — life-like structure with no biology at all. Tweak the matrix via the ' +
    'seed, or paint a species cluster onto the canvas.',
  category: 'particles',
  renderKind: 'particles',
  brushStates: 5,
  brushColors: buildBrushColors(5),
  params: [
    { kind: 'int', key: 'species', label: 'Species', min: 2, max: 8, step: 1, default: 5 },
    { kind: 'int', key: 'count', label: 'Particles', min: 100, max: 2500, step: 50, default: 1200 },
    { kind: 'int', key: 'world', label: 'World size', min: 120, max: 600, step: 10, default: 320 },
    {
      kind: 'float',
      key: 'rmax',
      label: 'Interaction radius',
      min: 10,
      max: 120,
      step: 1,
      default: 55,
      help: 'How far a particle reaches when feeling forces.',
    },
    {
      kind: 'float',
      key: 'beta',
      label: 'Repulsion core beta',
      min: 0.05,
      max: 0.9,
      step: 0.01,
      default: 0.3,
      help: 'Fraction of the radius that is hard short-range repulsion.',
    },
    { kind: 'float', key: 'force', label: 'Force factor', min: 0.1, max: 5, step: 0.1, default: 1 },
    {
      kind: 'float',
      key: 'friction',
      label: 'Velocity damping',
      min: 0,
      max: 0.99,
      step: 0.01,
      default: 0.85,
      help: 'Velocity retained each step (lower = thicker medium).',
    },
    { kind: 'float', key: 'dt', label: 'Time step', min: 0.05, max: 1, step: 0.05, default: 0.4 },
  ],
  presets: [
    { id: 'random', label: 'Random matrix' },
    { id: 'clusters', label: 'Clusters' },
    { id: 'chase', label: 'Predator chains' },
  ],
  create(params: Params, seed: number, preset?: string): Simulation {
    const world = numParam(params, 'world', 320);
    const count = numParam(params, 'count', 1200);
    const species = numParam(params, 'species', 5);
    const rmax = numParam(params, 'rmax', 55);
    const beta = numParam(params, 'beta', 0.3);
    const forceFactor = numParam(params, 'force', 1);
    const friction = numParam(params, 'friction', 0.85);
    const dt = numParam(params, 'dt', 0.4);
    // `preset` arrives via the 3rd arg; tolerate it as a param too for safety.
    const chosen = preset ?? (strParam(params, 'preset', 'random') || undefined);
    return new ParticleLifeSim(
      world,
      count,
      species,
      rmax,
      beta,
      forceFactor,
      friction,
      dt,
      seed,
      chosen,
    );
  },
};
