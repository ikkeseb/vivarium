import type { Params, PaintInfo, RenderModel, Simulation, SystemDef } from '../core/types';
import { numParam, strParam } from '../core/types';
import { hashParts } from '../core/hash';
import { mulberry32 } from '../core/prng';
import { DEFAULT_COLORMAP } from '../render/colormaps';

// ─────────────────────────────────────────────────────────────────────────────
// Lenia — a continuous cellular automaton (Bert Wang-Chak Chan, 2018).
//
// Instead of discrete dead/alive cells, the world is a smooth scalar field
// A(x) ∈ [0,1] on a toroidal grid. Each step convolves A with a radial kernel K
// to get a local "potential" U, runs U through a bell-shaped growth function G,
// and integrates the result with time step 1/T:
//
//     U(x)   = Σ K(d) · A(x + offset)        (normalised kernel, centre excluded)
//     A_new  = clamp( A + (1/T)·G(U), 0, 1 )
//     G(u)   = 2·exp( -(u-mu)² / (2σ²) ) - 1
//
// With the right parameters this supports self-organising, gliding "creatures"
// (the famous Orbium). The convolution is computed directly, O(W·H·|kernel|), so
// the default grid is kept modest.
// ─────────────────────────────────────────────────────────────────────────────

/** A single precomputed kernel tap: a grid offset and its normalised weight. */
interface KernelTap {
  dx: number;
  dy: number;
  w: number;
}

/**
 * Smooth "bump" kernel core, exported for unit testing. For r in (0,1) returns
 * exp(4 - 4/(4·r·(1-r))); it is 0 at the endpoints and outside (0,1). The peak
 * sits at r = 0.5 where the value is exactly 1.
 */
export function kernelCore(r: number): number {
  if (r <= 0 || r >= 1) return 0;
  return Math.exp(4 - 4 / (4 * r * (1 - r)));
}

/** Bell-shaped growth mapping U → (-1, 1]. Exported for unit testing. */
export function growth(u: number, mu: number, sigma: number): number {
  const d = u - mu;
  return 2 * Math.exp(-(d * d) / (2 * sigma * sigma)) - 1;
}

/**
 * Build the normalised radial kernel as a flat list of taps. All grid cells with
 * euclidean distance d satisfying 0 < d/R < 1 are included (the centre and the
 * r >= 1 ring are excluded); weights are normalised to sum to 1.
 */
export function buildKernel(R: number): KernelTap[] {
  const taps: KernelTap[] = [];
  let sum = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx === 0 && dy === 0) continue; // exclude centre
      const d = Math.sqrt(dx * dx + dy * dy);
      const r = d / R;
      const w = kernelCore(r);
      if (w > 0) {
        taps.push({ dx, dy, w });
        sum += w;
      }
    }
  }
  // Normalise so the weights sum to exactly 1 (guards a degenerate empty kernel).
  if (sum > 0) {
    for (const t of taps) t.w /= sum;
  }
  return taps;
}

export class LeniaSim implements Simulation {
  readonly width: number;
  readonly height: number;
  generation = 0;

  private readonly R: number;
  private readonly invT: number;
  private readonly mu: number;
  private readonly sigma: number;

  // Double-buffered field plus the precomputed kernel taps.
  private a: Float32Array;
  private b: Float32Array;
  private readonly taps: KernelTap[];

  constructor(width: number, height: number, R: number, T: number, mu: number, sigma: number) {
    this.width = width;
    this.height = height;
    this.R = R;
    this.invT = 1 / T;
    this.mu = mu;
    this.sigma = sigma;
    this.a = new Float32Array(width * height);
    this.b = new Float32Array(width * height);
    this.taps = buildKernel(R); // kernel built ONCE
  }

  /** Read access to the current field buffer (used by tests). */
  get field(): Float32Array {
    return this.a;
  }

