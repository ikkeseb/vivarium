import { describe, it, expect } from 'vitest';
import {
  COLORMAPS,
  DEFAULT_COLORMAP,
  DEFAULT_COLORMAP_ID,
  colormapLut,
  isColormapId,
} from '../src/render/colormaps';
import { rgba } from '../src/core/types';

// The historic dark→teal→mint→white ramp, recomputed exactly as lenia /
// reaction–diffusion shipped it before the LUTs were factored out. The default
// colormap MUST stay byte-identical so existing thumbnails and permalinks render
// the same pixels they always did.
function legacyTeal(): Uint32Array {
  const cm = new Uint32Array(256);
  const stops = [
    { t: 0.0, r: 6, g: 9, b: 14 },
    { t: 0.35, r: 14, g: 64, b: 82 },
    { t: 0.7, r: 60, g: 200, b: 168 },
    { t: 1.0, r: 232, g: 255, b: 244 },
  ];
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let lo = stops[0]!;
    let hi = stops[stops.length - 1]!;
    for (let s = 0; s < stops.length - 1; s++) {
      const a = stops[s]!;
      const b = stops[s + 1]!;
      if (v >= a.t && v <= b.t) {
        lo = a;
        hi = b;
        break;
      }
    }
    const span = hi.t - lo.t || 1;
    const f = (v - lo.t) / span;
    cm[i] = rgba(
      Math.round(lo.r + (hi.r - lo.r) * f),
      Math.round(lo.g + (hi.g - lo.g) * f),
      Math.round(lo.b + (hi.b - lo.b) * f),
    );
  }
  return cm;
}

describe('colormaps', () => {
  it('default "teal" LUT is byte-identical to the historic ramp', () => {
    const legacy = legacyTeal();
    expect(DEFAULT_COLORMAP.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(DEFAULT_COLORMAP[i]).toBe(legacy[i]);
  });

  it('every colormap has a full 256-entry LUT with unique ids', () => {
    const ids = new Set<string>();
    for (const c of COLORMAPS) {
      expect(c.lut.length).toBe(256);
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
    }
    expect(ids.has(DEFAULT_COLORMAP_ID)).toBe(true);
  });

  it('isColormapId recognises known ids and rejects junk', () => {
    expect(isColormapId(DEFAULT_COLORMAP_ID)).toBe(true);
    expect(isColormapId('viridis')).toBe(true);
    expect(isColormapId('not-a-map')).toBe(false);
    expect(isColormapId('')).toBe(false);
  });

  it('colormapLut resolves known ids and falls back to the default', () => {
    expect(colormapLut('viridis')).toBe(COLORMAPS.find((c) => c.id === 'viridis')!.lut);
    expect(colormapLut(undefined)).toBe(DEFAULT_COLORMAP);
    expect(colormapLut('bogus')).toBe(DEFAULT_COLORMAP);
  });
});
