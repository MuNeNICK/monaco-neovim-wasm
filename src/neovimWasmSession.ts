import { encode } from "./msgpack";
import { createSharedInputRing, DEFAULT_SHARED_INPUT_BYTES, SharedInputRing } from "./sharedInput";

export type NeovimWasmSessionHandlers = {
  onNotify?: (method: string, params: unknown[]) => void;
  onRequest?: (msgid: number, method: string, params: unknown[]) => void;
  onClipboardCopy?: (lines: string[], regtype: string) => void;
  onClipboardPaste?: (msgid: number) => void;
  onStderr?: (message?: string) => void;
  onStartError?: (message?: string) => void;
  onExit?: (code: number, lastStderr?: string) => void;
  onWarning?: (message: string) => void;
};

export type NeovimWasmSessionInit = {
  worker?: Worker | null;
  workerUrl?: URL;
  createWorker?: (() => Worker) | null;
  sharedInputBytes?: number;
  rpcTimeoutMs?: number;
  maxQueuedBytes?: number;
  reuseWorker?: boolean;
  handlers?: NeovimWasmSessionHandlers;
};

export type NeovimWasmSessionStartOptions = {
  cols: number;
  rows: number;
  wasmPath: string;
  runtimePath: string;
  env?: Record<string, string>;
  files?: Array<{ path: string; data: Uint8Array }>;
};

type PendingEntry = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  ts: number;
  method: string;
};

type RpcNotify = {
  type: "rpc-notify";
  method: string;
  params?: unknown[];
};

type RpcResponse = {
  type: "rpc-response";
  msgid: number;
  error: unknown;
  result: unknown;
};

type RpcRequest = {
  type: "rpc-request";
  msgid: number;
  method: string;
  params?: unknown[];
};

type WorkerMessages =
  | RpcNotify
  | RpcResponse
  | RpcRequest
  | { type: "clipboard-copy"; lines: string[]; regtype: string }
  | { type: "clipboard-paste"; msgid: number }
  | { type: "start-error"; message?: string }
  | { type: "stderr"; message?: string }
  | { type: "exit"; code: number; lastStderr?: string };

export function isSharedArrayBufferAvailable(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
}

function normalizeTransfer(data: Uint8Array): Uint8Array {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data;
  return data.slice();
}

export class NeovimWasmSession {
  private readonly init: Required<Omit<NeovimWasmSessionInit, "worker" | "workerUrl" | "createWorker" | "handlers">> & {
    worker: Worker | null;
    workerUrl: URL | null;
    createWorker: (() => Worker) | null;
    handlers: NeovimWasmSessionHandlers;
  };

  private worker: Worker | null = null;
  private sharedInput: SharedInputRing | null = null;
  private reqId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private workerExited = false;
  private workerExitCode: number | null = null;
  private inputQueue: Uint8Array[] = [];
  private inputQueueHead = 0;
  private inputQueuedBytes = 0;
  private inputFlushTimer: number | null = null;

  constructor(init: NeovimWasmSessionInit = {}) {
    this.init = {
      worker: init.worker ?? null,
      workerUrl: init.workerUrl ?? null,
      createWorker: init.createWorker ?? null,
      sharedInputBytes: init.sharedInputBytes ?? DEFAULT_SHARED_INPUT_BYTES,
      rpcTimeoutMs: init.rpcTimeoutMs ?? 8000,
      maxQueuedBytes: init.maxQueuedBytes ?? (4 * 1024 * 1024),
      reuseWorker: init.reuseWorker ?? false,
      handlers: init.handlers ?? {},
    };
  }

  setHandlers(handlers: NeovimWasmSessionHandlers): void {
    this.init.handlers = handlers;
  }

  isRunning(): boolean {
    return Boolean(this.worker && !this.workerExited);
  }

  getExitCode(): number | null {
    return this.workerExitCode;
  }

