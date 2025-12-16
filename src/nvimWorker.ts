import {
  WASI,
  wasi,
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
  wasmPath?: string;
  runtimePath?: string;
  inputBuffer?: SharedArrayBuffer | null;
};

type StopMessage = { type: "stop" };

type InboundMessage = StartMessage | StopMessage;

type DirNode = Directory & { contents: Map<string, any> };

let rpcDecoder: Decoder | null = null;
let activeWasi: WASI | null = null;
let inputFd: RingFd | null = null;
const stderrDecoder = new TextDecoder();
let lastStderr = "";
let fatalSent = false;

// Surface any uncaught errors from the worker itself.
self.addEventListener("error", (ev) => {
  if (fatalSent) return;
  fatalSent = true;
  const msg = ev.message || String(ev.error || "worker error");
  const stack = (ev.error as { stack?: string })?.stack;
  try {
    postMessage({ type: "start-error", message: stack ? `${msg}\n${stack}` : msg });
    postMessage({ type: "exit", code: 1, lastStderr });
  } catch (_) {
    // ignore
  }
});

self.addEventListener("unhandledrejection", (ev) => {
  if (fatalSent) return;
  fatalSent = true;
  const reason = ev.reason;
  const msg = (reason && (reason.message || String(reason))) || "unhandled rejection";
  const stack = (reason as { stack?: string })?.stack;
  try {
    postMessage({ type: "start-error", message: stack ? `${msg}\n${stack}` : msg });
    postMessage({ type: "exit", code: 1, lastStderr });
  } catch (_) {
    // ignore
  }
});

self.onmessage = (event: MessageEvent<InboundMessage>) => {
  const { type } = event.data || {};
  if (type === "start") {
    startNvim(event.data as StartMessage).catch((err) => {
      postMessage({ type: "start-error", message: err?.message || String(err) });
      postMessage({ type: "exit", code: 1 });
    });
  } else if (type === "stop") {
    try {
      activeWasi?.wasiImport?.proc_exit?.(0);
    } catch (_) {
      // ignore
    }
    inputFd = null;
  }
};

class RingFd extends Fd {
  private readonly ctrl: Int32Array;
  private readonly data: Uint8Array;
  private readonly capacity: number;

