import type { editor as MonacoEditor } from "monaco-editor";

import { isInsertLike, isVisualMode } from "./modes";
import type { BufferState } from "./bufferSync";
import { charIndexToByteIndex } from "../utils/utf8";

export type InsertDelegationManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  nowMs: () => number;
  debugLog: (line: string) => void;

  setPreedit: (text: string | null) => void;
  setEditorReadOnly: (readOnly: boolean) => void;

  getRecordingRegister: () => string;
  getExecutingRegister: () => string;
  isNvimBlocking: () => boolean;

  getActiveState: () => BufferState | null;
  ensureActiveState: () => BufferState | null;

  flushPendingMonacoSync: () => void;
  flushPendingMonacoSyncBlocking: () => Promise<void>;
  cancelPendingBufferFlush: () => void;

  isSessionRunning: () => boolean;
  getBufHandle: () => number | null;
  rpcCall: (method: string, params: unknown[]) => Promise<any>;
  sendInput: (keys: string) => void;
};

export type IgnoreInsertExitCursor = { line: number; col0: number; untilMs: number };

export class InsertDelegationManager {
  private readonly init: InsertDelegationManagerInit;

  private delegateInsertToMonaco = false;
  private exitingInsertMode = false;
  private pendingKeysAfterExit = "";
  private exitInsertTimer: number | null = null;
  private optimisticEnterTimer: number | null = null;
  private lastMode = "";
  private suppressDelegationUntil = 0;
  private lastVisualModeAt = 0;

  private dotRepeatKeys = "";
  private dotRepeatBackspaces = 0;
  private delegatedInsertReplayPossible = false;
  private recentNormalKeys = "";
  private lastDelegatedInsertPrefix: string | null = null;
  private lastDelegatedDotRepeat: { prefix: string; keys: string } | null = null;

  private ignoreInsertExitCursor: IgnoreInsertExitCursor | null = null;
  private ignoreMonacoCursorSyncToNvimUntil = 0;

  constructor(init: InsertDelegationManagerInit) {
    this.init = init;
  }

  reset(): void {
    this.delegateInsertToMonaco = false;
    this.exitingInsertMode = false;
    this.pendingKeysAfterExit = "";
    if (this.exitInsertTimer) {
      clearTimeout(this.exitInsertTimer);
      this.exitInsertTimer = null;
    }
    if (this.optimisticEnterTimer) {
      clearTimeout(this.optimisticEnterTimer);
      this.optimisticEnterTimer = null;
    }
    this.dotRepeatKeys = "";
    this.dotRepeatBackspaces = 0;
    this.delegatedInsertReplayPossible = false;
    this.recentNormalKeys = "";
    this.lastDelegatedInsertPrefix = null;
    this.lastDelegatedDotRepeat = null;
    this.ignoreInsertExitCursor = null;
    this.ignoreMonacoCursorSyncToNvimUntil = 0;
    this.lastMode = "";
    this.suppressDelegationUntil = 0;
    this.lastVisualModeAt = 0;
  }

