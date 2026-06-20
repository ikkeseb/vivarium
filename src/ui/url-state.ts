// ─────────────────────────────────────────────────────────────────────────────
// Shareable deterministic permalinks.
//
// Vivarium's whole premise is that "same seed + N steps ⇒ same hash". A URL that
// captures the full launch configuration — system, seed, preset, every parameter,
// and the playback speed — therefore reproduces a run exactly on any machine.
//
// The state lives in the URL *hash* (after `#`) so it never hits a server and
// works from a static bundle or a `file://` open. Encoding is plain
// `URLSearchParams`: `sys`, `seed`, `sps`, optional `preset`, and one `p.<key>`
// entry per parameter. Values are coerced back to their declared kinds on decode,
// clamped to the schema's range, so a hand-edited or stale link degrades safely
// instead of producing a NaN field.
// ─────────────────────────────────────────────────────────────────────────────

import type { Params, ParamValue, SystemDef } from '../core/types';
import { paramsForPreset } from '../core/types';
import { DEFAULT_COLORMAP_ID, isColormapId } from '../render/colormaps';

export interface UrlState {
  sys: string;
  seed: number;
  sps: number;
  preset?: string;
  params: Params;
  /** Cosmetic colormap id for field systems; omitted when it is the default. */
  cm?: string;
}

const PARAM_PREFIX = 'p.';

// Steps-per-second bounds — the single source of truth shared with the speed
// slider in app.ts. The codec clamps to the same ceiling the control can reach,
// so a hand-edited or stale permalink is always representable (and survives the
// first slider touch instead of being silently rewritten down to it).
export const SPS_MIN = 1;
export const SPS_MAX = 200;

export function encodeUrlState(state: UrlState): string {
  const q = new URLSearchParams();
  q.set('sys', state.sys);
  q.set('seed', String(state.seed));
  q.set('sps', String(state.sps));
  if (state.preset) q.set('preset', state.preset);
  // The colormap is purely cosmetic, so only non-default choices hit the URL —
  // default runs keep the tidy permalink they shipped with.
  if (state.cm && state.cm !== DEFAULT_COLORMAP_ID && isColormapId(state.cm)) {
    q.set('cm', state.cm);
  }
  for (const [k, v] of Object.entries(state.params)) {
    q.set(PARAM_PREFIX + k, encodeValue(v));
  }
  return q.toString();
}

export function decodeUrlState(
  hash: string,
  lookup: (id: string) => SystemDef | undefined,
): UrlState | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const sysId = q.get('sys');
  if (!sysId) return null;
  const sys = lookup(sysId);
  if (!sys) return null;

  const seed = toInt(q.get('seed'), 1);
  const sps = clamp(toInt(q.get('sps'), 15), SPS_MIN, SPS_MAX);

  const presetRaw = q.get('preset') ?? undefined;
  const preset =
    presetRaw && sys.presets?.some((p) => p.id === presetRaw) ? presetRaw : undefined;

  const cmRaw = q.get('cm') ?? undefined;
  const cm = cmRaw && isColormapId(cmRaw) ? cmRaw : undefined;

  // Baseline = defaults with the chosen preset applied; explicit URL params win.
  const baseline = paramsForPreset(sys, preset);
  const params: Params = {};
  for (const spec of sys.params) {
    const raw = q.get(PARAM_PREFIX + spec.key);
    params[spec.key] = raw == null ? baseline[spec.key]! : coerce(spec, raw);
  }

  return { sys: sysId, seed, sps, preset, params, cm };
}

function encodeValue(v: ParamValue): string {
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

function coerce(spec: SystemDef['params'][number], raw: string): ParamValue {
  switch (spec.kind) {
    case 'int':
    case 'float': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return spec.default;
      return clamp(n, spec.min, spec.max);
    }
    case 'bool':
      return raw === '1' || raw === 'true';
    case 'select':
      return spec.options.some((o) => o.value === raw) ? raw : spec.default;
    case 'rule':
      return raw;
  }
}

function toInt(raw: string | null, fallback: number): number {
  if (raw == null) return fallback;
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
