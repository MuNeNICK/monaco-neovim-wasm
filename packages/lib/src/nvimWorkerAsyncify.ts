import {
  WASI,
  wasi,
  WASIProcExit,
  Directory,
  PreopenDirectory,
  Fd,
} from "@bjorn3/browser_wasi_shim";
import { Decoder } from "./msgpack";
import { applyExtraFiles, buildFs, FORWARD_NOTIFY_METHODS, getCachedRuntimeEntries, getCachedWasmBytes, makeEnv, RootedPreopenDirectory, toU8, type WorkerFile, type WorkerFileData } from "./nvimWorkerCommon";

type StartMessage = {
  type: "start";
  cols?: number;
  rows?: number;
  wasmPath: string;
  runtimePath: string;
  env?: Record<string, string> | null;
  files?: WorkerFile[] | null;
};

type StopMessage = { type: "stop" };
type StdinMessage = { type: "stdin"; chunk?: WorkerFileData };

type InboundMessage = StartMessage | StopMessage | StdinMessage;

let rpcDecoder: Decoder | null = null;
let activeWasi: WASI | null = null;
let stdinFd: MessageInputFd | null = null;
let wasmExports: any = null;
let pendingAsync: Promise<void> | null = null;
let pendingPollOneoff: { in_ptr: number; nsubscriptions: number; clockDeadlines: Array<bigint | null> } | null = null;
let stdinWaitPromise: Promise<void> | null = null;

let asyncifyDataPtr = 0;
let asyncifyStackStart = 0;
let asyncifyStackEnd = 0;

const stderrDecoder = new TextDecoder();
let lastStderr = "";
let fatalSent = false;
const pendingStdin: Uint8Array[] = [];

self.addEventListener("error", (ev) => {
  if (fatalSent) return;
  fatalSent = true;
  const msg = ev.message || String((ev as any).error || "worker error");
  const stack = (ev as any).error?.stack;
  try {
    postMessage({ type: "start-error", message: stack ? `${msg}\n${stack}` : msg });
    postMessage({ type: "exit", code: 1, lastStderr });
  } catch (_) {
  }
});

self.addEventListener("unhandledrejection", (ev) => {
  if (fatalSent) return;
  fatalSent = true;
  const reason: any = (ev as any).reason;
  const msg = (reason && (reason.message || String(reason))) || "unhandled rejection";
  const stack = reason?.stack;
  try {
    postMessage({ type: "start-error", message: stack ? `${msg}\n${stack}` : msg });
    postMessage({ type: "exit", code: 1, lastStderr });
  } catch (_) {
  }
});

self.onmessage = (event: MessageEvent<InboundMessage>) => {
  const { type } = event.data || ({} as any);
  if (type === "start") {
    startNvim(event.data as StartMessage).catch((err) => {
      postMessage({ type: "start-error", message: err?.message || String(err) });
      postMessage({ type: "exit", code: 1 });
    });
  } else if (type === "stdin") {
    const chunk = toU8((event.data as StdinMessage)?.chunk);
    if (!chunk?.byteLength) return;
    if (stdinFd) {
      stdinFd.push(chunk);
    } else {
      pendingStdin.push(chunk);
    }
  } else if (type === "stop") {
    try {
      stdinFd?.close();
    } catch (_) {
    }
    try {
      activeWasi?.wasiImport?.proc_exit?.(0);
    } catch (_) {
    }
    stdinFd = null;
  }
};

