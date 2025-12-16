export class SharedInputRing {
  readonly buffer: SharedArrayBuffer;
  readonly ctrl: Int32Array;
  readonly data: Uint8Array;
  readonly capacity: number;

  constructor(capacity = DEFAULT_SHARED_INPUT_BYTES) {
    this.capacity = Math.max(8 * 1024, capacity | 0);
    this.buffer = new SharedArrayBuffer(8 + this.capacity);
    this.ctrl = new Int32Array(this.buffer, 0, 2);
    this.data = new Uint8Array(this.buffer, 8);
    Atomics.store(this.ctrl, 0, 0);
    Atomics.store(this.ctrl, 1, 0);
  }

  push(bytes: Uint8Array | ArrayBufferLike | ArrayLike<number>): boolean {
    let src: Uint8Array;
    if (bytes instanceof Uint8Array) {
      src = bytes;
    } else if (bytes instanceof ArrayBuffer || bytes instanceof SharedArrayBuffer) {
      src = new Uint8Array(bytes);
    } else {
      src = new Uint8Array(bytes);
    }
    let head = Atomics.load(this.ctrl, 0);
    let tail = Atomics.load(this.ctrl, 1);
    let written = 0;
    for (let i = 0; i < src.length; i += 1) {
      const next = (tail + 1) % this.capacity;
      if (next === head) break; // full
      this.data[tail] = src[i];
      tail = next;
      written += 1;
    }
    Atomics.store(this.ctrl, 1, tail);
    if (written > 0) Atomics.notify(this.ctrl, 1);
    return written === src.length;
  }
}

export const DEFAULT_SHARED_INPUT_BYTES = 262_144;

export function createSharedInputRing(capacity = DEFAULT_SHARED_INPUT_BYTES): SharedInputRing {
  return new SharedInputRing(capacity);
}
