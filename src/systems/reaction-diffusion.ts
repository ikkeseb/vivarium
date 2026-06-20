import type { Params, PaintInfo, RenderModel, Simulation, SystemDef } from '../core/types';
import { numParam, strParam } from '../core/types';
import { hashParts } from '../core/hash';
import { mulberry32 } from '../core/prng';
import { DEFAULT_COLORMAP } from '../render/colormaps';

// ─────────────────────────────────────────────────────────────────────────────
// Gray–Scott reaction–diffusion (Pearson, 1993).
//
// Two interleaved chemical fields U and V live on a toroidal grid. U is fed in
// from outside and consumed by the reaction U + 2V → 3V; V decays back to inert
// product. Each cell integrates the coupled PDEs with an explicit Euler step:
//
//     U' = U + (Du·∇²U − U·V² + f·(1 − U))·dt
//     V' = V + (Dv·∇²V + U·V² − (f + k)·V)·dt
//
// The Laplacian ∇² is a 3×3 stencil with orthogonal weight 0.2, diagonal 0.05
// and centre −1.0 (so a flat field has zero Laplacian), sampled with wrap-around
// at the edges. Despite the trivial kinetics, sweeping the feed rate f and kill
// rate k carves out a zoo of regimes — mitosis, coral, spots, worms, waves —
// the patterns Turing predicted in 1952.
//
// Computation is O(W·H) with double-buffered Float32 fields; nothing is
// allocated per step or per frame.
// ─────────────────────────────────────────────────────────────────────────────

/** Laplacian stencil weights (orthogonal, diagonal, centre); sums to 0. */
const LAP_ORTHO = 0.2;
const LAP_DIAG = 0.05;
const LAP_CENTRE = -1.0;

/** Fixed integration time step. The kinetics above are tuned for dt = 1. */
const DT = 1.0;

/**
 * Discrete 3×3 Laplacian of a field at (x,y) with toroidal wrap. Exported for
 * unit testing: on a constant field this is exactly 0 (the weights sum to zero).
 */
export function laplacian(field: Float32Array, W: number, H: number, x: number, y: number): number {
  let xm = x - 1;
  let xp = x + 1;
  let ym = y - 1;
  let yp = y + 1;
  if (xm < 0) xm += W;
  if (xp >= W) xp -= W;
  if (ym < 0) ym += H;
  if (yp >= H) yp -= H;
  const c = field[y * W + x]!;
  const orth = field[y * W + xm]! + field[y * W + xp]! + field[ym * W + x]! + field[yp * W + x]!;
  const diag = field[ym * W + xm]! + field[ym * W + xp]! + field[yp * W + xm]! + field[yp * W + xp]!;
  return LAP_ORTHO * orth + LAP_DIAG * diag + LAP_CENTRE * c;
}

/**
 * One Gray–Scott update for a single cell, given the local concentrations and
 * the precomputed Laplacians. Exported so the kinetics can be unit-tested in
 * isolation. Returns the next [U, V] pair (unclamped; V is clamped on store).
 */
export function reactStep(
  u: number,
  v: number,
  lapU: number,
  lapV: number,
  du: number,
  dv: number,
  f: number,
  k: number,
): [number, number] {
  const uvv = u * v * v;
  const nu = u + (du * lapU - uvv + f * (1 - u)) * DT;
  const nv = v + (dv * lapV + uvv - (f + k) * v) * DT;
  return [nu, nv];
}

export class ReactionDiffusionSim implements Simulation {
  readonly width: number;
  readonly height: number;
  generation = 0;

  private readonly du: number;
  private readonly dv: number;
  private readonly f: number;
  private readonly k: number;

  // Double-buffered concentration fields; swapped each step.
  private u: Float32Array;
  private v: Float32Array;
  private uNext: Float32Array;
  private vNext: Float32Array;

  // Persistent render model + its field buffer, reused every frame.
  private readonly fieldData: Float32Array;
  private readonly model: RenderModel;

  constructor(width: number, height: number, du: number, dv: number, f: number, k: number) {
    this.width = width;
    this.height = height;
    this.du = du;
    this.dv = dv;
    this.f = f;
    this.k = k;
    const n = width * height;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.uNext = new Float32Array(n);
    this.vNext = new Float32Array(n);
    this.fieldData = new Float32Array(n);
    this.model = { kind: 'field', width, height, data: this.fieldData, colormap: DEFAULT_COLORMAP };
    // Quiescent ground state: U saturated, V absent.
    this.u.fill(1);
    this.v.fill(0);
  }

  /** Read access to the current V field buffer (used by tests). */
  get fieldV(): Float32Array {
    return this.v;
  }

  /** Read access to the current U field buffer (used by tests). */
  get fieldU(): Float32Array {
    return this.u;
  }

