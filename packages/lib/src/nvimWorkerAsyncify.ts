import {
  WASI,
  wasi,
  WASIProcExit,
  Directory,
  File,
  PreopenDirectory,
  Fd,
  Inode,
} from "@bjorn3/browser_wasi_shim";
import { gunzipSync } from "fflate";
import { Decoder } from "./msgpack";

type StartMessage = {
  type: "start";
  cols?: number;
  rows?: number;
  wasmPath: string;
  runtimePath: string;
  env?: Record<string, string> | null;
  files?: Array<{ path: string; data: Uint8Array | ArrayBuffer | ArrayLike<number> | { type: "Buffer"; data: number[] } }> | null;
};

type StopMessage = { type: "stop" };
type StdinMessage = { type: "stdin"; chunk?: Uint8Array | ArrayBuffer | ArrayLike<number> | { type: "Buffer"; data: number[] } };

type InboundMessage = StartMessage | StopMessage | StdinMessage;

type DirNode = Directory & { contents: Map<string, any> };

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
let cachedWasm: { url: string; bytes: Uint8Array } | null = null;
let cachedRuntime: { url: string; entries: TarEntry[] } | null = null;
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

async function getCachedWasmBytes(url: string): Promise<Uint8Array> {
  if (cachedWasm && cachedWasm.url === url && cachedWasm.bytes?.byteLength) return cachedWasm.bytes;
  const bytes = await fetchBytes(url);
  cachedWasm = { url, bytes };
  return bytes;
}

async function getCachedRuntimeEntries(url: string): Promise<TarEntry[]> {
  if (cachedRuntime && cachedRuntime.url === url && cachedRuntime.entries?.length) return cachedRuntime.entries;
  const archive = await fetchBytes(url);
  let runtimeBytes: Uint8Array;
  if (looksLikeGzip(archive)) {
    try {
      runtimeBytes = gunzipSync(archive);
    } catch (e) {
      throw new Error(`gunzip runtime failed: ${(e as Error)?.message ?? e}`);
    }
  } else {
    runtimeBytes = archive;
  }
  let entries: TarEntry[];
  try {
    entries = untar(runtimeBytes);
  } catch (e) {
    throw new Error(`untar runtime failed: ${(e as Error)?.message ?? e}`);
  }
  cachedRuntime = { url, entries };
  return entries;
}

function applyExtraFiles(fsRoot: DirNode, files: Array<{ path: string; data: any }>) {
  for (const file of files) {
    const rawPath = String(file?.path ?? "");
    const clean = rawPath.replace(/^\/+/, "").replace(/^\.\/+/, "");
    if (!clean || clean.endsWith("/")) continue;
    const data = toU8(file?.data);
    if (!data) continue;
    const parts = clean.split("/").filter(Boolean);
    if (!parts.length) continue;
    let dir: DirNode = fsRoot;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!dir.contents.has(part)) dir.contents.set(part, new Directory(new Map()));
      dir = dir.contents.get(part) as DirNode;
    }
    const leaf = parts[parts.length - 1];
    dir.contents.set(leaf, new File(data, { readonly: false }));
  }
}