  constructor(buffer: SharedArrayBuffer) {
    super();
    this.ctrl = new Int32Array(buffer, 0, 2);
    this.data = new Uint8Array(buffer, 8);
    this.capacity = this.data.length;
  }

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ | wasi.RIGHTS_FD_WRITE);
    return { ret: wasi.ERRNO_SUCCESS, fdstat };
  }

  fd_close() { return wasi.ERRNO_SUCCESS; }

  fd_read(size: number) {
    const max = Math.min(Math.max(0, Number(size) || 0), this.capacity);
    if (max === 0) return { ret: wasi.ERRNO_AGAIN, data: new Uint8Array() };
    let head = Atomics.load(this.ctrl, 0);
    const tail = Atomics.load(this.ctrl, 1);
    if (head === tail) return { ret: wasi.ERRNO_AGAIN, data: new Uint8Array() };
    const out = new Uint8Array(max);
    let written = 0;
    while (head !== tail && written < max) {
      out[written++] = this.data[head];
      head = (head + 1) % this.capacity;
    }
    Atomics.store(this.ctrl, 0, head);
    return { ret: wasi.ERRNO_SUCCESS, data: out.slice(0, written) };
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

async function startNvim({ cols, rows, wasmPath, runtimePath, inputBuffer }: StartMessage) {
  let exitCode = 1;
  try {
    if (!inputBuffer) {
      postMessage({ type: "start-error", message: "input buffer missing" });
      postMessage({ type: "exit", code: 1 });
      return;
    }

    rpcDecoder = null;
    inputFd = new RingFd(inputBuffer);

    debugStatus("fetching artifacts");
    const [wasmBytes, runtimeArchive] = await Promise.all([
      fetchBytes(wasmPath || "./nvim.wasm"),
      fetchBytes(runtimePath || "./nvim-runtime.tar.gz"),
    ]);
    debugStatus(`fetched wasm (${wasmBytes.length} bytes)`);
    debugStatus(`fetched runtime (${runtimeArchive.length} bytes)`);

    debugStatus("building filesystem");
    let runtimeBytes: Uint8Array;
    if (looksLikeGzip(runtimeArchive)) {
      try {
        runtimeBytes = gunzipSync(runtimeArchive);
        debugStatus(`gunzipped runtime (${runtimeBytes.length} bytes)`);
      } catch (e) {
        throw new Error(`gunzip runtime failed: ${(e as Error)?.message ?? e}`);
      }
    } else {
      runtimeBytes = runtimeArchive;
      debugStatus(`runtime already uncompressed (${runtimeBytes.length} bytes); skipping gunzip`);
    }
    let untarred: TarEntry[];
    try {
      untarred = untar(runtimeBytes);
      debugStatus(`untar entries: ${untarred.length}`);
    } catch (e) {
      throw new Error(`untar runtime failed: ${(e as Error)?.message ?? e}`);
    }
    const fsRoot = buildFs(untarred, (count) => debugStatus(`filesystem entries: ${count}`));
    debugStatus("filesystem ready");

    const stdinFd = inputFd!;
    const stdoutFd = new SinkFd(handleStdout);
    const stderrFd = new SinkFd((data) => {
      const msg = stderrDecoder.decode(data);
      lastStderr = msg || lastStderr;
      postMessage({ type: "stderr", message: msg });
    });

    const preopen = new RootedPreopenDirectory("nvim", fsRoot.contents);
    const tmpDir = fsRoot.contents.get("tmp") as Directory | undefined;
    const tmp = tmpDir?.contents || new Map();
    const preopenTmp = new RootedPreopenDirectory("tmp", tmp);
    debugStatus("configured filesystem");

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
    debugStatus("creating WASI");
    activeWasi = new WASI(args, env, [stdinFd, stdoutFd, stderrFd, preopen, preopenTmp], { debug: true });
    activeWasi.fds[0] = stdinFd;
    activeWasi.fds[1] = stdoutFd;
    activeWasi.fds[2] = stderrFd;
    activeWasi.fds[3] = preopen;
    activeWasi.fds[4] = preopenTmp;
    (activeWasi as unknown as { preopens: Record<string, PreopenDirectory> }).preopens = { "/nvim": preopen, "/tmp": preopenTmp };

    const envImports = makeEnv(() => activeWasi?.wasiImport?.proc_exit?.(1));
    debugStatus("instantiating wasm");
    const wasmInstance = await WebAssembly.instantiate(wasmBytes, {
      wasi_snapshot_preview1: activeWasi.wasiImport,
      env: envImports,
    });
    debugStatus("starting nvim");
    const instanceSource = wasmInstance as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const instance = instanceSource.instance
      ?? (wasmInstance as unknown as { instance: WebAssembly.Instance }).instance;
    exitCode = activeWasi.start(instance as any);
    debugStatus(`nvim exited (${exitCode})`);
  } catch (err) {
    const message = (err as { message?: string })?.message || String(err);
    const stack = (err as { stack?: string })?.stack;
    postMessage({ type: "start-error", message: stack ? `${message}\n${stack}` : message });
  }

  postMessage({ type: "exit", code: exitCode, lastStderr });
}

function handleStdout(chunk: Uint8Array) {
  if (!rpcDecoder) {
    rpcDecoder = new Decoder(handleMessage);
  }
  try {
    rpcDecoder.push(chunk);
  } catch (err) {
    try {
      // Help diagnose malformed stdout that breaks the RPC stream.
      console.error("[nvim rpc] decoder error", err);
      console.error("[nvim rpc] chunk (hex)", toHex(chunk));
    } catch (_) {
      // ignore
    }
    rpcDecoder = new Decoder(handleMessage);
  }
}

function toHex(data: Uint8Array): string {
  const max = 128; // limit log size
  let out = "";
  for (let i = 0; i < data.length && i < max; i += 1) {
    out += data[i].toString(16).padStart(2, "0");
  }
  return out;
}

function debugStatus(message: string) {
  try {
    postMessage({ type: "start-debug", message });
  } catch (_) {
    // ignore
  }
  try {
    postMessage({ type: "shared-ready" });
  } catch (_) {
    // ignore
  }
}

function handleMessage(msg: unknown) {
  if (!Array.isArray(msg) || msg.length < 1) return;
  const kind = msg[0];
  if (kind === 0) {
    const [, msgid, method, params] = msg;
    if (method === "wasm-clipboard-paste") {
      postMessage({ type: "clipboard-paste", msgid });
    } else {
      postMessage({ type: "rpc-request", msgid, method, params });
    }
  } else if (kind === 1) {
    const [, msgid, error, result] = msg;
    postMessage({ type: "rpc-response", msgid, error, result });
  } else if (kind === 2) {
    const [, method, params] = msg;
    if (method === "wasm-clipboard-copy") {
      const lines = Array.isArray(params?.[0]) ? params[0] : [];
      const regtype = typeof params?.[1] === "string" ? params[1] : "v";
      postMessage({ type: "clipboard-copy", lines, regtype });
    } else if (method === "nvim_buf_lines_event" || method === "nvim_buf_detach_event") {
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
  // `Tag`/`Exception` are part of the wasm exceptions proposal and are not in the TS lib yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wasmAny = WebAssembly as any;
  const cLongjmp = new wasmAny.Tag({ parameters: ["i32"], results: [] });
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
  };
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
  // `path_symlink` exists at runtime but is missing from the shim typings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  path_symlink(old_path: string, new_path: string) {
    const target = (PreopenDirectory.prototype as unknown as { path_symlink?: (oldPath: string, newPath: string) => number }).path_symlink;
    if (!target) return wasi.ERRNO_NOTSUP;
    return target.call(this, this.#strip(old_path), this.#strip(new_path));
  }
}