class MessageInputFd extends Fd {
  private chunks: Uint8Array[] = [];
  total = 0;
  private waiters: Array<() => void> = [];
  closed = false;

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ | wasi.RIGHTS_FD_WRITE);
    return { ret: wasi.ERRNO_SUCCESS, fdstat };
  }

  fd_close() {
    this.close();
    return wasi.ERRNO_SUCCESS;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  push(chunk: Uint8Array) {
    if (this.closed) return;
    if (!chunk?.byteLength) return;
    this.chunks.push(chunk);
    this.total += chunk.byteLength;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  waitForData() {
    if (this.closed || this.total > 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  fd_read(size: number) {
    if (this.closed && this.total === 0) return { ret: wasi.ERRNO_SUCCESS, data: new Uint8Array() };
    const max = Math.min(Math.max(0, Number(size) || 0), this.total);
    if (max === 0) return { ret: wasi.ERRNO_AGAIN, data: new Uint8Array() };
    const out = new Uint8Array(max);
    let written = 0;
    while (written < max && this.chunks.length) {
      const first = this.chunks[0];
      const take = Math.min(first.byteLength, max - written);
      out.set(first.subarray(0, take), written);
      written += take;
      if (take === first.byteLength) this.chunks.shift();
      else this.chunks[0] = first.subarray(take);
    }
    this.total -= written;
    return { ret: wasi.ERRNO_SUCCESS, data: out };
  }

  fd_write() { return { ret: wasi.ERRNO_BADF, nwritten: 0 }; }
  fd_seek() { return { ret: wasi.ERRNO_BADF, offset: 0n }; }
  fd_tell() { return { ret: wasi.ERRNO_BADF, offset: 0n }; }
  fd_pread() { return { ret: wasi.ERRNO_BADF, data: new Uint8Array() }; }
  fd_pwrite() { return { ret: wasi.ERRNO_BADF, nwritten: 0 }; }
}

class SinkFd extends Fd {
  private readonly onWrite: (data: Uint8Array) => void;

  constructor(onWrite: (data: Uint8Array) => void) {
    super();
    this.onWrite = onWrite;
  }

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
    return { ret: wasi.ERRNO_SUCCESS, fdstat };
  }

  fd_write(data: Uint8Array) {
    this.onWrite(new Uint8Array(data));
    return { ret: wasi.ERRNO_SUCCESS, nwritten: data.byteLength };
  }

  fd_close() { return wasi.ERRNO_SUCCESS; }
}

async function startNvim({ cols, rows, wasmPath, runtimePath, env: extraEnv, files }: StartMessage) {
  let exitCode = 1;
  try {
    rpcDecoder = null;
    stdinWaitPromise = null;
    pendingAsync = null;
    pendingPollOneoff = null;
    wasmExports = null;

    stdinFd = new MessageInputFd();
    while (pendingStdin.length) stdinFd.push(pendingStdin.shift()!);

    const wasmBytes = await getCachedWasmBytes(wasmPath);
    const untarred = await getCachedRuntimeEntries(runtimePath);
    const fsRoot = buildFs(untarred, () => {});
    if (files && Array.isArray(files) && files.length) applyExtraFiles(fsRoot, files);

    const stdoutFd = new SinkFd(handleStdout);
    const stderrFd = new SinkFd((data) => {
      const msg = stderrDecoder.decode(data);
      if (msg) lastStderr = (lastStderr + msg).slice(-8192);
      postMessage({ type: "stderr", message: msg });
    });

    const preopen = new RootedPreopenDirectory("nvim", fsRoot.contents);
    const tmpDir = fsRoot.contents.get("tmp") as Directory | undefined;
    const tmp = tmpDir?.contents || new Map();
    const preopenTmp = new RootedPreopenDirectory("tmp", tmp);

    const args = ["nvim", "--headless", "--embed", "-u", "NORC", "--noplugin", "-i", "NONE", "-n"];
    const env = [
      "VIMRUNTIME=/nvim/runtime",
      "HOME=/nvim/home",
      "PWD=/nvim",
      "XDG_CONFIG_HOME=/nvim/home/.config",
      "XDG_DATA_HOME=/nvim/home/.local/share",
      "XDG_STATE_HOME=/nvim/home/.local/state",
      "PATH=/usr/bin:/bin",
      "TMPDIR=/nvim/tmp",
      `COLUMNS=${cols || 120}`,
      `LINES=${rows || 40}`,
    ];
    if (extraEnv && typeof extraEnv === "object") {
      for (const [k, v] of Object.entries(extraEnv)) {
        if (!k) continue;
        env.push(`${k}=${String(v ?? "")}`);
      }
    }

    activeWasi = new WASI(args, env, [stdinFd, stdoutFd, stderrFd, preopen, preopenTmp], { debug: false });
    activeWasi.fds[0] = stdinFd;
    activeWasi.fds[1] = stdoutFd;
    activeWasi.fds[2] = stderrFd;
    activeWasi.fds[3] = preopen;
    activeWasi.fds[4] = preopenTmp;
    (activeWasi as unknown as { preopens: Record<string, PreopenDirectory> }).preopens = { "/nvim": preopen, "/tmp": preopenTmp };

    const envImports = makeEnv(() => activeWasi?.wasiImport?.proc_exit?.(1));
    const wasiImports: Record<string, any> = { ...activeWasi.wasiImport };

    // Keep fd_read non-blocking (ERRNO_AGAIN) and only asyncify poll_oneoff.
    wasiImports.fd_read = activeWasi.wasiImport.fd_read;
    wasiImports.poll_oneoff = (in_ptr: number, out_ptr: number, nsubscriptions: number, nevents_ptr: number) => (
      pollOneoffAsyncified(in_ptr, out_ptr, nsubscriptions, nevents_ptr)
    );

    const wasmInstance = await WebAssembly.instantiate(wasmBytes, {
      wasi_snapshot_preview1: wasiImports,
      env: envImports,
    });
    const instanceSource = wasmInstance as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const instance = instanceSource.instance
      ?? (wasmInstance as unknown as { instance: WebAssembly.Instance }).instance;

    wasmExports = (instance as any).exports;
    initAsyncify(wasmExports);
    (activeWasi as any).inst = instance;

    exitCode = await runAsyncifiedStart(wasmExports);
  } catch (err) {
    if (err instanceof WASIProcExit) {
      exitCode = err.code;
    } else {
      const message = (err as { message?: string })?.message || String(err);
      const stack = (err as { stack?: string })?.stack;
      postMessage({ type: "start-error", message: stack ? `${message}\n${stack}` : message });
    }
  }

  postMessage({ type: "exit", code: exitCode, lastStderr });
}

function pollOneoffAsyncified(in_ptr: number, out_ptr: number, nsubscriptions: number, nevents_ptr: number): number {
  if (!wasmExports?.memory) return wasi.ERRNO_FAULT;
  const ns = Number(nsubscriptions) >>> 0;
  if (ns === 0) return wasi.ERRNO_INVAL;

  const state = wasmExports?.asyncify_get_state?.() ?? 0;
  if (state === 0 && pendingPollOneoff) pendingPollOneoff = null;

  const buffer = new DataView(wasmExports.memory.buffer);
  const subSize = 48;
  const eventSize = 32;

  const nowNs = () => BigInt(Math.round(performance.now() * 1e6));
  const nowRealNs = () => BigInt(Date.now()) * 1000000n;

  let needStdin = false;
  let nextDeltaNs: bigint | null = null;
  const ready: Array<{ userdata: bigint; eventtype: number }> = [];
  const clockDeadlines: Array<bigint | null> = new Array(ns).fill(null);

  const usePending = state === 2
    && pendingPollOneoff
    && pendingPollOneoff.in_ptr === (in_ptr >>> 0)
    && pendingPollOneoff.nsubscriptions === ns;

  for (let i = 0; i < ns; i += 1) {
    const base = (in_ptr + i * subSize) >>> 0;
    const userdata = buffer.getBigUint64(base, true);
    const eventtype = buffer.getUint8(base + 8);

    if (eventtype === wasi.EVENTTYPE_FD_READ || eventtype === wasi.EVENTTYPE_FD_WRITE) {
      const fd = buffer.getUint32(base + 16, true);

      if (eventtype === wasi.EVENTTYPE_FD_WRITE) {
        ready.push({ userdata, eventtype });
        continue;
      }

      if (fd === 0) {
        const stdinReady = Boolean(stdinFd && (stdinFd.total > 0 || stdinFd.closed));
        if (stdinReady) ready.push({ userdata, eventtype });
        else needStdin = true;
        continue;
      }

      // For non-stdin fds, assume readability. Neovim+libuv uses poll_oneoff
      // for various internal handles; returning NOTSUP can stall the loop.
      ready.push({ userdata, eventtype });
      continue;
    }

    if (eventtype === wasi.EVENTTYPE_CLOCK) {
      const clockid = buffer.getUint32(base + 16, true);
      const timeout = buffer.getBigUint64(base + 24, true);
      const flags = buffer.getUint16(base + 36, true);
      const getNow = clockid === wasi.CLOCKID_MONOTONIC
        ? nowNs
        : (clockid === wasi.CLOCKID_REALTIME ? nowRealNs : null);
      if (!getNow) return wasi.ERRNO_INVAL;

      const now = getNow();
      const isAbs = (flags & wasi.SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME) !== 0;
      const endTime = usePending && pendingPollOneoff?.clockDeadlines?.[i] != null
        ? BigInt(pendingPollOneoff!.clockDeadlines[i]!)
        : (isAbs ? timeout : (now + timeout));
      clockDeadlines[i] = endTime;
      if (endTime <= now) {
        ready.push({ userdata, eventtype });
      } else {
        const delta = endTime - now;
        if (nextDeltaNs === null || delta < nextDeltaNs) nextDeltaNs = delta;
      }
      continue;
    }

    return wasi.ERRNO_NOTSUP;
  }

  if (ready.length > 0) {
    if (state === 2) stopRewindIfNeeded();
    pendingPollOneoff = null;
    const out = new DataView(wasmExports.memory.buffer);
    const count = Math.min(ready.length, ns);
    for (let i = 0; i < count; i += 1) {
      const ev = ready[i];
      const event = new (wasi as any).Event(ev.userdata, wasi.ERRNO_SUCCESS, ev.eventtype);
      event.write_bytes(out as any, (out_ptr + i * eventSize) >>> 0);
    }
    if (typeof nevents_ptr === "number") out.setUint32(nevents_ptr, count, true);
    return wasi.ERRNO_SUCCESS;
  }

  const waits: Array<Promise<void>> = [];
  const canWakeOnStdin = Boolean(stdinFd && !stdinFd.closed && stdinFd.total === 0);
  if ((needStdin || canWakeOnStdin) && stdinFd && !stdinFd.closed) waits.push(getStdinWaitPromise());
  if (nextDeltaNs !== null) {
    const maxWaitMs = 50;
    const raw = Number(nextDeltaNs / 1000000n);
    const ms = Number.isFinite(raw) && raw > 0 ? raw : 0;
    waits.push(new Promise((r) => setTimeout(r, Math.min(ms, maxWaitMs))));
  }

  if (waits.length === 0) {
    if (typeof nevents_ptr === "number") buffer.setUint32(nevents_ptr, 0, true);
    return wasi.ERRNO_SUCCESS;
  }

  if (state === 2) stopRewindIfNeeded();
  if (state === 0 || state === 2) {
    pendingPollOneoff = { in_ptr: (in_ptr >>> 0), nsubscriptions: ns, clockDeadlines };
    startUnwind(waits.length === 1 ? waits[0] : Promise.race(waits));
    if (typeof nevents_ptr === "number") new DataView(wasmExports.memory.buffer).setUint32(nevents_ptr, 0, true);
    return wasi.ERRNO_SUCCESS;
  }

  if (typeof nevents_ptr === "number") buffer.setUint32(nevents_ptr, 0, true);
  return wasi.ERRNO_SUCCESS;
}

function getStdinWaitPromise(): Promise<void> {
  if (!stdinFd || stdinFd.closed || stdinFd.total > 0) return Promise.resolve();
  if (!stdinWaitPromise) {
    stdinWaitPromise = stdinFd.waitForData().finally(() => { stdinWaitPromise = null; });
  }
  return stdinWaitPromise;
}

function initAsyncify(exports: any) {
  if (!exports?.memory) throw new Error("asyncify: missing exported memory");
  if (typeof exports.asyncify_start_unwind !== "function") throw new Error("asyncify: missing exports");

  if (
    typeof exports.nvim_asyncify_get_data_ptr === "function"
    && typeof exports.nvim_asyncify_get_stack_start === "function"
    && typeof exports.nvim_asyncify_get_stack_end === "function"
  ) {
    asyncifyDataPtr = exports.nvim_asyncify_get_data_ptr() >>> 0;
    asyncifyStackStart = exports.nvim_asyncify_get_stack_start() >>> 0;
    asyncifyStackEnd = exports.nvim_asyncify_get_stack_end() >>> 0;
    resetAsyncifyData();
    return;
  }

  const stackSize = 64 * 1024 * 1024;
  const pageSize = 65536;
  const extra = stackSize + 64;
  const pages = Math.ceil(extra / pageSize);
  exports.memory.grow(pages);

  const end = exports.memory.buffer.byteLength >>> 0;
  asyncifyStackEnd = end;
  const rawStackStart = (end - stackSize) >>> 0;
  asyncifyDataPtr = ((rawStackStart - 8) & ~0x7) >>> 0;
  asyncifyStackStart = (asyncifyDataPtr + 8) >>> 0;
  resetAsyncifyData();
}

function resetAsyncifyData() {
  if (!wasmExports?.memory) return;
  if (!asyncifyDataPtr || !asyncifyStackStart || !asyncifyStackEnd) return;
  const view = new DataView(wasmExports.memory.buffer);
  view.setInt32(asyncifyDataPtr, asyncifyStackStart, true);
  view.setInt32(asyncifyDataPtr + 4, asyncifyStackEnd, true);
}

function startUnwind(promise: Promise<void>) {
  if (!wasmExports || !asyncifyDataPtr) throw new Error("asyncify: not initialized");
  if (pendingAsync) throw new Error("asyncify: overlapping async operation");
  resetAsyncifyData();
  pendingAsync = promise;
  wasmExports.asyncify_start_unwind(asyncifyDataPtr);
}

function stopRewindIfNeeded() {
  if (!wasmExports?.asyncify_get_state || !wasmExports?.asyncify_stop_rewind) return;
  if (wasmExports.asyncify_get_state() === 2) {
    wasmExports.asyncify_stop_rewind();
    resetAsyncifyData();
  }
}

async function runAsyncifiedStart(exports: any): Promise<number> {
  while (true) {
    try {
      exports._start();
    } catch (err) {
      if (err instanceof WASIProcExit) return err.code;
      throw err;
    }

    const state = exports.asyncify_get_state();
    if (state === 0) return 0;
    if (state === 2) {
      exports.asyncify_stop_rewind();
      resetAsyncifyData();
      continue;
    }
    if (state !== 1) throw new Error(`asyncify: unexpected state ${state}`);

    exports.asyncify_stop_unwind();
    const wait = pendingAsync;
    pendingAsync = null;
    if (!wait) throw new Error("asyncify: missing pending promise");
    await wait;
    exports.asyncify_start_rewind(asyncifyDataPtr);
  }
}

function handleStdout(chunk: Uint8Array) {
  if (!rpcDecoder) {
    rpcDecoder = new Decoder(handleMessage);
  }
  try {
    rpcDecoder.push(chunk);
  } catch (err) {
    void err;
    rpcDecoder = new Decoder(handleMessage);
  }
}

function handleMessage(msg: unknown) {
  if (!Array.isArray(msg) || msg.length < 1) return;
  const kind = msg[0];
  if (kind === 0) {
    const [, msgid, method, params] = msg as any;
    if (method === "wasm-clipboard-paste") {
      postMessage({ type: "clipboard-paste", msgid });
    } else {
      postMessage({ type: "rpc-request", msgid, method, params });
    }
  } else if (kind === 1) {
    const [, msgid, error, result] = msg as any;
    postMessage({ type: "rpc-response", msgid, error, result });
  } else if (kind === 2) {
    const [, method, params] = msg as any;
    if (method === "wasm-clipboard-copy") {
      const lines = Array.isArray((params as any)?.[0]) ? (params as any)[0] : [];
      const regtype = typeof (params as any)?.[1] === "string" ? (params as any)[1] : "v";
      postMessage({ type: "clipboard-copy", lines, regtype });
    } else {
      const m = typeof method === "string" ? method : "";
      if (FORWARD_NOTIFY_METHODS.has(m)) {
        postMessage({ type: "rpc-notify", method: m, params });
      }
    }
  }
}
