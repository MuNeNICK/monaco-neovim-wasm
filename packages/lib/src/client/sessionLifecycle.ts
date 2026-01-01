import type { NeovimWasmInputMode, NeovimWasmSessionHandlers } from "../neovimWasmSession";
import { NeovimWasmSession } from "../neovimWasmSession";
import type { StatusEmitter } from "../types";
import {
  disposeSession,
  ensureSession,
  startSession,
  stopOrDisposeSession,
  type EnsureSessionArgs,
  type StartSessionArgs,
} from "./sessionBootstrap";

export type CreateSessionHandlersArgs = {
  status: StatusEmitter;
  onNotify: (method: string, params: unknown[]) => void | Promise<void>;
  onRequest: (msgid: number, method: string, params: unknown[]) => void;
  onClipboardCopy: (lines: string[], regtype: string) => void;
  onClipboardPaste: (msgid: number) => void;
  onStderr?: (text: string) => void;
  onStartError?: (message?: string) => void;
  onExit?: (code: number, lastStderr?: string) => void;
  onWarning?: (message: string) => void;
};

export function createSessionHandlers(args: CreateSessionHandlersArgs): NeovimWasmSessionHandlers {
  return {
    onNotify: args.onNotify,
    onRequest: args.onRequest,
    onClipboardCopy: args.onClipboardCopy,
    onClipboardPaste: args.onClipboardPaste,
    onStderr: (message?: string) => {
      const text = message == null ? "" : String(message);
      try { args.onStderr?.(text); } catch (_) {}
    },
    onStartError: (message?: string) => {
      try { args.onStartError?.(message); } catch (_) {}
      args.status(`start failed: ${message ?? "unknown"}`, true);
    },
    onExit: (code: number, lastStderr?: string) => {
      const suffix = lastStderr ? `: ${lastStderr.trim()}` : "";
      args.status(`nvim exited (${code})${suffix}`, code !== 0);
      try { args.onExit?.(code, lastStderr); } catch (_) {}
    },
    onWarning: (message: string) => {
      try { args.onWarning?.(message); } catch (_) {}
      args.status(message, true);
    },
  };
}

export async function startOrReuseSession(args: {
  current: NeovimWasmSession | null;
  reuseWorker: boolean;
  worker?: Worker | null;
  workerUrl?: URL;
  inputMode: NeovimWasmInputMode;
  sharedInputBytes: number;
  rpcTimeoutMs: number;
  handlers: NeovimWasmSessionHandlers;
  start: StartSessionArgs;
}): Promise<NeovimWasmSession> {
  const sessionArgs: EnsureSessionArgs = {
    current: args.current,
    reuseWorker: args.reuseWorker,
    worker: args.worker,
    workerUrl: args.workerUrl,
    inputMode: args.inputMode,
    sharedInputBytes: args.sharedInputBytes,
    rpcTimeoutMs: args.rpcTimeoutMs,
    handlers: args.handlers,
  };
  const session = ensureSession(sessionArgs);
  await startSession(session, args.start);
  return session;
}

export function stopSession(session: NeovimWasmSession | null, reuseWorker: boolean): NeovimWasmSession | null {
  return stopOrDisposeSession(session, reuseWorker);
}

export function disposeSessionNow(session: NeovimWasmSession | null): null {
  return disposeSession(session);
}

