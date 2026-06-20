// ─────────────────────────────────────────────────────────────────────────────
// Simulation worker entry. A thin message shell around `SimHost`: it owns the
// live simulation, advances it on `run`/`step`, mutates it on `paint`/`clear`,
// and after every command emits a frame (a transfer-buffer copy of the render
// model + generation + hash) back to the main thread.
//
// All real logic lives in SimHost / protocol, which are plain modules the tests
// import directly; this file only wires them to `postMessage` and is the one
// place that touches worker globals.
// ─────────────────────────────────────────────────────────────────────────────

import { SimHost } from './sim-host';
import { BufferPool, serializeModel, type SimFrame, type SimRequest } from './protocol';

interface WorkerCtx {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
}
const ctx = self as unknown as WorkerCtx;

let host: SimHost | null = null;
let epoch = 0;
const pool = new BufferPool();

/** Snapshot the current render model into transfer buffers and ship it. */
function emit(fromRun: boolean): void {
  if (!host) return;
  const { model, transfer } = serializeModel(host.render(), pool);
  const frame: SimFrame = {
    type: 'frame',
    epoch,
    fromRun,
    generation: host.generation,
    hash: host.hash(),
    caps: host.caps(),
    model,
  };
  ctx.postMessage(frame, transfer);
}

ctx.onmessage = (e: MessageEvent): void => {
  const req = e.data as SimRequest;
  switch (req.type) {
    case 'create':
      epoch = req.epoch;
      pool.clear(); // model size/shape may change; old-sized buffers are useless
      host = new SimHost(req.sysId, req.params, req.seed, req.preset);
      emit(false);
      break;
    case 'run':
      if (host) {
        host.advance(req.dt, req.sps);
        emit(true);
      }
      break;
    case 'step':
      if (host) {
        host.stepOnce();
        emit(false);
      }
      break;
    case 'paint':
      if (host) {
        host.paint(req.info);
        emit(false);
      }
      break;
    case 'clear':
      if (host) {
        host.clear();
        emit(false);
      }
      break;
    case 'recycle':
      pool.recycle(req.buffers);
      break;
  }
};
