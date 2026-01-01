import {
  WASI,
  wasi,
  Directory,
  Fd,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import { Decoder } from "./msgpack";
import { applyExtraFiles, buildFs, FORWARD_NOTIFY_METHODS, getCachedRuntimeEntries, getCachedWasmBytes, makeEnv, RootedPreopenDirectory, type WorkerFile } from "./nvimWorkerCommon";
type StartMessage = {
  type: "start";
  cols?: number;
  rows?: number;
  wasmPath: string;
  runtimePath: string;
  inputBuffer?: SharedArrayBuffer | null;
  env?: Record<string, string> | null;
  files?: WorkerFile[] | null;
};

type StopMessage = { type: "stop" };

type InboundMessage = StartMessage | StopMessage;

let rpcDecoder: Decoder | null = null;
let activeWasi: WASI | null = null;
let inputFd: RingFd | null = null;
const stderrDecoder = new TextDecoder();
let lastStderr = "";
let fatalSent = false;

self.addEventListener("error", (ev) => {
  if (fatalSent) return;
  fatalSent = true;
  const msg = ev.message || String(ev.error || "worker error");
  const stack = (ev.error as { stack?: string })?.stack;
  try {
    postMessage({ type: "start-error", message: stack ? `${msg}\n${stack}` : msg });
    postMessage({ type: "exit", code: 1, lastStderr });
  } catch (_) {
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

async function startNvim({ cols, rows, wasmPath, runtimePath, inputBuffer, env: extraEnv, files }: StartMessage) {
  let exitCode = 1;
  try {
    if (!inputBuffer) {
      postMessage({ type: "start-error", message: "input buffer missing" });
      postMessage({ type: "exit", code: 1 });
      return;
    }

    rpcDecoder = null;
    inputFd = new RingFd(inputBuffer);

    const wasmBytes = await getCachedWasmBytes(wasmPath);
    const untarred = await getCachedRuntimeEntries(runtimePath);
    const fsRoot = buildFs(untarred, () => {});
    if (files && Array.isArray(files) && files.length) applyExtraFiles(fsRoot, files);

    const stdinFd = inputFd!;
    const stdoutFd = new SinkFd(handleStdout);
    const stderrFd = new SinkFd((data) => {
      const msg = stderrDecoder.decode(data);
      if (msg) {
        lastStderr = (lastStderr + msg).slice(-8192);
      }
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
    const wasmInstance = await WebAssembly.instantiate(wasmBytes, {
      wasi_snapshot_preview1: activeWasi.wasiImport,
      env: envImports,
    });
    const instanceSource = wasmInstance as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const instance = instanceSource.instance
      ?? (wasmInstance as unknown as { instance: WebAssembly.Instance }).instance;
    exitCode = activeWasi.start(instance as any);
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
    void err;
    rpcDecoder = new Decoder(handleMessage);
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
    } else {
      const m = typeof method === "string" ? method : "";
      if (FORWARD_NOTIFY_METHODS.has(m)) {
        postMessage({ type: "rpc-notify", method: m, params });
      }
    }
  }
}
