// FNV-1a (32-bit) over raw bytes. Used to fingerprint simulation state for
// determinism snapshots: same seed + same steps must yield the same hash.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a(bytes: Uint8Array): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, FNV_PRIME);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Hash the raw bytes underlying any typed-array view. */
export function hashView(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return fnv1a(bytes);
}

/**
 * Hash a heterogeneous list of parts in order. Numbers are folded in as four
 * little-endian bytes; typed arrays are folded in byte-by-byte. Lets a system
 * mix grid contents with scalar state (generation, agent position, …) into one
 * stable fingerprint.
 */
export function hashParts(parts: ReadonlyArray<ArrayBufferView | number>): string {
  let h = FNV_OFFSET;
  const mix = (b: number): void => {
    h ^= b & 0xff;
    h = Math.imul(h, FNV_PRIME);
  };
  for (const p of parts) {
    if (typeof p === 'number') {
      const n = p | 0;
      mix(n & 0xff);
      mix((n >>> 8) & 0xff);
      mix((n >>> 16) & 0xff);
      mix((n >>> 24) & 0xff);
    } else {
      const bytes = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
      for (let i = 0; i < bytes.length; i++) mix(bytes[i]!);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
