import { describe, it, expect } from 'vitest';
import { LeniaSim, leniaSystem, kernelCore, growth, buildKernel } from '../src/systems/lenia';

function fieldStats(data: Float32Array): { min: number; max: number; sum: number } {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, sum };
}

describe('Lenia — kernel & growth helpers', () => {
  it('kernel core is 0 outside (0,1) and peaks at r=0.5', () => {
    expect(kernelCore(0)).toBe(0);
    expect(kernelCore(1)).toBe(0);
    expect(kernelCore(-0.2)).toBe(0);
    expect(kernelCore(1.5)).toBe(0);
    // Peak value is exactly 1 at the midpoint, and strictly less elsewhere.
    expect(kernelCore(0.5)).toBeCloseTo(1, 12);
    expect(kernelCore(0.25)).toBeLessThan(kernelCore(0.5));
    expect(kernelCore(0.75)).toBeLessThan(kernelCore(0.5));
  });

  it('kernel weights are normalised to sum to 1 and exclude the centre', () => {
    const taps = buildKernel(13);
    expect(taps.length).toBeGreaterThan(0);
    const sum = taps.reduce((acc, t) => acc + t.w, 0);
    expect(sum).toBeCloseTo(1, 10);
    // Centre tap (0,0) must never be present.
    expect(taps.some((t) => t.dx === 0 && t.dy === 0)).toBe(false);
  });

  it('growth at u=0 is strongly negative for the Orbium defaults', () => {
    // mu=0.15, sigma=0.017 => G(0) ≈ -1 (drives empty space to stay empty).
    expect(growth(0, 0.15, 0.017)).toBeLessThan(-0.99);
    // Growth peaks at u=mu with value +1.
    expect(growth(0.15, 0.15, 0.017)).toBeCloseTo(1, 12);
  });
});

describe('Lenia — known outcomes', () => {
  it('quiescence: an all-zero field stays all-zero', () => {
    const sim = leniaSystem.create({ width: 60, height: 60 }, 1, 'empty') as LeniaSim;
    for (let i = 0; i < 5; i++) sim.step();
    const { min, max, sum } = fieldStats(sim.field);
    expect(min).toBe(0);
    expect(max).toBe(0);
    expect(sum).toBe(0);
    // Every individual cell is exactly 0.
    for (let i = 0; i < sim.field.length; i++) expect(sim.field[i]).toBe(0);
  });

  it('a small blob stays within [0,1] for all cells over several steps', () => {
    const sim = new LeniaSim(80, 80, 13, 10, 0.15, 0.017);
    sim.seedOrbium();
    for (let i = 0; i < 8; i++) {
      sim.step();
      const { min, max } = fieldStats(sim.field);
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(1);
    }
  });

  it('paint adds intensity and clear zeroes the field', () => {
    const sim = new LeniaSim(60, 60, 13, 10, 0.15, 0.017);
    sim.paint({ x: 30, y: 30, value: 1, radius: 5 });
    expect(fieldStats(sim.field).sum).toBeGreaterThan(0);
    // Erase (value 0) removes the disc.
    sim.paint({ x: 30, y: 30, value: 0, radius: 6 });
    expect(sim.field[30 * 60 + 30]).toBe(0);
    sim.paint({ x: 30, y: 30, value: 1, radius: 5 });
    sim.clear();
    expect(fieldStats(sim.field).sum).toBe(0);
    expect(sim.generation).toBe(0);
  });

  it('render returns the field model referencing the live buffer with a 256-entry colormap', () => {
    const sim = new LeniaSim(48, 48, 13, 10, 0.15, 0.017);
    const model = sim.render();
    expect(model.kind).toBe('field');
    if (model.kind === 'field') {
      expect(model.colormap.length).toBe(256);
      expect(model.data).toBe(sim.field);
      // Background entry (v=0) is near-black.
      const bg = model.colormap[0]!;
      const r = bg & 0xff;
      const g = (bg >>> 8) & 0xff;
      const b = (bg >>> 16) & 0xff;
      expect(r + g + b).toBeLessThan(60);
    }
  });
});

describe('Lenia — determinism', () => {
  const run = (seed: number): string => {
    const sim = leniaSystem.create({ width: 72, height: 72 }, seed, 'random') as LeniaSim;
    for (let i = 0; i < 12; i++) sim.step();
    return sim.hash();
  };

  it('same seed + steps yields the same hash', () => {
    expect(run(20260620)).toBe(run(20260620));
  });

  it('different seeds diverge', () => {
    expect(run(1)).not.toBe(run(2));
  });
});