  step(): void {
    const W = this.width;
    const H = this.height;
    const u = this.u;
    const v = this.v;
    const un = this.uNext;
    const vn = this.vNext;
    const du = this.du;
    const dv = this.dv;
    const f = this.f;
    const k = this.k;

    for (let y = 0; y < H; y++) {
      const ym = y === 0 ? H - 1 : y - 1;
      const yp = y === H - 1 ? 0 : y + 1;
      const row = y * W;
      const rowUp = ym * W;
      const rowDn = yp * W;
      for (let x = 0; x < W; x++) {
        const xm = x === 0 ? W - 1 : x - 1;
        const xp = x === W - 1 ? 0 : x + 1;

        const cu = u[row + x]!;
        const cv = v[row + x]!;

        // 3×3 Laplacian (orthogonal 0.2, diagonal 0.05, centre −1.0), toroidal.
        const lapU =
          LAP_ORTHO * (u[row + xm]! + u[row + xp]! + u[rowUp + x]! + u[rowDn + x]!) +
          LAP_DIAG * (u[rowUp + xm]! + u[rowUp + xp]! + u[rowDn + xm]! + u[rowDn + xp]!) +
          LAP_CENTRE * cu;
        const lapV =
          LAP_ORTHO * (v[row + xm]! + v[row + xp]! + v[rowUp + x]! + v[rowDn + x]!) +
          LAP_DIAG * (v[rowUp + xm]! + v[rowUp + xp]! + v[rowDn + xm]! + v[rowDn + xp]!) +
          LAP_CENTRE * cv;

        const uvv = cu * cv * cv;
        let nu = cu + (du * lapU - uvv + f * (1 - cu)) * DT;
        let nv = cv + (dv * lapV + uvv - (f + k) * cv) * DT;
        // Clamp to the physical concentration range to keep things finite.
        if (nu < 0) nu = 0;
        else if (nu > 1) nu = 1;
        if (nv < 0) nv = 0;
        else if (nv > 1) nv = 1;
        un[row + x] = nu;
        vn[row + x] = nv;
      }
    }

    // Swap buffers.
    this.u = un;
    this.v = vn;
    this.uNext = u;
    this.vNext = v;
    this.generation++;
  }

  render(): RenderModel {
    // Copy V (already ~[0,1]) into the persistent field buffer, clamped.
    const v = this.v;
    const out = this.fieldData;
    for (let i = 0; i < v.length; i++) {
      const x = v[i]!;
      out[i] = x < 0 ? 0 : x > 1 ? 1 : x;
    }
    return this.model;
  }

  hash(): string {
    // Quantise V to bytes so the fingerprint is stable across platforms, then
    // fold the generation counter in alongside it.
    const v = this.v;
    const q = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const x = v[i]!;
      const c = x < 0 ? 0 : x > 1 ? 1 : x;
      q[i] = (c * 255 + 0.5) | 0;
    }
    return hashParts([q, this.generation]);
  }

  /**
   * Stamp (or erase) V in a disc. value > 0 injects V≈0.5·value and drops U to
   * ≈0.25 inside the disc — the seed condition that kicks off a reaction front.
   * value === 0 erases back to the quiescent ground state (U=1, V=0).
   */
  paint(info: PaintInfo): void {
    const W = this.width;
    const H = this.height;
    const radius = Math.max(1, info.radius);
    const r = Math.ceil(radius);
    const r2 = r * r;
    const erase = info.value === 0;
    const amp = info.value > 0 ? Math.min(1, info.value) : 0;
    const cxi = Math.round(info.x);
    const cyi = Math.round(info.y);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        let nx = cxi + dx;
        let ny = cyi + dy;
        if (nx < 0) nx += W;
        else if (nx >= W) nx -= W;
        if (ny < 0) ny += H;
        else if (ny >= H) ny -= H;
        const idx = ny * W + nx;
        if (erase) {
          this.u[idx] = 1;
          this.v[idx] = 0;
        } else {
          this.u[idx] = 0.25;
          this.v[idx] = 0.5 * amp;
        }
      }
    }
  }

  /** Reset to the quiescent ground state (U=1, V=0) without changing size. */
  clear(): void {
    this.u.fill(1);
    this.v.fill(0);
    this.generation = 0;
  }

  /**
   * Seed the quiescent field with a handful of small square V blobs at seeded
   * positions. Inside each blob V≈0.5 and U≈0.25, the perturbation Gray–Scott
   * needs to nucleate a pattern.
   */
  seedBlobs(seed: number): void {
    const rng = mulberry32(seed);
    const W = this.width;
    const H = this.height;
    this.u.fill(1);
    this.v.fill(0);
    // Scale blob count gently with area; a few seeds are enough to fill a grid.
    const blobs = Math.max(3, Math.round((W * H) / 3500));
    for (let i = 0; i < blobs; i++) {
      const cx = Math.floor(rng() * W);
      const cy = Math.floor(rng() * H);
      const half = 3 + Math.floor(rng() * 6); // 3..8 → squares of side 7..17
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          let nx = cx + dx;
          let ny = cy + dy;
          if (nx < 0) nx += W;
          else if (nx >= W) nx -= W;
          if (ny < 0) ny += H;
          else if (ny >= H) ny -= H;
          const idx = ny * W + nx;
          this.u[idx] = 0.25;
          this.v[idx] = 0.5;
        }
      }
    }
  }
}

