import { describe, it, expect } from 'vitest';
import { SimHost } from '../src/sim/sim-host';
import {
  BufferPool,
  serializeModel,
  transferBuffersOf,
  MAX_STEPS_PER_FRAME,
} from '../src/sim/protocol';
import { getSystem } from '../src/core/registry';
import { defaultParams } from '../src/core/types';

// The worker hosts the exact same Simulation the determinism tests construct
// directly, so wrapping it in a SimHost must not perturb a single bit of state.
// These run synchronously in node — no real Worker — so the determinism contract
// is exercised through the worker's stepping path without any messaging.

const SEED = 12345;

function hostFor(id: string): SimHost {
  const sys = getSystem(id)!;
  return new SimHost(id, defaultParams(sys.params), SEED, sys.presets?.[0]?.id);
}

function directFor(id: string) {
  const sys = getSystem(id)!;
  return sys.create(defaultParams(sys.params), SEED, sys.presets?.[0]?.id);
}

describe('SimHost — determinism parity with a direct simulation', () => {
  it('advance(dt, sps) matches N direct steps, bit for bit', () => {
    const host = hostFor('conway');
    const direct = directFor('conway');
    // 0.1 s clamp × 250 sps = 25 steps (under the per-tick cap).
    expect(host.advance(0.1, 250)).toBe(25);
    for (let i = 0; i < 25; i++) direct.step();
    expect(host.generation).toBe(25);
    expect(host.hash()).toBe(direct.hash());
  });

  it('every registered system survives the host wrapper unchanged', () => {
    for (const sys of allIds()) {
      const host = hostFor(sys);
      const direct = directFor(sys);
      const steps = host.advance(0.1, 200); // 20 steps each
      for (let i = 0; i < steps; i++) direct.step();
      expect(host.hash(), sys).toBe(direct.hash());
      expect(host.generation, sys).toBe(steps);
    }
  });

  it('throws on an unknown system id', () => {
    expect(() => new SimHost('nope', {}, 1)).toThrow(/unknown system/);
  });
});

describe('SimHost.advance — accumulator semantics', () => {
  it('carries the fractional remainder across calls', () => {
    const host = hostFor('conway');
    // 0.1 × 5 = 0.5 steps per call: first call rounds down to 0, second crosses 1.
    expect(host.advance(0.1, 5)).toBe(0);
    expect(host.advance(0.1, 5)).toBe(1);
    expect(host.generation).toBe(1);
  });

  it('clamps a huge dt so a stall cannot over-step', () => {
    const host = hostFor('conway');
    // dt 100 s clamps to 0.1 s → 0.1 × 5 = 0.5 → 0 steps.
    expect(host.advance(100, 5)).toBe(0);
    expect(host.generation).toBe(0);
  });

  it('caps the per-tick step count', () => {
    const host = hostFor('conway');
    expect(host.advance(0.1, 100000)).toBe(MAX_STEPS_PER_FRAME);
    expect(host.generation).toBe(MAX_STEPS_PER_FRAME);
  });

  it('a negative dt is a no-op', () => {
    const host = hostFor('conway');
    expect(host.advance(-1, 100)).toBe(0);
  });
});

describe('SimHost — capabilities and clear', () => {
  it('reports paint/clear capabilities of the underlying sim', () => {
    const caps = hostFor('conway').caps();
    expect(caps.paint).toBe(true);
    expect(caps.clear).toBe(true);
  });

  it('clear() resets a clearable sim and reports it handled it', () => {
    const host = hostFor('conway');
    host.advance(0.1, 250);
    expect(host.generation).toBeGreaterThan(0);
    expect(host.clear()).toBe(true);
    expect(host.generation).toBe(0);
  });
});

describe('protocol — transfer serialization', () => {
  it('copies a cells model into independent buffers', () => {
    const host = hostFor('conway');
    host.advance(0.1, 100);
    const src = host.render();
    expect(src.kind).toBe('cells');
    const { model, transfer } = serializeModel(src, new BufferPool());
    if (model.kind !== 'cells' || src.kind !== 'cells') throw new Error('kind');
    expect(model.width).toBe(src.width);
    expect(model.height).toBe(src.height);
    expect(model.data.length).toBe(src.data.length);
    expect(Array.from(model.data)).toEqual(Array.from(src.data));
    // independent copy — not the sim's own buffer
    expect(model.data.buffer).not.toBe(src.data.buffer);
    expect(transfer).toEqual(transferBuffersOf(model));
  });

  it('drops the colormap from a field model (re-attached on the main thread)', () => {
    const host = hostFor('reaction-diffusion');
    host.advance(0.1, 50);
    const src = host.render();
    expect(src.kind).toBe('field');
    const { model } = serializeModel(src, new BufferPool());
    expect(model.kind).toBe('field');
    expect('colormap' in model).toBe(false);
    if (model.kind !== 'field' || src.kind !== 'field') throw new Error('kind');
    expect(Array.from(model.data)).toEqual(Array.from(src.data));
  });

  it('copies a particles model field by field', () => {
    const host = hostFor('particle-life');
    host.advance(0.1, 50);
    const src = host.render();
    expect(src.kind).toBe('particles');
    const { model, transfer } = serializeModel(src, new BufferPool());
    if (model.kind !== 'particles' || src.kind !== 'particles') throw new Error('kind');
    expect(model.count).toBe(src.count);
    expect(model.radius).toBe(src.radius);
    expect(model.background).toBe(src.background);
    expect(Array.from(model.xs)).toEqual(Array.from(src.xs.subarray(0, src.count)));
    expect(Array.from(model.species)).toEqual(Array.from(src.species.subarray(0, src.count)));
    expect(transfer.length).toBe(4);
  });
});

describe('protocol — BufferPool', () => {
  it('reuses a recycled buffer of matching byte length', () => {
    const pool = new BufferPool();
    const a = pool.take(256);
    pool.recycle([a]);
    expect(pool.take(256)).toBe(a); // same buffer back
    expect(pool.take(256)).not.toBe(a); // pool now empty → fresh
  });

  it('does not hand back a buffer of the wrong size', () => {
    const pool = new BufferPool();
    const a = pool.take(256);
    pool.recycle([a]);
    expect(pool.take(128)).not.toBe(a);
  });

  it('is bounded — recycling beyond the cap drops the surplus', () => {
    const pool = new BufferPool(2);
    pool.recycle([new ArrayBuffer(8), new ArrayBuffer(8), new ArrayBuffer(8)]);
    // only two fit; the third was dropped, so the third take() allocates fresh
    const a = pool.take(8);
    const b = pool.take(8);
    const c = pool.take(8);
    expect(a).not.toBe(b);
    expect([a, b]).not.toContain(c);
  });

  it('clear() empties the pool', () => {
    const pool = new BufferPool();
    const a = pool.take(64);
    pool.recycle([a]);
    pool.clear();
    expect(pool.take(64)).not.toBe(a);
  });
});

function allIds(): string[] {
  return [
    'conway',
    'life-rules',
    'generations',
    'cyclic',
    'elementary',
    'langton',
    'lenia',
    'reaction-diffusion',
    'particle-life',
  ];
}
