import { describe, it, expect } from 'vitest';
import { LifelikeSim, parseRule, formatRule } from '../src/systems/lifelike-core';
import { PATTERNS, stamp } from '../src/systems/conway-patterns';
import { conwaySystem } from '../src/systems/conway';

function liveCells(sim: LifelikeSim): Set<string> {
  const out = new Set<string>();
  const data = sim.cells;
  for (let y = 0; y < sim.height; y++) {
    for (let x = 0; x < sim.width; x++) {
      if (data[y * sim.width + x]) out.add(`${x},${y}`);
    }
  }
  return out;
}

function shift(cells: Set<string>, dx: number, dy: number): Set<string> {
  const out = new Set<string>();
  for (const k of cells) {
    const [x, y] = k.split(',').map(Number) as [number, number];
    out.add(`${x + dx},${y + dy}`);
  }
  return out;
}

describe('rule parsing', () => {
  it('round-trips B3/S23', () => {
    expect(formatRule(parseRule('B3/S23'))).toBe('B3/S23');
  });
  it('accepts S/B notation', () => {
    expect(formatRule(parseRule('23/3'))).toBe('B3/S23');
  });
  it('parses HighLife and Day & Night', () => {
    expect(formatRule(parseRule('B36/S23'))).toBe('B36/S23');
    expect(formatRule(parseRule('B3678/S34678'))).toBe('B3678/S34678');
  });
});

describe("Conway's Life — known outcomes", () => {
  it('a glider returns to itself shifted by (1,1) after 4 generations', () => {
    const sim = new LifelikeSim(40, 40, parseRule('B3/S23'), false);
    stamp(sim, PATTERNS.glider, 12, 12);
    const before = liveCells(sim);
    expect(before.size).toBe(5);
    for (let i = 0; i < 4; i++) sim.step();
    expect(liveCells(sim)).toEqual(shift(before, 1, 1));
  });

  it('a block (still life) never changes', () => {
    const sim = new LifelikeSim(20, 20, parseRule('B3/S23'), true);
    stamp(sim, PATTERNS.block, 8, 8);
    const before = liveCells(sim);
    expect(before.size).toBe(4);
    for (let i = 0; i < 25; i++) sim.step();
    expect(liveCells(sim)).toEqual(before);
  });

  it('a beehive (still life) never changes', () => {
    const sim = new LifelikeSim(20, 20, parseRule('B3/S23'), true);
    stamp(sim, PATTERNS.beehive, 8, 8);
    const before = liveCells(sim);
    for (let i = 0; i < 25; i++) sim.step();
    expect(liveCells(sim)).toEqual(before);
  });

  it('a blinker oscillates with period 2', () => {
    const sim = new LifelikeSim(20, 20, parseRule('B3/S23'), true);
    stamp(sim, PATTERNS.blinker, 8, 8);
    const before = liveCells(sim);
    sim.step();
    expect(liveCells(sim)).not.toEqual(before);
    sim.step();
    expect(liveCells(sim)).toEqual(before);
  });

  it('the Gosper glider gun grows the population (emits gliders)', () => {
    const sim = conwaySystem.create({ width: 80, height: 60, wrap: false, density: 0 }, 1, 'gun') as LifelikeSim;
    const start = liveCells(sim).size;
    for (let i = 0; i < 120; i++) sim.step();
    expect(liveCells(sim).size).toBeGreaterThan(start);
  });
});

describe("Conway's Life — determinism", () => {
  const run = (seed: number): string => {
    const sim = new LifelikeSim(64, 64, parseRule('B3/S23'), true);
    sim.randomFill(seed, 0.3);
    for (let i = 0; i < 60; i++) sim.step();
    return sim.hash();
  };

  it('same seed + steps yields the same hash', () => {
    expect(run(20260620)).toBe(run(20260620));
  });

  it('different seeds diverge', () => {
    expect(run(1)).not.toBe(run(2));
  });
});