  optimisticEnterDelegatedInsertFromKey(prefixKey: string): void {
    const key = String(prefixKey ?? "");
    if (!key || key.length !== 1) return;
    const safePrefix = key === "i" || key === "a" || key === "I" || key === "A" || key === "o" || key === "O";
    if (!safePrefix) return;
    if (this.delegateInsertToMonaco) return;
    if (this.exitingInsertMode) return;
    const now = this.init.nowMs();
    if (now < this.suppressDelegationUntil) return;
    if (this.init.getRecordingRegister()) return;
    if (this.init.getExecutingRegister()) return;
    if (this.init.isNvimBlocking()) return;

    // Enable delegation immediately to avoid a mode-notify lag window where the
    // first typed characters are handled as normal-mode keys and later applied
    // out of order relative to Monaco->Neovim buffer sync.
    this.delegateInsertToMonaco = true;
    this.init.setEditorReadOnly(false);
    this.init.setPreedit(null);
    this.dotRepeatKeys = "";
    this.dotRepeatBackspaces = 0;
    this.delegatedInsertReplayPossible = true;
    this.lastDelegatedInsertPrefix = key;

    const state = this.init.ensureActiveState();
    if (state) {
      state.shadowLines = this.init.editor.getModel()?.getLinesContent() ?? null;
      state.pendingBufEdits = [];
      state.pendingFullSync = false;
      state.pendingCursorSync = false;
    }

    if (this.optimisticEnterTimer) clearTimeout(this.optimisticEnterTimer);
    this.optimisticEnterTimer = globalThis.setTimeout(() => {
      this.optimisticEnterTimer = null;
      // If we never observed insert-mode, revert to read-only to avoid hosts
      // accidentally editing the model in normal mode.
      if (!isInsertLike(this.lastMode)) {
        this.delegateInsertToMonaco = false;
        this.init.setEditorReadOnly(true);
        const st = this.init.ensureActiveState();
        if (st) {
          if (st.pendingBufEdits.length || st.pendingCursorSync || st.pendingFullSync) {
            this.init.flushPendingMonacoSync();
          }
          st.shadowLines = null;
          st.pendingBufEdits = [];
          st.pendingFullSync = false;
          st.pendingCursorSync = false;
        }
        this.dotRepeatKeys = "";
        this.dotRepeatBackspaces = 0;
        this.delegatedInsertReplayPossible = false;
      }
    }, 250);
  }

  isDelegating(): boolean {
    return this.delegateInsertToMonaco;
  }

  isExitingInsertMode(): boolean {
    return this.exitingInsertMode;
  }

  getIgnoreMonacoCursorSyncToNvimUntil(): number {
    return this.ignoreMonacoCursorSyncToNvimUntil;
  }

  recordRecentNormalKey(key: string): void {
    const k = String(key ?? "");
    if (!k || k.length !== 1 || k.startsWith("<")) return;
    this.recentNormalKeys = (this.recentNormalKeys + k).slice(-16);
  }

  getLastDelegatedDotRepeat(): { prefix: string; keys: string } | null {
    return this.lastDelegatedDotRepeat;
  }

  clearLastDelegatedDotRepeat(): void {
    this.lastDelegatedDotRepeat = null;
  }

  setDelegatedInsertReplayPossible(possible: boolean): void {
    this.delegatedInsertReplayPossible = Boolean(possible);
  }

  appendPendingKeysAfterExit(keys: string): void {
    this.pendingKeysAfterExit += String(keys ?? "");
  }

  shouldIgnoreInsertExitCursor(nowMs: number, ln: unknown, col0: unknown): boolean {
    const g = this.ignoreInsertExitCursor;
    if (!g) return false;
    const now = Number(nowMs) || 0;
    if (now >= g.untilMs) {
      this.ignoreInsertExitCursor = null;
      return false;
    }
    return Number(ln) === g.line && Number(col0) === g.col0 && g.col0 > 0;
  }

  suppressDelegation(ms: number): void {
    const dur = Math.max(0, Math.floor(Number(ms) || 0));
    if (dur <= 0) return;
    this.suppressDelegationUntil = Math.max(this.suppressDelegationUntil, this.init.nowMs() + dur);
  }

