import { describe, it, expect } from 'vitest';
import { LangtonSim, parseRule, applyTurn, Turn, langtonSystem } from '../src/systems/langton';

// Collect the set of cells whose colour is non-zero, as "x,y" keys.
function nonZeroCells(sim: LangtonSim): Set<string> {
  const out = new Set<string>();
  const data = sim.cells;
  for (let y = 0; y < sim.height; y++) {
    for (let x = 0; x < sim.width; x++) {
      if (data[y * sim.width + x]) out.add(`${x},${y}`);
    }
  }
  return out;
}

describe('rule parsing', () => {
  it('parses RL into Right then Left', () => {
    expect(parseRule('RL')).toEqual([Turn.Right, Turn.Left]);
  });
  it('supports L/R/U/N and ignores junk', () => {
    expect(parseRule('LRUN')).toEqual([Turn.Left, Turn.Right, Turn.UTurn, Turn.None]);
    expect(parseRule('r l')).toEqual([Turn.Right, Turn.Left]);
  });
  it('falls back to RL on empty/invalid input', () => {
    expect(parseRule('')).toEqual([Turn.Right, Turn.Left]);
    expect(parseRule('xyz')).toEqual([Turn.Right, Turn.Left]);
  });
  it('applies turns correctly from North (dir 0)', () => {
    expect(applyTurn(0, Turn.Right)).toBe(1); // East
    expect(applyTurn(0, Turn.Left)).toBe(3); // West
    expect(applyTurn(0, Turn.UTurn)).toBe(2); // South
    expect(applyTurn(0, Turn.None)).toBe(0); // North
  });
});

describe("Langton's ant — known outcome (RL, 4 steps)", () => {
  it('returns to start facing North with a 2x2 block set', () => {
    const W = 9;
    const H = 9;
    const x0 = 4;
    const y0 = 4;
    // Single ant, classic "RL", all-zero grid, start at centre facing North.
    const sim = new LangtonSim(W, H, parseRule('RL'), 1, true, 'center', 12345);

    // Sanity: starts at (x0,y0) facing North on an empty grid.
    expect(sim.ant(0)).toEqual({ x: x0, y: y0, dir: 0 });
    expect(nonZeroCells(sim).size).toBe(0);

    for (let i = 0; i < 4; i++) sim.step();

    // Ant back at start, facing North again.
    expect(sim.ant(0)).toEqual({ x: x0, y: y0, dir: 0 });

    // Exactly these four cells (a 2x2 block extending East and South) are colour 1.
    const expected = new Set([`${x0},${y0}`, `${x0 + 1},${y0}`, `${x0 + 1},${y0 + 1}`, `${x0},${y0 + 1}`]);
    expect(nonZeroCells(sim)).toEqual(expected);

    // And every one of those cells is precisely colour 1 (black/on).
    expect(sim.cells[y0 * W + x0]).toBe(1);
    expect(sim.cells[y0 * W + (x0 + 1)]).toBe(1);
    expect(sim.cells[(y0 + 1) * W + (x0 + 1)]).toBe(1);
    expect(sim.cells[(y0 + 1) * W + x0]).toBe(1);
  });
});

describe("Langton's ant — determinism", () => {
  const run = (seed: number): string => {
    const sim = langtonSystem.create(
      { rule: 'RL', width: 80, height: 60, ants: 6, wrap: true, start: 'random' },
      seed,
    ) as LangtonSim;
    for (let i = 0; i < 300; i++) sim.step();
    return sim.hash();
  };

  it('same seed + 300 steps yields the same hash', () => {
    expect(run(20260620)).toBe(run(20260620));
  });

  it('different seeds diverge', () => {
    expect(run(1)).not.toBe(run(2));
  });
});