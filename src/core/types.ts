// ─────────────────────────────────────────────────────────────────────────────
// vivarium core contract
//
// Every life system implements `SystemDef` (static metadata + a factory) and
// produces a `Simulation` (mutable state + deterministic `step`). The UI and the
// renderer only ever talk to these two interfaces, so systems stay fully
// self-contained and swappable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Packed RGBA, laid out so it can be written straight into a Uint32 view of an
 * ImageData buffer on little-endian platforms: byte order is R,G,B,A which reads
 * back as 0xAABBGGRR.
 */
export type RGBA = number;

export function rgba(r: number, g: number, b: number, a = 255): RGBA {
  return (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0;
}

/** Convert a packed RGBA value into a CSS `rgba(...)` string. */
export function rgbaToCss(v: RGBA): string {
  const r = v & 0xff;
  const g = (v >>> 8) & 0xff;
  const b = (v >>> 16) & 0xff;
  const a = (v >>> 24) & 0xff;
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}

// ── Parameter schema ─────────────────────────────────────────────────────────
// Declarative parameter descriptions; the UI renders a control per entry and
// passes the collected values back into `SystemDef.create`.

export interface IntParam {
  kind: 'int';
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  default: number;
  help?: string;
}

export interface FloatParam {
  kind: 'float';
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  help?: string;
}

export interface BoolParam {
  kind: 'bool';
  key: string;
  label: string;
  default: boolean;
  help?: string;
}

export interface SelectParam {
  kind: 'select';
  key: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  default: string;
  help?: string;
}

/** Free-text rule string, e.g. Life-like "B3/S23" or a turmite table. */
export interface RuleParam {
  kind: 'rule';
  key: string;
  label: string;
  default: string;
  placeholder?: string;
  help?: string;
}

export type ParamSpec = IntParam | FloatParam | BoolParam | SelectParam | RuleParam;

export type ParamValue = number | boolean | string;
export type Params = Record<string, ParamValue>;

// ── Render models ────────────────────────────────────────────────────────────
// Three render shapes cover every system. The renderer reads the typed arrays
// synchronously and copies them into the canvas, so simulations may (and should)
// return references to their own persistent buffers — zero allocation per frame.

/** A grid of discrete cell states indexed into a colour palette. */
export interface CellsModel {
  kind: 'cells';
  width: number;
  height: number;
  /** length === width*height, values in [0, palette.length) */
  data: Uint8Array;
  /** palette[state] -> packed RGBA */
  palette: Uint32Array;
}

/** A continuous scalar field in [0,1], mapped through a 256-entry colour LUT. */
export interface FieldModel {
  kind: 'field';
  width: number;
  height: number;
  /** length === width*height, values clamped to [0,1] when drawn */
  data: Float32Array;
  /** length 256, colormap[round(v*255)] -> packed RGBA */
  colormap: Uint32Array;
}

/** Free-floating points in a continuous world of size width×height. */
export interface ParticlesModel {
  kind: 'particles';
  width: number;
  height: number;
  count: number;
  xs: Float32Array;
  ys: Float32Array;
  /** species[i] indexes into palette */
  species: Uint8Array;
  palette: Uint32Array;
  radius: number;
  background: RGBA;
}

export type RenderModel = CellsModel | FieldModel | ParticlesModel;

// ── Painting ─────────────────────────────────────────────────────────────────

export interface PaintInfo {
  /** World coordinates: cell coords for grids, continuous coords for particles. */
  x: number;
  y: number;
  /** Brush value: the cell state / species to paint (0 usually erases). */
  value: number;
  /** Brush radius, in cells (grids) or world units (particles). */
  radius: number;
}

// ── Simulation + system definition ───────────────────────────────────────────

export interface Simulation {
  readonly width: number;
  readonly height: number;
  generation: number;
  /** Advance exactly one deterministic tick. */
  step(): void;
  /** Current render model (may reference internal buffers). */
  render(): RenderModel;
  /** Stable hash of the full state, for determinism tests. */
  hash(): string;
  /** Optional user painting. */
  paint?(info: PaintInfo): void;
  /** Optional: reset to the empty / quiescent state without changing size. */
  clear?(): void;
}

export interface Preset {
  id: string;
  label: string;
  /** Parameter overrides applied (and reflected in the UI) when selected. */
  params?: Partial<Params>;
}

export type SystemCategory = 'classic' | 'agent' | '1d' | 'continuous' | 'particles';

export interface SystemDef {
  id: string;
  name: string;
  /** Short one-line tagline shown in the gallery. */
  tagline: string;
  /** Longer prose description shown in the control panel. */
  description: string;
  category: SystemCategory;
  params: ReadonlyArray<ParamSpec>;
  presets?: ReadonlyArray<Preset>;
  /**
   * Build a fresh simulation. `preset` selects an initial configuration; when
   * omitted the system uses its default seeding (typically a seeded random fill).
   */
  create(params: Params, seed: number, preset?: string): Simulation;
  /** Number of distinct brush values (states/species); defaults to 2. */
  brushStates?: number;
  /** Optional CSS colours for the brush swatches, indexed by brush value. */
  brushColors?: ReadonlyArray<string>;
}

// ── Param helpers ────────────────────────────────────────────────────────────

export function defaultParams(specs: ReadonlyArray<ParamSpec>): Params {
  const out: Params = {};
  for (const s of specs) out[s.key] = s.default;
  return out;
}

export function numParam(p: Params, key: string, fallback = 0): number {
  const v = p[key];
  return typeof v === 'number' ? v : fallback;
}

export function boolParam(p: Params, key: string, fallback = false): boolean {
  const v = p[key];
  return typeof v === 'boolean' ? v : fallback;
}

export function strParam(p: Params, key: string, fallback = ''): string {
  const v = p[key];
  return typeof v === 'string' ? v : fallback;
}