  async start(options: NeovimWasmSessionStartOptions): Promise<void> {
    const { cols, rows, wasmPath, runtimePath, env, files } = options;
    if (!isSharedArrayBufferAvailable()) {
      throw new Error("SharedArrayBuffer is required; serve with COOP/COEP so crossOriginIsolated is true.");
    }

    const prevWorker = this.worker;
    this.stop({ terminate: !this.init.reuseWorker, silent: true });

    this.sharedInput = createSharedInputRing(this.init.sharedInputBytes);
    this.workerExited = false;
    this.workerExitCode = null;
    this.reqId = 1;
    this.pending.clear();

    if (this.init.worker) {
      this.worker = this.init.worker;
    } else if (this.init.createWorker) {
      this.worker = this.init.createWorker();
    } else if (this.init.reuseWorker && prevWorker) {
      this.worker = prevWorker;
    } else {
      this.worker = this.init.workerUrl ? new Worker(this.init.workerUrl, { type: "module" }) : null;
    }
    if (!this.worker) throw new Error("worker/workerUrl is required");

    this.worker.onmessage = (event: MessageEvent<WorkerMessages>) => this.handleWorkerMessage(event.data);
    const startMsg: Record<string, unknown> = {
      type: "start",
      cols: Number(cols) || 80,
      rows: Number(rows) || 24,
      wasmPath: String(wasmPath ?? ""),
      runtimePath: String(runtimePath ?? ""),
      inputBuffer: this.sharedInput.buffer,
      env: env ?? undefined,
      files: files ?? undefined,
    };
    try {
      this.worker.postMessage(startMsg, []);
    } catch (_) {
      this.worker.postMessage(startMsg);
    }
  }

  stop(opts: { terminate?: boolean; silent?: boolean } = {}): void {
    const terminate = opts.terminate ?? true;
    if (this.inputFlushTimer) {
      clearTimeout(this.inputFlushTimer);
      this.inputFlushTimer = null;
    }
    this.sharedInput = null;
    this.inputQueue = [];
    this.inputQueueHead = 0;
    this.inputQueuedBytes = 0;

    if (this.pending.size) {
      const err = new Error("session stopped");
      this.pending.forEach((entry) => entry.reject(err));
      this.pending.clear();
    }

    this.workerExited = false;
    this.workerExitCode = null;

    if (!this.worker) return;
    if (terminate) {
      this.worker.terminate();
      this.worker = null;
      return;
    }

    try {
      this.worker.postMessage({ type: "stop" });
    } catch (_) {
    }
  }

  dispose(): void {
    this.stop({ terminate: true, silent: true });
  }

  notify(method: string, params: unknown[] = []): void {
    if (!this.worker || this.workerExited) return;
    const msg = encode([2, method, params] as any);
    this.postInput(msg);
  }

