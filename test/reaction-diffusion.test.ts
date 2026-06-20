import { describe, it, expect } from 'vitest';
import {
  ReactionDiffusionSim,
  reactionDiffusionSystem,
  laplacian,
  reactStep,
} from '../src/systems/reaction-diffusion';

function fieldStats(data: Float32Array): { min: number; max: number; sum: number; finite: boolean } {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let finite = true;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (!Number.isFinite(v)) finite = false;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, sum, finite };
}

describe('Reaction–Diffusion — kinetics helpers', () => {
  it('Laplacian of a flat field is exactly 0 everywhere (weights sum to 0)', () => {
    const W = 8;
    const H = 6;
    const flat = new Float32Array(W * H).fill(0.42);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        expect(laplacian(flat, W, H, x, y)).toBeCloseTo(0, 12);
      }
    }
  });

  it('Laplacian is positive at a single-cell dip and wraps toroidally', () => {
    const W = 5;
    const H = 5;
    const field = new Float32Array(W * H).fill(1);
    field[2 * W + 2] = 0; // a dip at the centre
    // Centre sees lower neighbours but a big positive contribution from −1·0.
    expect(laplacian(field, W, H, 2, 2)).toBeGreaterThan(0);
    // A corner cell still has 8 valid neighbours thanks to wrap (no NaN, finite).
    expect(Number.isFinite(laplacian(field, W, H, 0, 0))).toBe(true);
  });

  it('reactStep on the quiescent state (U=1, V=0) leaves U at 1 and V at 0', () => {
    const [nu, nv] = reactStep(1, 0, 0, 0, 0.16, 0.08, 0.06, 0.062);
    expect(nu).toBeCloseTo(1, 12);
    expect(nv).toBeCloseTo(0, 12);
  });

  it('reactStep grows V where U and V coexist (autocatalysis)', () => {
    // With both chemicals present the U·V² term should push V upward.
    const [, nv] = reactStep(0.5, 0.25, 0, 0, 0.16, 0.08, 0.037, 0.06);
    expect(nv).toBeGreaterThan(0.25);
  });
});

describe('Reaction–Diffusion — known outcomes', () => {
  it('quiescence: an unseeded field (U=1, V=0) stays quiescent', () => {
    const sim = new ReactionDiffusionSim(40, 40, 0.16, 0.08, 0.06, 0.062);
    for (let i = 0; i < 10; i++) sim.step();
    const v = fieldStats(sim.fieldV);
    const u = fieldStats(sim.fieldU);
    expect(v.max).toBe(0);
    expect(v.sum).toBe(0);
    // U feeds toward 1 and, starting exactly at 1, stays put.
    expect(u.min).toBeCloseTo(1, 6);
    expect(u.max).toBeCloseTo(1, 6);
  });

  it('a seeded blob stays finite and within [0,1] over many steps', () => {
    const sim = reactionDiffusionSystem.create(
      { width: 64, height: 64, feed: 0.0367, kill: 0.0649 },
      12345,
      'mitosis',
    ) as ReactionDiffusionSim;
    // The seed must actually introduce some V.
    expect(fieldStats(sim.fieldV).sum).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) {
      sim.step();
      const v = fieldStats(sim.fieldV);
      const u = fieldStats(sim.fieldU);
      expect(v.finite).toBe(true);
      expect(u.finite).toBe(true);
      expect(v.min).toBeGreaterThanOrEqual(0);
      expect(v.max).toBeLessThanOrEqual(1);
      expect(u.min).toBeGreaterThanOrEqual(0);
      expect(u.max).toBeLessThanOrEqual(1);
    }
    // The reaction should still be alive (some V present), not collapsed to 0.
    expect(fieldStats(sim.fieldV).sum).toBeGreaterThan(0);
  });

  it('a growing regime (coral) actually spreads — not frozen by weak diffusion', () => {
    // Regression guard: with mis-scaled diffusion the seeded blobs barely move and
    // the world stays frozen. With the correct Gray–Scott scaling the coral regime
    // colonises a large fraction of the grid. Count active V cells early vs late.
    const sim = reactionDiffusionSystem.create(
      { width: 96, height: 96, feed: 0.0545, kill: 0.062 },
      7,
      'coral',
    ) as ReactionDiffusionSim;
    const active = (d: Float32Array): number => {
      let n = 0;
      for (let i = 0; i < d.length; i++) if (d[i]! > 0.2) n++;
      return n;
    };
    for (let i = 0; i < 50; i++) sim.step();
    const early = active(sim.fieldV);
    for (let i = 0; i < 1500; i++) sim.step();
    const late = active(sim.fieldV);
    expect(early).toBeGreaterThan(0);
    // The front must expand well beyond the initial seed (frozen ⇒ ratio ≈ 1).
    expect(late).toBeGreaterThan(early * 3);
  });

  it('paint injects V and drops U; erase restores the ground state', () => {
    const sim = new ReactionDiffusionSim(50, 50, 0.16, 0.08, 0.06, 0.062);
    sim.paint({ x: 25, y: 25, value: 1, radius: 5 });
    expect(sim.fieldV[25 * 50 + 25]).toBeCloseTo(0.5, 6);
    expect(sim.fieldU[25 * 50 + 25]).toBeCloseTo(0.25, 6);
    // Erase (value 0) restores U=1, V=0 in the disc.
    sim.paint({ x: 25, y: 25, value: 0, radius: 6 });
    expect(sim.fieldV[25 * 50 + 25]).toBe(0);
    expect(sim.fieldU[25 * 50 + 25]).toBe(1);
  });

  it('clear resets to the quiescent ground state and zeroes generation', () => {
    const sim = new ReactionDiffusionSim(40, 40, 0.16, 0.08, 0.06, 0.062);
    sim.seedBlobs(7);
    sim.step();
    sim.clear();
    expect(fieldStats(sim.fieldV).sum).toBe(0);
    expect(fieldStats(sim.fieldU).min).toBe(1);
    expect(fieldStats(sim.fieldU).max).toBe(1);
    expect(sim.generation).toBe(0);
  });

  it('render returns a reused field model with a 256-entry colormap and clamped V', () => {
    const sim = new ReactionDiffusionSim(48, 48, 0.16, 0.08, 0.06, 0.062);
    const model = sim.render();
    expect(model.kind).toBe('field');
    if (model.kind === 'field') {
      expect(model.colormap.length).toBe(256);
      expect(model.data.length).toBe(48 * 48);
      // Background entry (v=0) is near-black.
      const bg = model.colormap[0]!;
      const r = bg & 0xff;
      const g = (bg >>> 8) & 0xff;
      const b = (bg >>> 16) & 0xff;
      expect(r + g + b).toBeLessThan(60);
    }
    // render() must return the same persistent object on subsequent calls.
    expect(sim.render()).toBe(model);
  });
});

describe('Reaction–Diffusion — determinism', () => {
  const run = (seed: number, preset = 'mitosis'): string => {
    const sim = reactionDiffusionSystem.create(
      { width: 72, height: 64 },
      seed,
      preset,
    ) as ReactionDiffusionSim;
    for (let i = 0; i < 20; i++) sim.step();
    return sim.hash();
  };

  it('same seed + params + steps yields the same hash', () => {
    expect(run(20260620)).toBe(run(20260620));
  });

  it('different seeds diverge', () => {
    expect(run(1)).not.toBe(run(2));
  });

  it('the random preset is itself deterministic per seed but varies by seed', () => {
    expect(run(42, 'random')).toBe(run(42, 'random'));
    expect(run(42, 'random')).not.toBe(run(43, 'random'));
  });
});