/** A named regime's optional parameter overrides. */
interface RdPreset {
  id: string;
  label: string;
  params?: Partial<{ feed: number; kill: number; du: number; dv: number }>;
}

/** Famous feed/kill regimes; Du/Dv kept at defaults unless a regime needs them. */
const PRESETS: RdPreset[] = [
  { id: 'mitosis', label: 'Mitosis', params: { feed: 0.0367, kill: 0.0649 } },
  { id: 'coral', label: 'Coral growth', params: { feed: 0.0545, kill: 0.062 } },
  { id: 'spots', label: 'Spots', params: { feed: 0.03, kill: 0.062 } },
  { id: 'worms', label: 'Worms', params: { feed: 0.054, kill: 0.063 } },
  // Waves want a higher V mobility to keep travelling fronts alive.
  { id: 'waves', label: 'Travelling waves', params: { feed: 0.014, kill: 0.045 } },
  { id: 'random', label: 'Random regime' },
];

export const reactionDiffusionSystem: SystemDef = {
  id: 'reaction-diffusion',
  name: 'Reaction–Diffusion',
  tagline: 'Turing patterns from two chemicals',
  description:
    'The Gray–Scott model couples two diffusing chemicals, U and V, through the autocatalytic ' +
    'reaction U + 2V → 3V. U is replenished at the feed rate f while V decays at the kill rate ' +
    'k; their interplay across a toroidal grid produces the self-organising spots, stripes, ' +
    'coral and dividing blobs that Alan Turing predicted as the basis of biological morphogenesis. ' +
    'Sweep f and k to roam between regimes, or paint seeds of V to nucleate your own fronts.',
  category: 'continuous',
  params: [
    { kind: 'int', key: 'width', label: 'Width', min: 64, max: 256, step: 1, default: 160 },
    { kind: 'int', key: 'height', label: 'Height', min: 64, max: 256, step: 1, default: 120 },
    {
      kind: 'float',
      key: 'feed',
      label: 'Feed rate f',
      min: 0.0,
      max: 0.11,
      step: 0.001,
      default: 0.06,
      help: 'Rate at which U is replenished. Higher f generally favours denser, busier patterns.',
    },
    {
      kind: 'float',
      key: 'kill',
      label: 'Kill rate k',
      min: 0.03,
      max: 0.07,
      step: 0.001,
      default: 0.062,
      help: 'Rate at which V is removed. The feed/kill ratio selects the pattern regime.',
    },
    {
      kind: 'float',
      key: 'du',
      label: 'U diffusion',
      min: 0.6,
      max: 1.0,
      step: 0.02,
      default: 1.0,
      help: 'Diffusion coefficient of the U chemical (typically ~2× that of V).',
    },
    {
      kind: 'float',
      key: 'dv',
      label: 'V diffusion',
      min: 0.2,
      max: 0.7,
      step: 0.02,
      default: 0.5,
      help: 'Diffusion coefficient of the V chemical.',
    },
  ],
  presets: PRESETS.map((p) => ({ id: p.id, label: p.label, params: p.params })),
  create(params: Params, seed: number, preset?: string): Simulation {
    const width = numParam(params, 'width', 160);
    const height = numParam(params, 'height', 120);
    let feed = numParam(params, 'feed', 0.06);
    let kill = numParam(params, 'kill', 0.062);
    const du = numParam(params, 'du', 1.0);
    const dv = numParam(params, 'dv', 0.5);
    // The regime's feed/kill arrive via `params` (the UI applies the preset and
    // a permalink encodes them), so params stay authoritative — manual slider
    // edits are respected. The preset name only selects special seeding below.
    const chosen = preset ?? strParam(params, 'preset', 'mitosis');

    if (chosen === 'random') {
      // Draw feed/kill from a sane band known to host interesting dynamics.
      const rng = mulberry32(seed);
      feed = 0.02 + 0.06 * rng(); // ~[0.02, 0.08]
      kill = 0.045 + 0.02 * rng(); // ~[0.045, 0.065]
    }

    const sim = new ReactionDiffusionSim(width, height, du, dv, feed, kill);
    sim.seedBlobs(seed);
    return sim;
  },
};