function toU8(data: any): Uint8Array | null {
  if (!data) return new Uint8Array();
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof SharedArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  if (data && data.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
  try {
    return new TextEncoder().encode(String(data));
  } catch (_) {
    return null;
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
    } else if (
      method === "nvim_buf_lines_event"
      || method === "nvim_buf_detach_event"
      || method === "redraw"
      || method === "monaco_cursor"
      || method === "monaco_mode"
      || method === "monaco_cursorMove"
      || method === "monaco_scroll"
      || method === "monaco_reveal"
      || method === "monaco_moveCursor"
      || method === "monaco_scrolloff"
      || method === "monaco_host_command"
      || method === "monaco_buf_enter"
      || method === "monaco_buf_delete"
    ) {
      postMessage({ type: "rpc-notify", method, params });
    }
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed (${res.status})`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) throw new Error(`fetch ${url} returned HTML (likely wrong path or dev server fallback)`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (!data.byteLength) throw new Error(`fetch ${url} returned empty body`);
  return data;
}

type TarEntry = { name: string; type: "dir" | "file"; data: Uint8Array };

function looksLikeGzip(data: Uint8Array) {
  return data && data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

function untar(bytes: Uint8Array): TarEntry[] {
  const files: TarEntry[] = [];
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let offset = 0;
  const decoder = new TextDecoder();
  let safety = 0;

  while (offset + 512 <= data.length) {
    if (safety++ > 100_000) throw new Error("untar safety break");
    const name = decodeTarString(decoder, data, offset, 100);
    const sizeText = decodeTarString(decoder, data, offset + 124, 12);
    const typeflag = data[offset + 156];
    const prefix = decodeTarString(decoder, data, offset + 345, 155);
    if (!name && !prefix) break;
    const sizeRaw = sizeText.trim() || "0";
    const size = parseInt(sizeRaw, 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`invalid tar size: ${sizeRaw}`);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    const payload = data.slice(bodyStart, bodyEnd);
    files.push({ name: fullName, type: typeflag === 53 ? "dir" : "file", data: payload });
    const blocks = Math.ceil(size / 512);
    const next = bodyStart + blocks * 512;
    if (next <= offset) throw new Error("tar parse did not advance");
    offset = next;
  }
  return files;
}

function decodeTarString(decoder: TextDecoder, data: Uint8Array, start: number, length: number): string {
  let end = start;
  const max = start + length;
  while (end < max && data[end] !== 0) end += 1;
  return decoder.decode(data.subarray(start, end)).trim();
}

function buildFs(entries: TarEntry[], onProgress?: (count: number) => void) {
  const root = new Directory(new Map()) as DirNode;
  let count = 0;
  for (const entry of entries) {
    const clean = entry.name.replace(/^\.\/?/, "");
    if (!clean) continue;
    const parts = clean.split("/").filter(Boolean);
    if (!parts.length) continue;
    count += 1;
    if (onProgress && count % 500 === 0) onProgress(count);

    let dir: DirNode = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!dir.contents.has(part)) dir.contents.set(part, new Directory(new Map()));
      dir = dir.contents.get(part) as DirNode;
    }

    const leaf = parts[parts.length - 1];
    if (entry.type === "dir") {
      if (!dir.contents.has(leaf)) dir.contents.set(leaf, new Directory(new Map()));
    } else {
      dir.contents.set(leaf, new File(entry.data, { readonly: true }));
    }
  }

  ensureDir(root, "home");
  ensureDir(root, "tmp");
  ensureDir(root, "home/.config");
  ensureDir(root, "home/.local/share");
  ensureDir(root, "home/.local/state");

  return root;
}

function ensureDir(root: DirNode, path: string) {
  const parts = path.split("/").filter(Boolean);
  let node: DirNode = root;
  for (const p of parts) {
    if (!node.contents.has(p)) node.contents.set(p, new Directory(new Map()));
    node = node.contents.get(p) as DirNode;
  }
}

function makeEnv(procExit?: (code: number) => void) {
  const wasmAny = WebAssembly as any;
  const cLongjmp = new wasmAny.Tag({ parameters: ["i32"], results: [] }) as any;
  return {
    flock: () => 0,
    getpid: () => 1,
    uv_random: () => -38,
    uv_wtf8_to_utf16: () => {},
    uv_utf16_length_as_wtf8: () => 0,
    uv_utf16_to_wtf8: () => -38,
    uv_wtf8_length_as_utf16: () => 0,
    __wasm_longjmp: (ptr: number) => {
      if (procExit) procExit(1);
      throw new wasmAny.Exception(cLongjmp, [ptr ?? 0]);
    },
    __wasm_setjmp: () => 0,
    __wasm_setjmp_test: () => 0,
    tmpfile: () => 0,
    clock: () => 0,
    system: () => -1,
    tmpnam: () => 0,
    __c_longjmp: cLongjmp,
  } as WebAssembly.ModuleImports;
}

class RootedPreopenDirectory extends PreopenDirectory {
  #strip(path: string) { return path.replace(/^\/+/, ""); }
  path_open(
    dirflags: number,
    path_str: string,
    oflags: number,
    fs_rights_base: bigint,
    fs_rights_inheriting: bigint,
    fd_flags: number,
  ) {
    return super.path_open(dirflags, this.#strip(path_str), oflags, fs_rights_base, fs_rights_inheriting, fd_flags);
  }
  path_filestat_get(flags: number, path_str: string) { return super.path_filestat_get(flags, this.#strip(path_str)); }
  path_create_directory(path_str: string) { return super.path_create_directory(this.#strip(path_str)); }
  path_unlink_file(path_str: string) { return super.path_unlink_file(this.#strip(path_str)); }
  path_remove_directory(path_str: string) { return super.path_remove_directory(this.#strip(path_str)); }
  path_link(path_str: string, inode: Inode, allow_dir: boolean) { return super.path_link(this.#strip(path_str), inode, allow_dir); }
  path_readlink(path_str: string) { return super.path_readlink(this.#strip(path_str)); }
  path_symlink(old_path: string, new_path: string) {
    const target = (PreopenDirectory.prototype as unknown as { path_symlink?: (oldPath: string, newPath: string) => number }).path_symlink;
    if (!target) return wasi.ERRNO_NOTSUP;
    return target.call(this, this.#strip(old_path), this.#strip(new_path));
  }
}

