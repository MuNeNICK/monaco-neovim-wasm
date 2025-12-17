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
    if (!src.byteLength) return true;
    const head = Atomics.load(this.ctrl, 0);
    const tail = Atomics.load(this.ctrl, 1);

    const used = tail >= head ? (tail - head) : (this.capacity - (head - tail));
    const free = (this.capacity - used - 1);
    if (src.byteLength > free) return false;

    const endSpace = this.capacity - tail;
    if (src.byteLength <= endSpace) {
      this.data.set(src, tail);
      Atomics.store(this.ctrl, 1, (tail + src.byteLength) % this.capacity);
    } else {
      this.data.set(src.subarray(0, endSpace), tail);
      this.data.set(src.subarray(endSpace), 0);
      Atomics.store(this.ctrl, 1, src.byteLength - endSpace);
    }
    Atomics.notify(this.ctrl, 1);
    return true;
  }
}

export const DEFAULT_SHARED_INPUT_BYTES = 262_144;

export function createSharedInputRing(capacity = DEFAULT_SHARED_INPUT_BYTES): SharedInputRing {
  return new SharedInputRing(capacity);
}
