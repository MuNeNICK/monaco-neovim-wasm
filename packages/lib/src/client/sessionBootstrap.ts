import { NeovimWasmSession, type NeovimWasmInputMode, type NeovimWasmSessionHandlers } from "../neovimWasmSession";
import { normalizeSessionFiles, mergeSessionFiles } from "../utils/sessionFiles";

export type EnsureSessionArgs = {
  current: NeovimWasmSession | null;
  reuseWorker: boolean;
  worker?: Worker | null;
  workerUrl?: URL;
  inputMode: NeovimWasmInputMode;
  sharedInputBytes: number;
  rpcTimeoutMs: number;
  handlers: NeovimWasmSessionHandlers;
};

export function ensureSession(args: EnsureSessionArgs): NeovimWasmSession {
  const current = args.current;
  if (!current || !args.reuseWorker) {
    return new NeovimWasmSession({
      worker: args.worker,
      workerUrl: args.workerUrl,
      inputMode: args.inputMode,
      sharedInputBytes: args.sharedInputBytes,
      rpcTimeoutMs: args.rpcTimeoutMs,
      reuseWorker: args.reuseWorker,
      handlers: args.handlers,
    });
  }
  current.setHandlers(args.handlers);
  return current;
}

export type StartSessionArgs = {
  cols: number;
  rows: number;
  wasmPath: string;
  runtimePath: string;
  inputMode: NeovimWasmInputMode;
  env?: Record<string, string>;
  files?: Array<{ path: string; data: Uint8Array | string }>;

  includeOverrides: boolean;
  motionOverridesVim: string;
  scrollingOverridesVim: string;
  hostCommandsOverridesVim: string;
};

export async function startSession(session: NeovimWasmSession, args: StartSessionArgs): Promise<void> {
  if (!args.wasmPath || !args.runtimePath) {
    throw new Error("wasmPath/runtimePath is required (use @monaco-neovim-wasm/wasm or @monaco-neovim-wasm/wasm-async for defaults).");
  }

  const extraFiles = args.includeOverrides
    ? [
      { path: "home/.config/nvim/monaco-neovim-wasm/motion.vim", data: args.motionOverridesVim },
      { path: "home/.config/nvim/monaco-neovim-wasm/scrolling.vim", data: args.scrollingOverridesVim },
      { path: "home/.config/nvim/monaco-neovim-wasm/host-commands.vim", data: args.hostCommandsOverridesVim },
    ]
    : [];

  await session.start({
    cols: args.cols,
    rows: args.rows,
    wasmPath: args.wasmPath,
    runtimePath: args.runtimePath,
    inputMode: args.inputMode,
    env: args.env,
    files: normalizeSessionFiles(mergeSessionFiles(args.files, extraFiles)),
  });
}

export function stopOrDisposeSession(
  session: NeovimWasmSession | null,
  reuseWorker: boolean,
): NeovimWasmSession | null {
  if (!session) return null;
  if (reuseWorker) {
    session.stop({ terminate: false, silent: true });
    return session;
  }
  session.dispose();
  return null;
}

export function disposeSession(session: NeovimWasmSession | null): null {
  if (session) session.dispose();
  return null;
}