  step(): void {
    const W = this.width;
    const H = this.height;
    const a = this.a;
    const b = this.b;
    const taps = this.taps;
    const n = taps.length;
    const invT = this.invT;
    const mu = this.mu;
    const sigma = this.sigma;
    const twoSigma2 = 2 * sigma * sigma;

    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        // Convolve A with the normalised kernel (toroidal wrap).
        let u = 0;
        for (let k = 0; k < n; k++) {
          const t = taps[k]!;
          let nx = x + t.dx;
          let ny = y + t.dy;
          // Wrap into [0,W) / [0,H). Offsets are at most R << size, so a single
          // additive/subtractive wrap is sufficient.
          if (nx < 0) nx += W;
          else if (nx >= W) nx -= W;
          if (ny < 0) ny += H;
          else if (ny >= H) ny -= H;
          u += t.w * a[ny * W + nx]!;
        }
        // Growth + Euler integration, clamped to [0,1].
        const d = u - mu;
        const g = 2 * Math.exp(-(d * d) / twoSigma2) - 1;
        let next = a[row + x]! + invT * g;
        if (next < 0) next = 0;
        else if (next > 1) next = 1;
        b[row + x] = next;
      }
    }

    // Swap buffers.
    this.a = b;
    this.b = a;
    this.generation++;
  }

  render(): RenderModel {
    return { kind: 'field', width: this.width, height: this.height, data: this.a, colormap: DEFAULT_COLORMAP };
  }

  hash(): string {
    return hashParts([this.a, this.generation]);
  }

  /**
   * Add (or erase) a soft gaussian bump. value > 0 adds intensity (scaled by
   * value, clamped to 1); value === 0 erases (sets the disc to 0).
   */
  paint(info: PaintInfo): void {
    const W = this.width;
    const H = this.height;
    const cx = info.x;
    const cy = info.y;
    const radius = Math.max(1, info.radius);
    const r = Math.ceil(radius);
    const amp = info.value > 0 ? Math.min(1, info.value) : 0;
    const erase = info.value === 0;
    const twoR2 = 2 * radius * radius;
    const cxi = Math.round(cx);
    const cyi = Math.round(cy);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        let nx = cxi + dx;
        let ny = cyi + dy;
        if (nx < 0) nx += W;
        else if (nx >= W) nx -= W;
        if (ny < 0) ny += H;
        else if (ny >= H) ny -= H;
        const idx = ny * W + nx;
        if (erase) {
          this.a[idx] = 0;
        } else {
          const bump = amp * Math.exp(-d2 / twoR2);
          const v = this.a[idx]! + bump;
          this.a[idx] = v > 1 ? 1 : v;
        }
      }
    }
  }

  clear(): void {
    this.a.fill(0);
    this.generation = 0;
  }

  /** Fill the field with several seeded smooth gaussian blobs. */
  seedRandom(seed: number, density: number): void {
    const rng = mulberry32(seed);
    const W = this.width;
    const H = this.height;
    this.a.fill(0);
    if (density <= 0) return;
    // Scale blob count with grid area and the requested density.
    const blobs = Math.max(1, Math.round((density * W * H) / 350));
    for (let i = 0; i < blobs; i++) {
      const cx = rng() * W;
      const cy = rng() * H;
      const rad = this.R * (0.6 + 1.4 * rng());
      const amp = 0.4 + 0.6 * rng();
      const twoR2 = 2 * rad * rad;
      const ri = Math.ceil(rad);
      const cxi = Math.round(cx);
      const cyi = Math.round(cy);
      for (let dy = -ri; dy <= ri; dy++) {
        for (let dx = -ri; dx <= ri; dx++) {
          const d2 = dx * dx + dy * dy;
          if (d2 > ri * ri) continue;
          let nx = cxi + dx;
          let ny = cyi + dy;
          if (nx < 0) nx += W;
          else if (nx >= W) nx -= W;
          if (ny < 0) ny += H;
          else if (ny >= H) ny -= H;
          const idx = ny * W + nx;
          const v = this.a[idx]! + amp * Math.exp(-d2 / twoR2);
          this.a[idx] = v > 1 ? 1 : v;
        }
      }
    }
  }

  /** Place a single rounded Orbium-ish blob near centre-left. */
  seedOrbium(): void {
    const W = this.width;
    const H = this.height;
    this.a.fill(0);
    const cx = Math.round(W * 0.35);
    const cy = Math.round(H * 0.5);
    const rad = this.R * 1.1;
    const twoR2 = 2 * rad * rad;
    const ri = Math.ceil(rad);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > ri * ri) continue;
        let nx = cx + dx;
        let ny = cy + dy;
        if (nx < 0) nx += W;
        else if (nx >= W) nx -= W;
        if (ny < 0) ny += H;
        else if (ny >= H) ny -= H;
        this.a[ny * W + nx] = Math.exp(-d2 / twoR2);
      }
    }
  }
}

export const leniaSystem: SystemDef = {
  id: 'lenia',
  name: 'Lenia',
  tagline: 'Smooth, continuous life',
  description:
    'Lenia generalises the Game of Life to a continuous scalar field. Each cell holds a ' +
    'real value in [0,1]; a smooth radial kernel and a bell-shaped growth function replace ' +
    "Conway's integer neighbour counts. The result is fluid, organic structure — and, with " +
    'the right parameters, self-propelling "creatures" such as the Orbium glider.',
  category: 'continuous',
  params: [
    { kind: 'int', key: 'width', label: 'Width', min: 48, max: 200, step: 1, default: 120 },
    { kind: 'int', key: 'height', label: 'Height', min: 48, max: 200, step: 1, default: 120 },
    { kind: 'int', key: 'R', label: 'Kernel radius', min: 4, max: 18, step: 1, default: 13 },
    { kind: 'float', key: 'T', label: 'Time scale T', min: 1, max: 30, step: 0.5, default: 10 },
    { kind: 'float', key: 'mu', label: 'Growth centre mu', min: 0, max: 0.5, step: 0.001, default: 0.15 },
    {
      kind: 'float',
      key: 'sigma',
      label: 'Growth width sigma',
      min: 0.001,
      max: 0.1,
      step: 0.001,
      default: 0.017,
    },
    {
      kind: 'float',
      key: 'density',
      label: 'Seed density',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.36,
      help: 'Blob coverage used by the Random soup preset.',
    },
  ],
  presets: [
    { id: 'random', label: 'Random soup' },
    { id: 'orbium', label: 'Orbium (glider attempt)' },
    { id: 'empty', label: 'Empty' },
  ],
  create(params: Params, seed: number, preset?: string): Simulation {
    const width = numParam(params, 'width', 120);
    const height = numParam(params, 'height', 120);
    const R = numParam(params, 'R', 13);
    const T = numParam(params, 'T', 10);
    const mu = numParam(params, 'mu', 0.15);
    const sigma = numParam(params, 'sigma', 0.017);
    const density = numParam(params, 'density', 0.36);
    // strParam touch keeps the preset string canonical even if passed via params.
    const chosen = preset ?? strParam(params, 'preset', 'random');

    const sim = new LeniaSim(width, height, R, T, mu, sigma);
    switch (chosen) {
      case 'empty':
        break;
      case 'orbium':
        sim.seedOrbium();
        break;
      case 'random':
      default:
        sim.seedRandom(seed, density);
        break;
    }
    return sim;
  },
};
