import { describe, it, expect } from 'vitest';
import { particleLifeSystem, ParticleLifeSim, force, buildMatrix } from '../src/systems/particle-life';
import { mulberry32 } from '../src/core/prng';

function run(seed: number, steps: number, preset?: string): ParticleLifeSim {
  const sim = particleLifeSystem.create(
    { world: 320, count: 600, species: 5, rmax: 55, beta: 0.3, force: 1, friction: 0.85, dt: 0.4 },
    seed,
    preset,
  ) as ParticleLifeSim;
  for (let i = 0; i < steps; i++) sim.step();
  return sim;
}

describe('force law', () => {
  it('is zero at or beyond rmax (r >= 1)', () => {
    expect(force(1, 0.3, 1)).toBe(0);
    expect(force(1.5, 0.3, -1)).toBe(0);
  });

  it('is repulsive (negative) inside the beta core, independent of the matrix', () => {
    // Within r < beta the force is r/beta - 1 regardless of attraction value.
    expect(force(0, 0.3, 1)).toBe(-1); // strongest repulsion at the centre
    expect(force(0.15, 0.3, 1)).toBeCloseTo(0.15 / 0.3 - 1, 12);
    expect(force(0.15, 0.3, -1)).toBeCloseTo(0.15 / 0.3 - 1, 12);
  });

  it('peaks at the matrix value in the middle of the attraction ramp', () => {
    // The triangular ramp peaks where |2r-1-beta| = 0, i.e. r = (1+beta)/2.
    const beta = 0.3;
    const peakR = (1 + beta) / 2;
    expect(force(peakR, beta, 0.8)).toBeCloseTo(0.8, 12);
    expect(force(peakR, beta, -0.5)).toBeCloseTo(-0.5, 12);
  });
});

describe('matrix generation', () => {
  it('produces a k×k matrix with all values in [-1,1]', () => {
    const m = buildMatrix(mulberry32(7), 5, 'random');
    expect(m.length).toBe(25);
    for (const v of m) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });

  it('clusters preset gives positive self-attraction on the diagonal', () => {
    const k = 4;
    const m = buildMatrix(mulberry32(99), k, 'clusters');
    for (let i = 0; i < k; i++) expect(m[i * k + i]).toBeGreaterThan(0);
  });

  it('is deterministic for a given seed', () => {
    const a = buildMatrix(mulberry32(3), 6, 'random');
    const b = buildMatrix(mulberry32(3), 6, 'random');
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('Particle Life — known outcome: bounds invariant', () => {
  it('every particle stays inside [0, world) after stepping', () => {
    const world = 320;
    const sim = run(20260620, 60);
    const model = sim.render();
    if (model.kind !== 'particles') throw new Error('expected particles model');
    expect(model.count).toBe(600);
    for (let i = 0; i < model.count; i++) {
      const x = model.xs[i]!;
      const y = model.ys[i]!;
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(world);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(world);
    }
  });

  it('holds for every preset', () => {
    for (const preset of ['random', 'clusters', 'chase']) {
      const sim = run(42, 60, preset);
      const model = sim.render();
      if (model.kind !== 'particles') throw new Error('expected particles model');
      for (let i = 0; i < model.count; i++) {
        expect(model.xs[i]!).toBeGreaterThanOrEqual(0);
        expect(model.xs[i]!).toBeLessThan(320);
        expect(model.ys[i]!).toBeGreaterThanOrEqual(0);
        expect(model.ys[i]!).toBeLessThan(320);
      }
    }
  });
});

describe('Particle Life — determinism', () => {
  it('same seed + steps yields the same hash', () => {
    expect(run(123, 60).hash()).toBe(run(123, 60).hash());
  });

  it('different seeds diverge', () => {
    expect(run(1, 60).hash()).not.toBe(run(2, 60).hash());
  });

  it('hash changes as the simulation advances', () => {
    const a = run(5, 10).hash();
    const b = run(5, 40).hash();
    expect(a).not.toBe(b);
  });
});

describe('Particle Life — paint and clear keep count fixed', () => {
  it('paint relocates particles and sets their species without changing count', () => {
    const sim = run(8, 5);
    const before = sim.render();
    if (before.kind !== 'particles') throw new Error('expected particles model');
    const startCount = before.count;
    sim.paint({ x: 100, y: 100, value: 2, radius: 5 });
    const after = sim.render();
    if (after.kind !== 'particles') throw new Error('expected particles model');
    expect(after.count).toBe(startCount);
    // At least one particle now sits exactly on the cursor with species 2.
    let found = false;
    for (let i = 0; i < after.count; i++) {
      if (after.xs[i] === 100 && after.ys[i] === 100 && after.species[i] === 2) found = true;
    }
    expect(found).toBe(true);
  });

  it('clear re-randomises to the construction state deterministically', () => {
    const sim = run(77, 0); // fresh, no steps
    const fresh = sim.hash();
    for (let i = 0; i < 30; i++) sim.step();
    expect(sim.hash()).not.toBe(fresh);
    sim.clear();
    expect(sim.hash()).toBe(fresh);
    expect(sim.generation).toBe(0);
  });
});
