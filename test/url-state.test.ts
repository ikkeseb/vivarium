import { describe, it, expect } from 'vitest';
import { encodeUrlState, decodeUrlState } from '../src/ui/url-state';
import { getSystem, systems } from '../src/core/registry';

describe('url-state', () => {
  it('round-trips a full state through encode → decode', () => {
    const sys = systems[0]!;
    const state = {
      sys: sys.id,
      seed: 12345,
      sps: 30,
      preset: sys.presets?.[0]?.id,
      params: { ...defaultsOf(sys.id) },
    };
    const hash = encodeUrlState(state);
    const back = decodeUrlState(hash, getSystem);
    expect(back).not.toBeNull();
    expect(back!.sys).toBe(state.sys);
    expect(back!.seed).toBe(12345);
    expect(back!.sps).toBe(30);
    expect(back!.preset).toBe(state.preset);
  });

  it('returns null for an empty / system-less hash', () => {
    expect(decodeUrlState('', getSystem)).toBeNull();
    expect(decodeUrlState('#sps=10', getSystem)).toBeNull();
    expect(decodeUrlState('#sys=does-not-exist', getSystem)).toBeNull();
  });

  it('tolerates a leading "#" and url-encoding', () => {
    const hash = encodeUrlState({ sys: systems[0]!.id, seed: 7, sps: 15, params: {} });
    expect(decodeUrlState('#' + hash.replace(/^#/, ''), getSystem)!.seed).toBe(7);
  });

  it('coerces param values to their declared kinds', () => {
    // life-rules has a 'rule' string param; cyclic/lenia have numeric params.
    const lenia = getSystem('lenia');
    if (lenia) {
      const spec = lenia.params.find((p) => p.kind === 'int' || p.kind === 'float');
      if (spec) {
        const v = spec.default; // guaranteed in-range
        const state = { sys: 'lenia', seed: 1, sps: 15, params: { [spec.key]: v } };
        const back = decodeUrlState(encodeUrlState(state), getSystem)!;
        expect(typeof back.params[spec.key]).toBe('number');
        expect(back.params[spec.key]).toBe(v);
      }
    }
  });

  it('clamps out-of-range numeric params to the declared min/max', () => {
    const sys = systems.find((s) => s.params.some((p) => p.kind === 'int' || p.kind === 'float'));
    if (!sys) return;
    const spec = sys.params.find((p) => p.kind === 'int' || p.kind === 'float')! as {
      key: string;
      min: number;
      max: number;
    };
    const hash = `sys=${sys.id}&seed=1&sps=15&p.${spec.key}=999999`;
    const back = decodeUrlState(hash, getSystem)!;
    expect(back.params[spec.key]).toBeLessThanOrEqual(spec.max);
  });

  it('drops unknown params and falls back to defaults for missing ones', () => {
    const sys = systems[0]!;
    const back = decodeUrlState(`sys=${sys.id}&seed=2&sps=15&p.bogus=1`, getSystem)!;
    expect('bogus' in back.params).toBe(false);
  });

  it('round-trips a non-default colormap and omits the default from the URL', () => {
    const sys = getSystem('lenia')!;
    const base = { sys: sys.id, seed: 1, sps: 15, preset: undefined, params: {} };

    const withMap = encodeUrlState({ ...base, cm: 'viridis' });
    expect(withMap).toContain('cm=viridis');
    expect(decodeUrlState(withMap, getSystem)!.cm).toBe('viridis');

    // The default colormap is cosmetic noise — it must not bloat the permalink.
    const withDefault = encodeUrlState({ ...base, cm: 'teal' });
    expect(withDefault).not.toContain('cm=');
    expect(decodeUrlState(withDefault, getSystem)!.cm).toBeUndefined();
  });

  it('ignores an unknown colormap id', () => {
    const sys = systems[0]!;
    const back = decodeUrlState(`sys=${sys.id}&seed=1&sps=15&cm=not-a-map`, getSystem)!;
    expect(back.cm).toBeUndefined();
  });
});

function defaultsOf(id: string): Record<string, number | string | boolean> {
  const sys = getSystem(id)!;
  const out: Record<string, number | string | boolean> = {};
  for (const p of sys.params) out[p.key] = p.default;
  return out;
}