  applyMode(mode: string): void {
    const prevMode = this.lastMode;
    this.lastMode = String(mode ?? "");
    const now = this.init.nowMs();
    if (isVisualMode(mode)) this.lastVisualModeAt = now;
    const prefix = computeDelegatedInsertPrefix(this.recentNormalKeys);
    const visualInsert = (prefix === "I" || prefix === "A") && (now - this.lastVisualModeAt) < 250;
    const safePrefix = prefix === "i" || prefix === "a" || prefix === "I" || prefix === "A" || prefix === "o" || prefix === "O";
    const enteringInsertFromNormal = isInsertLike(mode) && String(prevMode ?? "").startsWith("n");
    const nextDelegate = enteringInsertFromNormal
      ? (
        safePrefix
        && !this.init.getRecordingRegister()
        && !this.init.getExecutingRegister()
        && !this.init.isNvimBlocking()
        && now >= this.suppressDelegationUntil
        && !visualInsert
      )
      : (
        isInsertLike(mode)
          ? (
            this.delegateInsertToMonaco
            && !this.init.getRecordingRegister()
            && !this.init.getExecutingRegister()
            && !this.init.isNvimBlocking()
            && now >= this.suppressDelegationUntil
          )
          : false
      );
    if (nextDelegate !== this.delegateInsertToMonaco) {
      const turnedOn = nextDelegate && !this.delegateInsertToMonaco;
      this.delegateInsertToMonaco = nextDelegate;
      this.init.setEditorReadOnly(!nextDelegate);
      const state = this.init.ensureActiveState();
      if (nextDelegate) {
        this.init.setPreedit(null);
        this.dotRepeatKeys = "";
        this.dotRepeatBackspaces = 0;
        this.delegatedInsertReplayPossible = true;
        this.lastDelegatedInsertPrefix = prefix;
        if (state) {
          state.shadowLines = this.init.editor.getModel()?.getLinesContent() ?? null;
          state.pendingBufEdits = [];
          state.pendingFullSync = false;
          state.pendingCursorSync = false;
        }
      } else {
        if (state) {
          if (state.pendingBufEdits.length || state.pendingCursorSync || state.pendingFullSync) {
            this.init.flushPendingMonacoSync();
          }
          state.shadowLines = null;
          state.pendingBufEdits = [];
          state.pendingFullSync = false;
          state.pendingCursorSync = false;
        }
        this.dotRepeatKeys = "";
        this.dotRepeatBackspaces = 0;
        this.delegatedInsertReplayPossible = false;
      }
      if (turnedOn) {
      }
    }

    if (this.exitingInsertMode && !isInsertLike(mode)) {
      if (this.exitInsertTimer) {
        clearTimeout(this.exitInsertTimer);
        this.exitInsertTimer = null;
      }
      this.exitingInsertMode = false;
      const pending = this.pendingKeysAfterExit;
      this.pendingKeysAfterExit = "";
      if (pending) this.init.sendInput(pending);
    }
  }

  armInsertExit(): void {
    this.exitingInsertMode = true;
    this.ignoreMonacoCursorSyncToNvimUntil = this.init.nowMs() + 250;
    this.pendingKeysAfterExit = "";
    if (this.exitInsertTimer) {
      clearTimeout(this.exitInsertTimer);
      this.exitInsertTimer = null;
    }
    this.init.cancelPendingBufferFlush();
    this.exitInsertTimer = globalThis.setTimeout(() => {
      this.exitInsertTimer = null;
      if (!this.exitingInsertMode) return;
      const pending = this.pendingKeysAfterExit;
      this.pendingKeysAfterExit = "";
      if (pending) this.init.sendInput(pending);
    }, 800);
  }

  finalizeDelegatedInsertDotRepeat(): void {
    const prefix = this.lastDelegatedInsertPrefix;
    const keys = this.dotRepeatKeys;
    if (this.delegatedInsertReplayPossible && prefix && keys) {
      this.lastDelegatedDotRepeat = { prefix, keys };
    } else {
      this.lastDelegatedDotRepeat = null;
    }
    this.dotRepeatKeys = "";
    this.dotRepeatBackspaces = 0;
    this.delegatedInsertReplayPossible = false;
  }

  exitDelegatedInsertMode(exitKey: string): void {
    this.init.debugLog(
      `exitDelegatedInsertMode: key=${JSON.stringify(exitKey)} prefix=${JSON.stringify(this.lastDelegatedInsertPrefix)} dotKeysLen=${this.dotRepeatKeys.length} replayPossible=${this.delegatedInsertReplayPossible}`,
    );
    this.finalizeDelegatedInsertDotRepeat();
    this.armInsertExit();
    void this.performDelegatedInsertExit(exitKey);
  }