  call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) { reject(new Error("session not started")); return; }
      if (this.workerExited) {
        const code = this.workerExitCode;
        reject(new Error(code != null ? `nvim exited (${code})` : "nvim exited"));
        return;
      }
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject, ts: Date.now(), method });
      const msg = encode([0, id, method, params] as any);
      this.postInput(msg);
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(this.workerExited
          ? (this.workerExitCode != null ? `nvim exited (${this.workerExitCode})` : "nvim exited")
          : `rpc timeout: ${method}`));
      }, this.init.rpcTimeoutMs);
    });
  }

  async waitForApi(): Promise<void> {
    const delay = 300;
    const maxMs = Math.min(Math.max(this.init.rpcTimeoutMs * 2, 10_000), 15_000);
    const retries = Math.ceil(maxMs / delay);
    for (let i = 0; i < retries; i += 1) {
      try {
        await this.call("nvim_get_api_info", []);
        return;
      } catch (_) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("nvim_get_api_info timed out");
  }

  respond(msgid: number, error: unknown, result: unknown): void {
    if (!this.worker || this.workerExited) return;
    const msg = encode([1, msgid, error, result] as any);
    this.postInput(msg);
  }

  private handleWorkerMessage(message: WorkerMessages): void {
    const type = message?.type;
    if (type === "rpc-response") {
      const { msgid, error, result } = message as RpcResponse;
      const entry = this.pending.get(msgid);
      if (!entry) return;
      this.pending.delete(msgid);
      if (error) entry.reject(new Error(String(error)));
      else entry.resolve(result);
      return;
    }
    if (type === "rpc-notify") {
      const { method, params } = message as RpcNotify;
      try { this.init.handlers.onNotify?.(method, params ?? []); } catch (_) {}
      return;
    }
    if (type === "rpc-request") {
      const { msgid, method, params } = message as RpcRequest;
      try { this.init.handlers.onRequest?.(msgid, method, params ?? []); } catch (_) {}
      return;
    }
    if (type === "clipboard-copy") {
      const payload = message as { lines: string[]; regtype: string };
      try { this.init.handlers.onClipboardCopy?.(payload.lines ?? [], payload.regtype ?? "v"); } catch (_) {}
      return;
    }
    if (type === "clipboard-paste") {
      const payload = message as { msgid: number };
      try { this.init.handlers.onClipboardPaste?.(payload.msgid); } catch (_) {}
      return;
    }
    if (type === "stderr") {
      const payload = message as { message?: string };
      try { this.init.handlers.onStderr?.(payload?.message); } catch (_) {}
      return;
    }
    if (type === "start-error") {
      const payload = message as { message?: string };
      try { this.init.handlers.onStartError?.(payload?.message); } catch (_) {}
      return;
    }
    if (type === "exit") {
      const payload = message as { code: number; lastStderr?: string };
      const code = payload.code;
      const lastStderr = payload.lastStderr;
      this.workerExited = true;
      this.workerExitCode = code;
      if (this.pending.size) {
        const suffix = lastStderr ? `: ${lastStderr.trim()}` : "";
        const err = new Error(`nvim exited (${code})${suffix}`);
        this.pending.forEach((entry) => entry.reject(err));
        this.pending.clear();
      }
      try { this.init.handlers.onExit?.(code, lastStderr); } catch (_) {}
    }
  }

  private postInput(data: Uint8Array): void {
    if (!data || !data.buffer) return;
    const payload = normalizeTransfer(data);
    if (!this.sharedInput) return;
    if (this.inputQueueHead >= this.inputQueue.length) {
      const ok = this.sharedInput.push(payload);
      if (ok) return;
    }
    this.enqueueInput(payload);
  }

  private enqueueInput(payload: Uint8Array): void {
    if (!this.sharedInput) return;
    this.inputQueue.push(payload);
    this.inputQueuedBytes += payload.byteLength;
    if (this.inputQueuedBytes > this.init.maxQueuedBytes) {
      try { this.init.handlers.onWarning?.("input queue overflow (ring buffer too small); dropping queued input"); } catch (_) {}
      this.inputQueue = [];
      this.inputQueueHead = 0;
      this.inputQueuedBytes = 0;
      return;
    }
    this.scheduleFlushInput();
  }

  private scheduleFlushInput(): void {
    if (this.inputFlushTimer) return;
    this.inputFlushTimer = window.setTimeout(() => {
      this.inputFlushTimer = null;
      this.flushInputQueue();
    }, 0);
  }

  private flushInputQueue(): void {
    if (!this.sharedInput || this.inputQueueHead >= this.inputQueue.length) return;
    while (this.inputQueueHead < this.inputQueue.length) {
      const next = this.inputQueue[this.inputQueueHead];
      const ok = this.sharedInput.push(next);
      if (!ok) break;
      this.inputQueueHead += 1;
      this.inputQueuedBytes -= next.byteLength;
    }
    if (this.inputQueueHead > 64 && this.inputQueueHead > (this.inputQueue.length / 2)) {
      this.inputQueue = this.inputQueue.slice(this.inputQueueHead);
      this.inputQueueHead = 0;
    }
    if (this.inputQueueHead < this.inputQueue.length) {
      this.inputFlushTimer = window.setTimeout(() => {
        this.inputFlushTimer = null;
        this.flushInputQueue();
      }, 2);
    } else {
      this.inputQueue = [];
      this.inputQueueHead = 0;
    }
  }
}
