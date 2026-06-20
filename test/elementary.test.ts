import { describe, it, expect } from 'vitest';
import { elementarySystem, elementaryRow } from '../src/systems/elementary';

// Read a slice of a row as a string of '0'/'1' for easy assertions.
function rowStr(row: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i <= to; i++) s += row[i] ? '1' : '0';
  return s;
}

describe('elementaryRow — Rule 30 known outcome', () => {
  it('matches the verified centre substrings from a single seed cell (wrap)', () => {
    const w = 21;
    const gen0 = new Uint8Array(w);
    gen0[10] = 1;

    // gen0 indices [8..12]
    expect(rowStr(gen0, 8, 12)).toBe('00100');

    const gen1 = elementaryRow(gen0, 30, true);
    expect(rowStr(gen1, 8, 12)).toBe('01110');

    const gen2 = elementaryRow(gen1, 30, true);
    expect(rowStr(gen2, 8, 12)).toBe('11001');

    const gen3 = elementaryRow(gen2, 30, true);
    expect(rowStr(gen3, 7, 13)).toBe('1101111');
  });
});

describe('elementaryRow — Rule 90 known outcome', () => {
  it('sets exactly the two neighbours of a single centre cell', () => {
    const w = 21;
    const gen0 = new Uint8Array(w);
    gen0[10] = 1;
    const gen1 = elementaryRow(gen0, 90, true);
    expect(gen1[9]).toBe(1);
    expect(gen1[10]).toBe(0);
    expect(gen1[11]).toBe(1);
  });
});

describe('elementaryRow — edge behaviour', () => {
  it('treats off-grid as 0 when wrap is false', () => {
    // Rule 90 = XOR of neighbours. A single cell at index 0:
    // non-wrap: cell 0 has left=0(off-grid), right=0 -> 0; cell 1 -> XOR(1,0)=1.
    const w = 5;
    const g0 = new Uint8Array(w);
    g0[0] = 1;
    const noWrap = elementaryRow(g0, 90, false);
    expect(rowStr(noWrap, 0, 4)).toBe('01000');
    // wrap: cell 0 left wraps to index 4 (=0), but cell 4 sees right=cell0=1.
    const wrap = elementaryRow(g0, 90, true);
    expect(wrap[1]).toBe(1);
    expect(wrap[4]).toBe(1);
  });
});

describe('elementarySystem — render & seeding', () => {
  it('renders cells with the newest generation on the bottom row', () => {
    const sim = elementarySystem.create(
      { rule: 30, width: 21, height: 10, wrap: true, init: 'single', density: 0.5 },
      1,
    );
    const r = sim.render();
    expect(r.kind).toBe('cells');
    if (r.kind !== 'cells') throw new Error('expected cells model');
    expect(r.width).toBe(21);
    expect(r.height).toBe(10);
    // Single-cell seed sits on the bottom row at the centre.
    const bottom = (r.height - 1) * r.width;
    expect(r.data[bottom + 10]).toBe(1);
    // Older (upper) rows are empty before stepping.
    expect(r.data[10]).toBe(0);
  });

  it('scrolls history upward as it steps', () => {
    const sim = elementarySystem.create(
      { rule: 30, width: 21, height: 10, wrap: true, init: 'single', density: 0.5 },
      1,
    );
    sim.step();
    const r = sim.render();
    if (r.kind !== 'cells') throw new Error('expected cells model');
    const w = r.width;
    // After one step the original seed row scrolled up one, and the new bottom
    // row is the Rule 30 successor (centre 3 cells set).
    const secondLast = (r.height - 2) * w;
    expect(r.data[secondLast + 10]).toBe(1); // old seed moved up
    const bottom = (r.height - 1) * w;
    expect(rowStr(r.data, bottom + 8, bottom + 12)).toBe('01110');
    expect(sim.generation).toBe(1);
  });
});

describe('elementarySystem — determinism', () => {
  it('same seed + N steps => identical hash', () => {
    const mk = () =>
      elementarySystem.create(
        { rule: 30, width: 64, height: 48, wrap: true, init: 'random', density: 0.5 },
        12345,
      );
    const a = mk();
    const b = mk();
    for (let i = 0; i < 80; i++) {
      a.step();
      b.step();
    }
    expect(a.hash()).toBe(b.hash());
  });

  it('different seeds => different hash', () => {
    const mk = (seed: number) =>
      elementarySystem.create(
        { rule: 30, width: 64, height: 48, wrap: true, init: 'random', density: 0.5 },
        seed,
      );
    const a = mk(1);
    const b = mk(2);
    for (let i = 0; i < 80; i++) {
      a.step();
      b.step();
    }
    expect(a.hash()).not.toBe(b.hash());
  });
});

describe('elementarySystem — paint & clear', () => {
  it('paint writes into the bottom/current row and clear resets', () => {
    const sim = elementarySystem.create(
      { rule: 30, width: 40, height: 12, wrap: true, init: 'single', density: 0.5 },
      7,
    );
    sim.paint?.({ x: 5, y: 0, value: 1, radius: 1 });
    const r = sim.render();
    if (r.kind !== 'cells') throw new Error('expected cells model');
    const bottom = (r.height - 1) * r.width;
    expect(r.data[bottom + 4]).toBe(1);
    expect(r.data[bottom + 5]).toBe(1);
    expect(r.data[bottom + 6]).toBe(1);

    sim.clear?.();
    const r2 = sim.render();
    if (r2.kind !== 'cells') throw new Error('expected cells model');
    expect(r2.data.every((v) => v === 0)).toBe(true);
    expect(sim.generation).toBe(0);
  });
});