  handleDelegatedInsertPatched(res: {
    resetDotRepeat?: boolean;
    resetReplayPossible?: boolean;
    dotRepeat?: { deleted: number; text: string } | null;
  }): void {
    const resetDotRepeat = Boolean(res.resetDotRepeat);
    const resetReplayPossible = Boolean(res.resetReplayPossible);
    const dotRepeat = res.dotRepeat ?? null;
    try {
      if (resetDotRepeat) {
        this.dotRepeatKeys = "";
        this.dotRepeatBackspaces = 0;
        this.delegatedInsertReplayPossible = false;
      } else if (dotRepeat) {
        const { deleted, text } = dotRepeat;
        if (deleted > 0) {
          this.dotRepeatBackspaces += deleted;
          this.dotRepeatKeys += "<BS>".repeat(deleted);
        }
        if (text) {
          this.dotRepeatKeys += text;
        }
        if (this.dotRepeatKeys.length > 20000) {
          this.dotRepeatKeys = "";
          this.dotRepeatBackspaces = 0;
          this.delegatedInsertReplayPossible = false;
        }
      }
      if (resetReplayPossible) {
        this.delegatedInsertReplayPossible = false;
      }
    } catch (_) {
    }
  }

  consumeDotRepeat(): { keys: string; backspaces: number } {
    const keys = this.dotRepeatKeys;
    const backspaces = this.dotRepeatBackspaces;
    this.dotRepeatKeys = "";
    this.dotRepeatBackspaces = 0;
    return { keys, backspaces };
  }

  setIgnoreInsertExitCursorFromEditor(): void {
    const model = this.init.editor.getModel();
    const pos = this.init.editor.getPosition();
    if (!model || !pos) return;
    const text = model.getLineContent(pos.lineNumber) ?? "";
    const byteCol0 = charIndexToByteIndex(text, Math.max(0, pos.column - 1));
    this.ignoreInsertExitCursor = { line: pos.lineNumber, col0: byteCol0, untilMs: this.init.nowMs() + 400 };
    this.init.debugLog(`exitDelegatedInsertMode: sync cursor before exit: line=${pos.lineNumber} col=${pos.column} (byteCol0=${byteCol0})`);
  }

  private async performDelegatedInsertExit(exitKey: string): Promise<void> {
    if (!this.init.isSessionRunning()) return;
    const buf = this.init.getBufHandle();
    if (!buf) return;

    try {
      this.init.debugLog(`performDelegatedInsertExit: begin buf=${buf} exitKey=${JSON.stringify(exitKey)}`);
    } catch (_) {
    }

    try {
      await this.init.flushPendingMonacoSyncBlocking();
    } catch (_) {
    }

    try {
      this.setIgnoreInsertExitCursorFromEditor();
      const g = this.ignoreInsertExitCursor;
      if (g) {
        await this.init.rpcCall("nvim_win_set_cursor", [0, [g.line, g.col0]]);
      }
    } catch (_) {
    }

    try {
      await this.init.rpcCall("nvim_input", [exitKey]);
    } catch (_) {
      this.init.sendInput(exitKey);
    }

    try {
      this.init.debugLog(`performDelegatedInsertExit: sent exitKey=${JSON.stringify(exitKey)}`);
    } catch (_) {
    }
  }
}

function computeDelegatedInsertPrefix(recentNormalKeys: string): string | null {
  const raw = String(recentNormalKeys ?? "");
  const last1 = raw.slice(-1);
  const last2 = raw.slice(-2);
  const single = new Set(["i", "a", "I", "A", "o", "O", "s", "S", "C", "R"]);
  if (last2 === "cc") return "cc";
  if (single.has(last1)) return last1;
  const idx = raw.lastIndexOf("c");
  if (idx < 0) return null;
  let start = idx;
  while (start > 0 && /\d/.test(raw[start - 1] ?? "")) start -= 1;
  return raw.slice(start);
}
