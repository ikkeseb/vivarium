// ─────────────────────────────────────────────────────────────────────────────
// Worker protocol: the wire format between the main thread (SimClient) and the
// simulation worker (sim-worker). The worker owns the live `Simulation` and does
// all the stepping off the main thread; each frame it copies the render model
// into transferable buffers and ships it back, so the UI never blocks on a step.
//
// Determinism is unaffected: the worker hosts the exact same seeded `Simulation`
// the tests construct directly, so "same seed + N steps ⇒ same hash" holds in or
// out of the worker. None of the cosmetic view state (colormap, zoom, pan) crosses
// this boundary — the field colormap is applied on the main thread after transfer.
// ─────────────────────────────────────────────────────────────────────────────

import type { PaintInfo, Params, RenderModel } from '../core/types';

/** Step cap per `run` tick, mirroring the old main-thread loop guard. */
export const MAX_STEPS_PER_FRAME = 240;

/**
 * A render model flattened for transfer. Identical to `RenderModel` except the
 * field variant drops its `colormap` — that LUT is cosmetic and chosen on the
 * main thread, so it is re-attached after transfer rather than shipped per frame.
 */
export type TransferModel =
  | { kind: 'cells'; width: number; height: number; data: Uint8Array; palette: Uint32Array }
  | { kind: 'field'; width: number; height: number; data: Float32Array }
  | {
      kind: 'particles';
      width: number;
      height: number;
      count: number;
      xs: Float32Array;
      ys: Float32Array;
      species: Uint8Array;
      palette: Uint32Array;
      radius: number;
      background: number;
    };

export interface SimCaps {
  paint: boolean;
  clear: boolean;
}

// ── main → worker ────────────────────────────────────────────────────────────

export type SimRequest =
  | { type: 'create'; epoch: number; sysId: string; params: Params; seed: number; preset?: string }
  | { type: 'run'; dt: number; sps: number }
  | { type: 'step' }
  | { type: 'paint'; info: PaintInfo }
  | { type: 'clear' }
  /** Return spent frame buffers so the worker can reuse them (zero steady-state alloc). */
  | { type: 'recycle'; buffers: ArrayBuffer[] };

// ── worker → main ────────────────────────────────────────────────────────────

export interface SimFrame {
  type: 'frame';
  /** Config generation; frames whose epoch is stale (a recreate happened) are dropped. */
  epoch: number;
  /**
   * True when this frame was produced by a `run` tick (vs paint/step/clear/create).
   * The main thread releases its one-tick run guard only on a run frame, so an
   * interleaved paint frame can't let a second run slip out while the first is
   * still computing.
   */
  fromRun: boolean;
  generation: number;
  hash: string;
  caps: SimCaps;
  model: TransferModel;
}

// ── transfer buffer pool ──────────────────────────────────────────────────────

/**
 * A tiny free-list of `ArrayBuffer`s keyed by byte length. The worker copies each
 * frame's render data into a pooled buffer and transfers it; the main thread ships
 * the spent buffers back via a `recycle` message. In steady state this means no
 * per-frame allocation — the same two buffer sets ping-pong across the boundary.
 */
export class BufferPool {
  private free: ArrayBuffer[] = [];
  private readonly cap: number;

  constructor(cap = 8) {
    this.cap = cap;
  }

  take(bytes: number): ArrayBuffer {
    for (let i = 0; i < this.free.length; i++) {
      if (this.free[i]!.byteLength === bytes) return this.free.splice(i, 1)[0]!;
    }
    return new ArrayBuffer(bytes);
  }

  recycle(buffers: ArrayBuffer[]): void {
    for (const b of buffers) {
      if (this.free.length >= this.cap) break;
      this.free.push(b);
    }
  }

  /** Drop everything — called when the model size/shape may have changed. */
  clear(): void {
    this.free.length = 0;
  }
}

/**
 * Copy a live `RenderModel` into a `TransferModel` backed by pooled buffers, and
 * return the transfer list. The source arrays are the simulation's own persistent
 * buffers (which it reuses next step), so a copy is mandatory — but it is a flat
 * `O(width·height)` memcpy, negligible beside the step it follows.
 */
export function serializeModel(
  m: RenderModel,
  pool: BufferPool,
): { model: TransferModel; transfer: ArrayBuffer[] } {
  if (m.kind === 'cells') {
    const data = new Uint8Array(pool.take(m.data.length));
    data.set(m.data);
    const palette = new Uint32Array(pool.take(m.palette.length * 4));
    palette.set(m.palette);
    return {
      model: { kind: 'cells', width: m.width, height: m.height, data, palette },
      transfer: [data.buffer, palette.buffer],
    };
  }
  if (m.kind === 'field') {
    const data = new Float32Array(pool.take(m.data.length * 4));
    data.set(m.data);
    return {
      model: { kind: 'field', width: m.width, height: m.height, data },
      transfer: [data.buffer],
    };
  }
  const n = m.count;
  const xs = new Float32Array(pool.take(n * 4));
  xs.set(m.xs.subarray(0, n));
  const ys = new Float32Array(pool.take(n * 4));
  ys.set(m.ys.subarray(0, n));
  const species = new Uint8Array(pool.take(n));
  species.set(m.species.subarray(0, n));
  const palette = new Uint32Array(pool.take(m.palette.length * 4));
  palette.set(m.palette);
  return {
    model: {
      kind: 'particles',
      width: m.width,
      height: m.height,
      count: n,
      xs,
      ys,
      species,
      palette,
      radius: m.radius,
      background: m.background,
    },
    transfer: [xs.buffer, ys.buffer, species.buffer, palette.buffer],
  };
}

/**
 * The transferable `ArrayBuffer`s backing a `TransferModel`, for recycling. The
 * casts are sound: every buffer here was allocated by `BufferPool` as a plain
 * `ArrayBuffer` (the typed-array `.buffer` type widens to `ArrayBufferLike`, but
 * we never create a `SharedArrayBuffer`).
 */
export function transferBuffersOf(m: TransferModel): ArrayBuffer[] {
  if (m.kind === 'cells') return [m.data.buffer as ArrayBuffer, m.palette.buffer as ArrayBuffer];
  if (m.kind === 'field') return [m.data.buffer as ArrayBuffer];
  return [
    m.xs.buffer as ArrayBuffer,
    m.ys.buffer as ArrayBuffer,
    m.species.buffer as ArrayBuffer,
    m.palette.buffer as ArrayBuffer,
  ];
}
