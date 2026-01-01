import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";
import { NeovimWasmSession } from "../neovimWasmSession";
import type { ClipboardAdapter, FileSystemAdapter, HostCommand, MonacoNeovimOptions, PopupMenuItem, StatusEmitter } from "../types";
import { OverlayManager, type PopupMenuItem as OverlayPopupMenuItem } from "./overlays";
import { RedrawManager } from "./redraw";
import { installTextInputListeners } from "./textInputListeners";
import { isCmdlineLike, isInsertLike, isVisualMode } from "./modes";
import { BufferSyncManager, type BufferState } from "./bufferSync";
import { HostAutocmdInstaller } from "./hostAutocmdInstaller";
import { BufferManager } from "./buffers";
import { SearchHighlightManager } from "./searchHighlights";
import { ClipboardManager } from "./clipboard";
import { HostCommandManager } from "./hostCommands";
import { VisualSelectionManager } from "./visualSelection";
import { CursorManager, clampCursor } from "./cursor";
import { ViewportManager } from "./viewport";
import { InsertDelegationManager } from "./insertDelegation";
import { RecordingManager } from "./recording";
import { KeyHandlerManager } from "./keyHandler";
import { KeyAllowlistManager } from "./keyAllowlist";
import { SessionPrimeManager, type SessionPrimeOptions } from "./sessionPrime";
import motionOverridesVim from "../overrides/motion.vim?raw";
import scrollingOverridesVim from "../overrides/scrolling.vim?raw";
import hostCommandsOverridesVim from "../overrides/host-commands.vim?raw";
import VISUAL_SELECTION_LUA from "../lua/visualSelection.lua?raw";
import SEARCH_HIGHLIGHT_LUA from "../lua/searchHighlight.lua?raw";
import { charIndexToByteIndex } from "../utils/utf8";
import { MouseManager } from "./mouse";
import { normalizeNvimInputText, translateKey } from "../utils/nvimInput";
import { extractBufId } from "../utils/msgpackHandles";
import { EditorListenersManager } from "./editorListeners";
import { CursorPositionHandler } from "./editorCursorPosition";
import { NotifyRouter } from "./notifyRouter";
import { InputEventDeduper } from "./inputEventDeduper";
import { ExecLuaClient } from "./execLua";
import { resolveOptions, type MonacoNeovimResolvedOptions } from "./options";
import { ResizeManager } from "./resize";
import { createSessionHandlers, disposeSessionNow, startOrReuseSession, stopSession } from "./sessionLifecycle";

export type { ClipboardAdapter, FileSystemAdapter, HostCommand, MonacoNeovimOptions, PopupMenuItem, StatusEmitter } from "../types";

let globalInstanceCounter = 0;


export class MonacoNeovimClient {
  private readonly editor: MonacoEditor.IStandaloneCodeEditor;
  private readonly opts: MonacoNeovimResolvedOptions;
  private session: NeovimWasmSession | null = null;
  private readonly notifyHandlers: Map<string, (params: unknown[]) => void | Promise<void>>;
  private bufHandle: number | null = null;
  private uiCols = 0;
  private uiRows = 0;
  private wrapColumnApplied: number | null = null;
  private wrapStrategyApplied: "simple" | "advanced" | null = null;
  private primeSent = false;
  private suppressCursorSync = false;
  private lastMode = "";
  private monacoPrevOccurrencesHighlight: ("off" | "singleFile" | "multiFile") | null = null;
  private monacoPrevSelectionHighlight: boolean | null = null;
  private monacoPrevSelectionHighlightMultiline: boolean | null = null;
  private monacoHighlightsSuppressed = false;
  private pendingNvimBufUpdates = 0;
  private readonly notifyRouter: NotifyRouter;
  private readonly hostAutocmdInstaller: HostAutocmdInstaller;
  private nvimScrolloff = 0;
  private readonly keyAllowlist: KeyAllowlistManager;
  private readonly execLuaClient: ExecLuaClient;
  private nextSeedLines: string[] | null = null;
  private readonly overlays: OverlayManager;
  private readonly editorListeners: EditorListenersManager;
  private readonly redraw: RedrawManager;
  private readonly bufferSync: BufferSyncManager;
  private readonly bufferManager: BufferManager;
  private readonly searchHighlights: SearchHighlightManager;
  private readonly clipboard: ClipboardManager;
  private readonly hostCommandManager: HostCommandManager;
  private readonly cursor: CursorManager;
  private readonly viewport: ViewportManager;
  private readonly recording: RecordingManager;
  private readonly insertDelegation: InsertDelegationManager;
  private readonly visualSelection: VisualSelectionManager;
  private readonly keyHandler: KeyHandlerManager;
  private readonly mouse: MouseManager;
  private readonly cursorPositionHandler: CursorPositionHandler;
  private readonly sessionPrime: SessionPrimeManager;
  private readonly instanceId = ++globalInstanceCounter;
  private readonly instanceClassName = `monaco-neovim-wasm-instance-${this.instanceId}`;
  private readonly resizeManager: ResizeManager;
  private compositionActive = false;
  private pendingResyncAfterComposition = false;
  private readonly inputEventDeduper: InputEventDeduper;
  private pendingEscAfterComposition = false;
  private lastClipboardText: string | null = null;
  private lastImeCommitAt = 0;
  private lastImeCommitText = "";
  private nvimBlocking = false;
  private nvimExecuting = "";
  private editorReadOnly: boolean | null = null;
  private applyingFromNvim = false;
  private ignoreSelectionSyncUntil = 0;
  private acceptNvimBufLinesDuringDelegatedInsertUntil = 0;
  private pendingModePull = false;

  private debugLog(line: string): void {
    if (!this.opts.debug) return;
    try {
      const msg = `[monaco-neovim-wasm] ${line}`;
      if (this.opts.debugLog) this.opts.debugLog(msg);
      else if (typeof console !== "undefined") console.log(msg);
    } catch (_) {
    }
  }

  private nowMs(): number {
    return (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  }

  private sendImeText(text: string): void {
    const payload = String(text ?? "");
    if (!payload) return;
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (payload.length > 1 && payload === this.lastImeCommitText && (now - this.lastImeCommitAt) < 60) return;
    this.lastImeCommitText = payload;
    this.lastImeCommitAt = now;
    this.sendInput(normalizeNvimInputText(payload, true));
  }

  constructor(editor: MonacoEditor.IStandaloneCodeEditor, options: MonacoNeovimOptions = {}) {
    this.editor = editor;
    this.inputEventDeduper = new InputEventDeduper({ nowMs: () => this.nowMs() });
    this.opts = resolveOptions(options, { translateKey });
    this.execLuaClient = new ExecLuaClient((method, params) => this.rpcCall(method, params));
    this.resizeManager = new ResizeManager({
      editor: this.editor,
      minCols: this.opts.minCols,
      minRows: this.opts.minRows,
      fallbackCols: this.opts.cols,
      fallbackRows: this.opts.rows,
      debounceMs: this.opts.resizeDebounceMs,
    });
    this.keyAllowlist = new KeyAllowlistManager({
      ctrlKeysForNormalMode: this.opts.ctrlKeysForNormalMode,
      ctrlKeysForInsertMode: this.opts.ctrlKeysForInsertMode,
      altKeysForNormalMode: this.opts.altKeysForNormalMode,
      altKeysForInsertMode: this.opts.altKeysForInsertMode,
      metaKeysForNormalMode: this.opts.metaKeysForNormalMode,
      metaKeysForInsertMode: this.opts.metaKeysForInsertMode,
    });
    this.overlays = new OverlayManager({
      editor: this.editor,
      cmdlineContainer: this.opts.cmdlineContainer,
      callbacks: {
        onCmdline: this.opts.onCmdline,
        onMessage: this.opts.onMessage,
        onPopupmenu: (items, selected) => {
          try { this.opts.onPopupmenu?.(items as any, selected); } catch (_) {}
        },
      },
    });
    this.bufferManager = new BufferManager({ editor: this.editor });
    this.editorListeners = new EditorListenersManager({
      editor: this.editor,
      instanceClassName: this.instanceClassName,
    });
    this.hostAutocmdInstaller = new HostAutocmdInstaller({
      isClipboardEnabled: () => this.opts.clipboard !== null,
      isWrappedLineMotionsEnabled: () => Boolean(this.opts.wrappedLineMotions),
      isScrollMotionsEnabled: () => Boolean(this.opts.scrollMotions),
      isSyncScrolloffEnabled: () => Boolean(this.opts.syncScrolloff),
      hasScrolloffOverride: () => this.opts.scrolloff != null,
      isHostCommandsEnabled: () => Boolean(this.opts.hostCommands),
      rpcCall: (method, params) => this.rpcCall(method, params),
      execLua: (code, args) => this.execLua(code, args),
    });
    this.sessionPrime = new SessionPrimeManager({
      editor: this.editor,
      opts: this.opts as unknown as SessionPrimeOptions,
      getUiCols: () => this.uiCols,
      getUiRows: () => this.uiRows,
      getBufHandle: () => this.bufHandle,
      setBufHandle: (id) => { this.bufHandle = id; },
      getNextSeedLines: () => this.nextSeedLines,
      clearNextSeedLines: () => { this.nextSeedLines = null; },
      extractBufId: (val) => extractBufId(val),
      rpcCall: (method, params) => this.rpcCall(method, params),
      sendNotify: (method, params) => this.sendNotify(method, params),
      execLua: (code, args) => this.execLua(code, args),
      seedBuffer: (bufId, seedLines) => this.seedBuffer(bufId, seedLines),
      applyBuffer: (lines) => this.applyBuffer(lines),
      ensureActiveState: () => Boolean(this.ensureActiveState()),
      setBufferName: (bufId, name) => this.bufferManager.setName(bufId, name),
      setBufferFiletype: (bufId, filetype) => this.bufferManager.setFiletype(bufId, filetype),
      syncTabstopFromMonaco: () => this.syncTabstopFromMonaco(),
      installHostAutocmds: () => this.installHostAutocmds(),
      syncVisualSelectionColor: () => this.syncVisualSelectionColor(),
      getLastMode: () => this.lastMode,
      setLastMode: (mode) => { this.lastMode = mode; },
      focusEditor: () => this.editor.focus(),
      scheduleResizeToEditor: () => this.scheduleResizeToEditor(),
    });
    this.redraw = new RedrawManager({
      setCmdline: (text) => this.setCmdline(text),
      setCmdlineCursor: (bytePos) => this.setCmdlineCursor(bytePos),
      setMessage: (text) => this.setMessage(text),
      setPopupmenu: (items, selected) => this.setPopupmenu(items as unknown as OverlayPopupMenuItem[] | null, selected),
      updatePopupmenuSelection: (selected) => this.updatePopupmenuSelection(selected),
      scheduleSearchHighlightRefresh: () => this.scheduleSearchHighlightRefresh(),
      getMessageText: () => this.overlays.getMessageText(),
      cmdlineSetCursorMapping: (prefixBytes, contentBytes) => this.overlays.setCmdlineCursorMapping(prefixBytes, contentBytes),
      cmdlineMapPos: (pos) => this.overlays.mapCmdlinePos(pos),
      isHostAutocmdInstalled: () => this.hostAutocmdInstaller.isInstalled(),
      applyNvimModeFromRedraw: (mode) => this.applyNvimMode(mode),
      debugLog: (line) => this.debugLog(line),
    });
    this.bufferSync = new BufferSyncManager({
      editor: this.editor,
      nowMs: () => this.nowMs(),
      debugLog: (line) => this.debugLog(line),
      rpcCall: (method, params) => this.rpcCall(method, params),
      sendNotify: (method, params) => this.sendNotify(method, params),
      isSessionRunning: () => Boolean(this.session && this.session.isRunning()),
      getBufHandle: () => this.bufHandle,
      getActiveState: () => this.getActiveState(),
      ensureActiveState: () => this.ensureActiveState(),
      getBufferState: (id) => this.bufferManager.getById(id),
      isDelegateInsertToMonaco: () => this.insertDelegation.isDelegating(),
      isExitingInsertMode: () => this.insertDelegation.isExitingInsertMode(),
      shouldAcceptNvimBufLinesDuringDelegatedInsert: () => this.nowMs() < this.acceptNvimBufLinesDuringDelegatedInsertUntil,
      isCompositionActive: () => this.compositionActive,
      setPendingResyncAfterComposition: (pending) => { this.pendingResyncAfterComposition = pending; },
      getSyncModelFromMonaco: () => this.opts.syncModelFromMonaco,
      getInsertSyncDebounceMs: () => this.opts.insertSyncDebounceMs,
      scheduleVisualSelectionRefresh: () => this.visualSelection.scheduleRefresh(),
      scheduleCursorRefresh: () => this.scheduleCursorRefresh(),
      getLastMode: () => this.lastMode,
      isVisualMode: (mode) => isVisualMode(mode),
      incrementPendingNvimBufUpdates: () => { this.pendingNvimBufUpdates += 1; },
      decrementPendingNvimBufUpdates: () => {
        this.pendingNvimBufUpdates = Math.max(0, this.pendingNvimBufUpdates - 1);
        return this.pendingNvimBufUpdates;
      },
      isPendingVisualRefresh: () => this.visualSelection.isPendingRefresh(),
      setPendingVisualRefresh: (pending) => { this.visualSelection.setPendingRefresh(pending); },
      getLastCursorPos: () => this.cursor.getLastCursorPos(),
      getEditorPosition: () => this.editor.getPosition(),
      setSuppressCursorSync: (suppress) => { this.suppressCursorSync = suppress; },
      setApplyingFromNvim: (applying) => { this.applyingFromNvim = applying; },
      isApplyingFromNvim: () => this.applyingFromNvim,
      syncCursorToNvimNow: () => this.syncCursorToNvimNow(),
    });
    this.searchHighlights = new SearchHighlightManager({
      editor: this.editor,
      isEnabled: () => this.opts.searchHighlights,
      isSessionRunning: () => Boolean(this.session && this.session.isRunning()),
      getBufHandle: () => this.bufHandle,
      execLua: (code, args) => this.execLua(code, args),
      luaScript: SEARCH_HIGHLIGHT_LUA,
      isStagingFrame: () => this.redraw.isStagingFrame(),
      markSearchRefresh: () => this.redraw.markSearchRefresh(),
      debugLog: (line) => this.debugLog(line),
    });
    this.clipboard = new ClipboardManager({
      adapter: this.opts.clipboard,
      status: this.opts.status,
      getLastClipboardText: () => this.lastClipboardText ?? "",
      setLastClipboardText: (text) => { this.lastClipboardText = String(text ?? ""); },
      sendRpcResponse: (msgid, error, result) => this.sendRpcResponse(msgid, error, result),
      debugLog: (line) => this.debugLog(line),
    });
    this.recording = new RecordingManager({
      isSessionRunning: () => Boolean(this.session && this.session.isRunning()),
      rpcCall: (method, params) => this.rpcCall(method, params),
    });
    this.cursor = new CursorManager({
      editor: this.editor,
      nowMs: () => this.nowMs(),
      debugLog: (line) => this.debugLog(line),
      isCompositionActive: () => this.compositionActive,
      setSuppressCursorSync: (suppress) => { this.suppressCursorSync = suppress; },
      isSessionRunning: () => Boolean(this.session && this.session.isRunning()),
      rpcCall: (method, params) => this.rpcCall(method, params),
      getLastMode: () => this.lastMode,
      setLastMode: (mode) => { this.lastMode = mode; },
      onModeChange: this.opts.onModeChange,
    });
    this.insertDelegation = new InsertDelegationManager({
      editor: this.editor,
      nowMs: () => this.nowMs(),
      debugLog: (line) => this.debugLog(line),
      setPreedit: (text) => this.setPreedit(text),
      setEditorReadOnly: (readOnly) => this.setEditorReadOnly(readOnly),
      getRecordingRegister: () => this.recording.getRegister(),
      getExecutingRegister: () => this.nvimExecuting,
      isNvimBlocking: () => this.nvimBlocking,
      getActiveState: () => this.getActiveState(),
      ensureActiveState: () => this.ensureActiveState(),
      flushPendingMonacoSync: () => this.flushPendingMonacoSync(),
      flushPendingMonacoSyncBlocking: () => this.flushPendingMonacoSyncBlocking(),
      cancelPendingBufferFlush: () => this.bufferSync.cancelPendingFlush(),
      isSessionRunning: () => Boolean(this.session && this.session.isRunning()),
      getBufHandle: () => this.bufHandle,
      rpcCall: (method, params) => this.rpcCall(method, params),
      sendInput: (keys) => this.sendInput(keys),
    });
    this.viewport = new ViewportManager({
      editor: this.editor,
      getUiRows: () => this.uiRows,
      getDefaultRows: () => this.opts.rows,
      getScrolloffOverride: () => this.opts.scrolloff,
      isSyncScrolloffEnabled: () => this.opts.syncScrolloff,
      getNvimScrolloff: () => this.nvimScrolloff,
      isCompositionActive: () => this.compositionActive,
      isDelegateInsertToMonaco: () => this.insertDelegation.isDelegating(),
      setSuppressCursorSync: (suppress) => { this.suppressCursorSync = suppress; },
      setLastCursorPos: (pos) => { this.cursor.setLastCursorPos(pos); },
      requestSearchHighlightRefresh: () => this.requestSearchHighlightRefresh(),
    });
    this.hostCommandManager = new HostCommandManager({
      editor: this.editor,
      bufferManager: this.bufferManager,
      fileSystem: this.opts.fileSystem,
      onHostCommand: this.opts.onHostCommand,
      status: this.opts.status,
      seedName: this.opts.seedName,
      rpcCall: (method, params) => this.rpcCall(method, params),
      openText: (args) => this.openText(args),
      getActiveState: () => this.getActiveState(),
    });
    this.visualSelection = new VisualSelectionManager({
      editor: this.editor,
      nowMs: () => this.nowMs(),
      debugLog: (line) => this.debugLog(line),
      isDebug: () => this.opts.debug,
      isSessionRunning: () => Boolean(this.session && this.session.isRunning()),
      getBufHandle: () => this.bufHandle,
      getLastMode: () => this.lastMode,
      setLastMode: (mode) => { this.lastMode = mode; },
      applyCursorStyle: (mode) => this.cursor.applyCursorStyle(mode),
      onModeChange: this.opts.onModeChange,
      getPendingNvimBufUpdates: () => this.pendingNvimBufUpdates,
      isDelegateInsertToMonaco: () => this.insertDelegation.isDelegating(),
      isSuppressCursorSync: () => this.suppressCursorSync,
      isCompositionActive: () => this.compositionActive,
      getIgnoreSelectionSyncUntil: () => this.ignoreSelectionSyncUntil,
      setSuppressCursorSync: (suppress) => { this.suppressCursorSync = suppress; },
      sendInput: (keys) => this.sendInput(keys),
      rpcCall: (method, params) => this.rpcCall(method, params),
      execLua: (code, args) => this.execLua(code, args),
      visualSelectionLua: VISUAL_SELECTION_LUA,
    });
    this.cursorPositionHandler = new CursorPositionHandler({
      editor: this.editor,
      nowMs: () => this.nowMs(),
      getLastCursorPos: () => this.cursor.getLastCursorPos(),
      setLastCursorPos: (pos) => this.cursor.setLastCursorPos(pos),
      isDelegatingInsert: () => this.insertDelegation.isDelegating(),
      isSuppressCursorSync: () => this.suppressCursorSync,
      getLastMode: () => this.lastMode,
      getIgnoreMonacoCursorSyncToNvimUntil: () => this.insertDelegation.getIgnoreMonacoCursorSyncToNvimUntil(),
      isCompositionActive: () => this.compositionActive,
      positionPreedit: () => this.positionPreedit(),
      scheduleCursorSyncToNvim: () => this.scheduleCursorSyncToNvim(),
      syncCursorToNvimNow: (force) => this.syncCursorToNvimNow(force),
      restorePendingSelections: () => this.visualSelection.restorePendingSelections(),
    });
    this.keyHandler = new KeyHandlerManager({
      nowMs: () => this.nowMs(),
      shouldHandleKey: (ev) => this.opts.shouldHandleKey(ev),
      translateKey: (ev) => this.opts.translateKey(ev),
      hasExplicitModAllowlist: (insertMode) => this.keyAllowlist.hasExplicitModAllowlist(insertMode),
      shouldForwardModifiedKeys: (ev, insertMode) => this.keyAllowlist.shouldForwardModifiedKeys(ev, insertMode),
      getLastMode: () => this.lastMode,
      isCompositionActive: () => this.compositionActive,
      setCompositionActive: (active) => { this.compositionActive = active; },
      setPendingEscAfterComposition: (pending) => { this.pendingEscAfterComposition = pending; },
      insertDelegation: {
        isExitingInsertMode: () => this.insertDelegation.isExitingInsertMode(),
        isDelegating: () => this.insertDelegation.isDelegating(),
        exitDelegatedInsertMode: (key) => this.insertDelegation.exitDelegatedInsertMode(key),
        appendPendingKeysAfterExit: (keys) => this.insertDelegation.appendPendingKeysAfterExit(keys),
        suppressDelegation: (ms) => this.insertDelegation.suppressDelegation(ms),
        getLastDelegatedDotRepeat: () => this.insertDelegation.getLastDelegatedDotRepeat(),
        clearLastDelegatedDotRepeat: () => this.insertDelegation.clearLastDelegatedDotRepeat(),
        recordRecentNormalKey: (key) => this.insertDelegation.recordRecentNormalKey(key),
      },
      handleNormalModeKey: (key) => this.recording.handleNormalModeKey(key),
      armIgnoreNextInputEvent: (target, ms, expectedData) => this.inputEventDeduper.arm(target, ms, expectedData),
      flushPendingMonacoSync: () => this.flushPendingMonacoSync(),
      sendInput: (keys) => this.sendInput(keys),
      scheduleCursorRefresh: () => this.scheduleCursorRefresh(),
      scheduleVisualSelectionRefresh: () => this.visualSelection.scheduleRefresh(),
    });
    this.mouse = new MouseManager({
      editor: this.editor,
      isSessionRunning: () => Boolean(this.session && this.session.isRunning()),
      getBufHandle: () => this.bufHandle,
      isDelegateInsertToMonaco: () => this.insertDelegation.isDelegating(),
      sendNotify: (method, params) => this.sendNotify(method, params),
      execLua: (code, args) => this.execLua(code, args),
    });
    this.notifyHandlers = new Map([
      ["monaco_cursorMove", (params) => this.handleNotifyMonacoCursorMove(params)],
      ["monaco_scroll", (params) => this.handleNotifyMonacoScroll(params)],
      ["monaco_reveal", (params) => this.handleNotifyMonacoReveal(params)],
      ["monaco_moveCursor", (params) => this.handleNotifyMonacoMoveCursor(params)],
      ["monaco_scrolloff", (params) => this.handleNotifyMonacoScrolloff(params)],
      ["monaco_host_command", (params) => this.handleNotifyMonacoHostCommand(params)],
      ["monaco_buf_enter", (params) => this.handleNotifyMonacoBufEnter(params)],
      ["monaco_buf_delete", (params) => this.handleNotifyMonacoBufDelete(params)],
      ["monaco_cursor", (params) => this.handleNotifyMonacoCursor(params)],
      ["monaco_visual_changed", () => this.visualSelection.scheduleRefresh()],
      ["monaco_mode", (params) => this.handleNotifyMonacoMode(params)],
      ["monaco_recording", (params) => this.handleNotifyMonacoRecording(params)],
    ]);
    this.notifyRouter = new NotifyRouter({
      debugLog: (line) => this.debugLog(line),
      notifyHandlers: this.notifyHandlers,
      handleNvimBufLinesEvent: (params) => this.bufferSync.handleNvimBufLinesEvent(params, extractBufId),
      handleNvimBufDetachEvent: (params) => {
        const id = extractBufId(params?.[0]);
        if (id) this.bufferManager.detach(id);
        if (id && this.bufHandle === id) {
          this.bufHandle = null;
        }
      },
      handleRedraw: (params) => this.redraw.handleRedrawNotify(params),
    });
    if (this.opts.debug) {
      this.opts.status?.(`[monaco-neovim-wasm] debug enabled`);
      this.debugLog("debug enabled");
    }
  }

  async start(seedLines?: string[]): Promise<void> {
    this.stop(true);
    this.nextSeedLines = (seedLines && seedLines.length) ? seedLines : null;

    try {
      const initialSize = this.opts.autoResize ? this.resizeManager.computeGridSize() : { cols: this.opts.cols, rows: this.opts.rows };
      this.uiCols = initialSize.cols;
      this.uiRows = initialSize.rows;
      this.attachEditorListeners();
      const handlers = createSessionHandlers({
        status: this.opts.status,
        onNotify: (method, params) => this.notifyRouter.onNotify(method, params),
        onRequest: (msgid, method, params) => { this.handleRequest(msgid, method, params); },
        onClipboardCopy: (lines, _regtype) => { this.clipboard.handleCopy(lines); },
        onClipboardPaste: (msgid) => { this.clipboard.handlePaste(msgid); },
        onStderr: this.opts.onStderr,
        onStartError: this.opts.onStartError,
        onExit: this.opts.onExit,
        onWarning: this.opts.onWarning,
      });

      this.session = await startOrReuseSession({
        current: this.session,
        reuseWorker: this.opts.reuseWorker,
        worker: this.opts.worker,
        workerUrl: this.opts.workerUrl,
        inputMode: this.opts.inputMode,
        sharedInputBytes: this.opts.sharedInputBytes,
        rpcTimeoutMs: this.opts.rpcTimeoutMs,
        handlers,
        start: {
          cols: this.uiCols,
          rows: this.uiRows,
          wasmPath: this.opts.wasmPath,
          runtimePath: this.opts.runtimePath,
          inputMode: this.opts.inputMode,
          env: this.opts.env,
          files: this.opts.files,
          includeOverrides: Boolean(this.opts.wrappedLineMotions || this.opts.scrollMotions || this.opts.hostCommands),
          motionOverridesVim,
          scrollingOverridesVim,
          hostCommandsOverridesVim,
        },
      });
      this.opts.status("starting...");
      this.primeSent = false;
      setTimeout(() => { if (!this.primeSent) void this.primeSession(); }, 300);
      await this.session.waitForApi();
      await this.primeSession();
    } catch (err) {
      const msg = (err as { message?: string })?.message || String(err);
      this.opts.status(`start failed: ${msg}`, true);
      this.stop(true);
      throw err;
    }
  }

  stop(silent = false): void {
    this.session = stopSession(this.session, this.opts.reuseWorker);
    this.bufHandle = null;
    this.primeSent = false;
    this.nvimBlocking = false;
    this.recording.reset();
    this.insertDelegation.reset();
    this.applyingFromNvim = false;
    this.clearBufferStates();
    this.bufferSync.reset();
    this.cursor.reset();
    this.hostAutocmdInstaller.reset();
    this.notifyRouter.reset();
    this.setCmdline(null);
    this.setMessage(null);
    this.setPopupmenu(null, -1);
    this.inputEventDeduper.clear();
    this.redraw.reset();
    if (!silent) this.opts.status("stopped", true);
    this.disposeEditorListeners();
  }

  dispose(): void {
    this.session = disposeSessionNow(this.session);
    this.stop(true);
  }

  notify(method: string, params: unknown[] = []): void {
    this.sendNotify(method, params);
  }

  call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.rpcCall(method, params) as Promise<T>;
  }

  command(cmd: string): void {
    this.sendNotify("nvim_command", [String(cmd ?? "")]);
  }

  input(keys: string): void {
    this.sendNotify("nvim_input", [String(keys ?? "")]);
  }

  type(text: string, wrapEnter = true): void {
    const payload = normalizeNvimInputText(String(text ?? ""), wrapEnter);
    if (!payload) return;
    this.sendNotify("nvim_input", [payload]);
  }

  paste(text: string): void {
    this.pasteText(text);
  }

  async execLua<T = unknown>(code: string, args: unknown[] = []): Promise<T> {
    return this.execLuaClient.execLua(code, args);
  }

  getSession(): NeovimWasmSession | null {
    return this.session;
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(this.opts.minCols, Number(cols) || 0);
    const r = Math.max(this.opts.minRows, Number(rows) || 0);
    if (!Number.isFinite(c) || !Number.isFinite(r) || c <= 0 || r <= 0) return;
    if (this.opts.syncWrap) this.applyMonacoWrap(c);
    this.uiCols = c;
    this.uiRows = r;
    if (!this.session || !this.session.isRunning()) return;
    if (!this.primeSent) return;
    void this.rpcCall("nvim_ui_try_resize", [c, r]).catch((err) => {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.debugLog(`nvim_ui_try_resize failed: ${msg}`);
    });
  }

  resizeToEditor(): void {
    const { cols, rows } = this.resizeManager.computeGridSize();
    this.resize(cols, rows);
  }

  private attachEditorListeners(): void {
    this.disposeEditorListeners();
    this.cursor.setCursorMetricsFromEditor();

    // Default to read-only outside of insert-mode delegation. This prevents
    // Monaco's native edit context / beforeinput pipeline from applying edits
    // that slip past our event interception in normal/visual/operator modes.
    // Keep `domReadOnly` false so cmdline/search can still use IME/text events.
    this.setEditorReadOnly(!this.insertDelegation.isDelegating());
    this.editor.updateOptions({ domReadOnly: false });
    if (this.opts.syncWrap) {
      const col = this.uiCols || this.opts.cols;
      if (col > 0) this.applyMonacoWrap(col);
    }
    this.initCmdlineUi();
    this.editorListeners.attach({
      onDidChangeModel: () => this.handleActiveModelChanged(),
      onKeyDown: (ev) => this.keyHandler.handleKey(ev),
      onMouseDown: (ev) => this.mouse.handleMouseDown(ev),
      onDidChangeCursorSelection: (ev) => this.visualSelection.handleSelectionEvent(ev),
      onDidChangeCursorPosition: (ev) => this.cursorPositionHandler.handle(ev),
      onDidScrollChangePreedit: () => {
        if (!this.compositionActive) return;
        this.positionPreedit();
      },
      onDidScrollChangeSearch: () => {
        if (!this.opts.searchHighlights) return;
        if (this.compositionActive) return;
        this.requestSearchHighlightRefresh();
      },
      onDidChangeConfiguration: (e) => {
        // Some hosts update editor options after we attach. Ensure normal mode
        // stays read-only so typed characters can't mutate the model behind
        // Neovim's back (desync: Monaco shows text Neovim doesn't have).
        const EditorOption = monaco.editor.EditorOption;
        if (e.hasChanged(EditorOption.readOnly) && !this.insertDelegation.isDelegating()) {
          this.setEditorReadOnly(true);
        }
      },
      onDidLayoutChange: this.opts.autoResize ? () => this.scheduleResizeToEditor() : undefined,
      onDidChangeConfigurationLayout: this.opts.autoResize
        ? (e) => {
          const EditorOption = monaco.editor.EditorOption;
          if (
            e.hasChanged(EditorOption.fontInfo)
            || e.hasChanged(EditorOption.lineHeight)
            || e.hasChanged(EditorOption.fontSize)
            || e.hasChanged(EditorOption.fontFamily)
          ) {
            this.scheduleResizeToEditor();
          }
        }
        : undefined,
      onModelContentChange: (ev) => this.handleMonacoModelChange(ev),
      initTextInputListeners: () => this.initTextInputListeners(),
    });
  }

  private handleActiveModelChanged(): void {
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    const model = this.editor.getModel();
    if (!model) return;

    // If the host swaps Monaco models (e.g. file open), ensure Neovim stays in sync.
    // This prevents "inserted text not recognized by Neovim" desyncs when the
    // active model diverges from the buffer state we flush to.
    try {
      const uri = (model as any).uri as monaco.Uri | undefined;
      const scheme = uri?.scheme ?? "";
      const authority = uri?.authority ?? "";
      const path = uri?.path ?? "";
      if (scheme === "nvim" && authority === "buf") {
        const m = /^\/(\d+)$/.exec(path);
        const id = m ? Number(m[1]) : NaN;
        if (Number.isFinite(id) && id > 0) {
          this.bufHandle = id;
        }
      }
    } catch (_) {
    }

    const state = this.ensureActiveState();
    if (!state) return;
    if (state.model === model) return;

    this.debugLog(`active model changed: rebind buf=${this.bufHandle}`);
    state.model = model;
    state.createdModel = false;
    state.pendingBufEdits = [];
    state.pendingFullSync = false;
    state.pendingCursorSync = false;
    state.shadowLines = this.insertDelegation.isDelegating() ? (model.getLinesContent?.() ?? null) : null;

    try {
      // Treat the new model content as the new source of truth for the current buffer.
      // Neovim will emit nvim_buf_lines_event and we will re-render.
      const lines = model.getLinesContent?.() ?? model.getValue().split(/\r?\n/);
      this.sendNotify("nvim_buf_set_lines", [this.bufHandle, 0, -1, false, lines]);
      this.syncCursorToNvimNow(true);
    } catch (_) {
    }
  }

  private scheduleResizeToEditor(): void {
    if (!this.opts.autoResize) return;
    this.resizeManager.scheduleResizeToEditor(({ cols, rows }) => this.resize(cols, rows));
  }

  private setPreedit(text: string | null): void {
    this.overlays.setPreedit(text);
  }

  private applyOptimisticInsert(text: string): void {
    this.cursor.applyOptimisticInsert(String(text ?? ""), () => this.overlays.isCmdlineVisible());
  }

  private positionPreedit(): void {
    this.overlays.positionPreedit();
  }

  private disposeEditorListeners(): void {
    this.editorListeners.detach();
    this.visualSelection.reset();
    this.searchHighlights.reset();
    this.cursor.reset();
    this.recording.reset();
    this.insertDelegation.reset();
    this.setMonacoHighlightsSuppressed(false);
    this.overlays.dispose();
    this.bufferSync.reset();
    this.resizeManager.cancel();
    this.compositionActive = false;
    this.pendingResyncAfterComposition = false;
    this.applyingFromNvim = false;
    this.hostAutocmdInstaller.reset();
    this.editorReadOnly = null;
  }

  private getActiveState(): BufferState | null {
    return this.bufferManager.getActiveState(this.bufHandle);
  }

  private ensureActiveState(): BufferState | null {
    return this.bufferManager.ensureState(this.bufHandle);
  }

  private clearBufferStates(): void {
    this.bufferManager.clear();
  }

  private async primeSession(): Promise<void> {
    if (this.bufHandle) return;
    this.primeSent = true;
    await this.sessionPrime.prime();
  }

  private handleRequest(msgid: number, method: string, params: unknown[]): void {
    if (method === "wasm-clipboard-paste") {
      this.clipboard.handlePaste(msgid);
    } else {
      this.sendRpcResponse(msgid, null, null);
    }
  }

  private handleNotifyMonacoCursorMove(params: unknown[]): void {
    const arg = params?.[0];
    if (arg && typeof arg === "object") {
      this.viewport.applyMonacoCursorMove(arg as Record<string, unknown>);
      if (!this.insertDelegation.isExitingInsertMode()) this.syncCursorToNvimNow(true);
    }
  }

  private handleNotifyMonacoScroll(params: unknown[]): void {
    const arg = params?.[0];
    if (arg && typeof arg === "object") {
      const moved = this.viewport.applyMonacoScroll(arg as Record<string, unknown>);
      if (moved && !this.insertDelegation.isExitingInsertMode()) this.syncCursorToNvimNow(true);
    }
  }

  private handleNotifyMonacoReveal(params: unknown[]): void {
    const arg = params?.[0];
    if (arg && typeof arg === "object") {
      const resetCursor = this.viewport.applyMonacoReveal(arg as Record<string, unknown>);
      if (resetCursor && !this.insertDelegation.isExitingInsertMode()) this.syncCursorToNvimNow(true);
    }
  }

  private handleNotifyMonacoMoveCursor(params: unknown[]): void {
    const arg = params?.[0];
    if (arg && typeof arg === "object") {
      this.viewport.applyMonacoMoveCursor(arg as Record<string, unknown>);
      if (!this.insertDelegation.isExitingInsertMode()) this.syncCursorToNvimNow(true);
    }
  }

  private handleNotifyMonacoScrolloff(params: unknown[]): void {
    const v = Number(params?.[0]);
    if (Number.isFinite(v)) {
      this.nvimScrolloff = Math.max(0, Math.floor(v));
      this.viewport.applyScrolloff();
    }
  }

  private async handleNotifyMonacoHostCommand(params: unknown[]): Promise<void> {
    const arg = params?.[0];
    if (arg && typeof arg === "object") {
      await this.hostCommandManager.handle(arg as Record<string, unknown>);
    }
  }

  private async handleNotifyMonacoBufEnter(params: unknown[]): Promise<void> {
    const arg = params?.[0];
    if (arg && typeof arg === "object") {
      await this.handleBufEnter(arg as Record<string, unknown>);
    }
  }

  private handleNotifyMonacoBufDelete(params: unknown[]): void {
    const arg = params?.[0];
    if (arg && typeof arg === "object") {
      this.handleBufDelete(arg as Record<string, unknown>);
    }
  }

  private handleNotifyMonacoCursor(params: unknown[]): void {
    const [ln, col0] = params;
    // If we explicitly synced the insert-mode cursor right before sending <Esc>,
    // Neovim can emit a late CursorMovedI event for that *insert* position after
    // it has already left insert mode. Ignoring it prevents the caret from
    // jumping forward by 1 column right after exiting insert.
    const now = this.nowMs();
    if (!this.insertDelegation.isDelegating() && this.insertDelegation.shouldIgnoreInsertExitCursor(now, ln, col0)) {
      this.debugLog(`nvim->monaco cursor: ignore stale post-exit insert cursor ln=${Number(ln)} col0=${Number(col0)}`);
      return;
    }
    const clamped = clampCursor(this.editor, Number(ln), Number(col0));
    this.debugLog(`nvim->monaco cursor: ln=${Number(ln)} col0=${Number(col0)} -> line=${clamped.line} col=${clamped.col} delegateInsert=${this.insertDelegation.isDelegating()} exitingInsert=${this.insertDelegation.isExitingInsertMode()} mode=${JSON.stringify(this.lastMode)}`);
    // In insert-mode delegation, Monaco owns the caret; don't overwrite it.
    // While exiting insert mode we do want to accept Neovim cursor updates so
    // the UI doesn't "jump" when the mode change arrives slightly later.
    if (this.insertDelegation.isDelegating() && !this.insertDelegation.isExitingInsertMode()) {
      const model = this.editor.getModel();
      const validated = model
        ? model.validatePosition(new monaco.Position(clamped.line, clamped.col))
        : new monaco.Position(clamped.line, clamped.col);
      this.cursor.setLastCursorPos(validated);
      return;
    }
    this.scheduleCursorUpdate(clamped.line, clamped.col);
  }

  private handleNotifyMonacoMode(params: unknown[]): void {
    let m = "";
    let blocking: boolean | undefined = undefined;
    let recording: string | undefined = undefined;
    let executing: string | undefined = undefined;
    let cursorLn: number | undefined = undefined;
    let cursorCol0: number | undefined = undefined;
    const p0 = params?.[0];
    const p1 = params?.[1];
    const p2 = params?.[2];
    const p3 = params?.[3];
    const p4 = params?.[4];
    const p5 = params?.[5];
    if (typeof p0 === "string") {
      m = String(p0);
    } else if (p0 && typeof p0 === "object") {
      const obj = p0 as any;
      if (typeof obj.mode === "string") m = String(obj.mode);
      if (typeof obj.blocking === "boolean") blocking = Boolean(obj.blocking);
      if (typeof obj.recording === "string") recording = String(obj.recording);
      if (typeof obj.executing === "string") executing = String(obj.executing);
    }
    if (typeof p1 === "boolean") blocking = Boolean(p1);
    if (typeof p2 === "string") recording = String(p2);
    if (typeof p3 === "string") executing = String(p3);
    if (typeof p4 === "number" && Number.isFinite(p4)) cursorLn = Number(p4);
    if (typeof p5 === "number" && Number.isFinite(p5)) cursorCol0 = Number(p5);
    if (!this.hostAutocmdInstaller.isInstalled()) {
      // Some environments can have the host autocmd Lua installed even if the
      // initial installation call didn't resolve cleanly. Once we observe a
      // monaco_mode notify, treat it as authoritative and stop using `redraw`
      // mode_change to avoid mode flip-flop (normal/insert vs n/i).
      this.hostAutocmdInstaller.markInstalledFromNotify();
    }
    this.debugLog(`nvim->monaco mode: ${JSON.stringify(this.lastMode)} -> ${JSON.stringify(m)} blocking=${blocking}`);
    if (recording != null) this.recording.setRegister(recording);
    if (executing != null) this.nvimExecuting = String(executing ?? "");
    if (cursorLn != null && cursorCol0 != null) {
      this.handleNotifyMonacoCursor([cursorLn, cursorCol0]);
    }
    this.applyNvimMode(m, blocking);
  }

  private handleNotifyMonacoRecording(params: unknown[]): void {
    const reg = typeof params?.[0] === "string" ? String(params[0]) : "";
    this.recording.setRegister(reg);
  }

  private initCmdlineUi(): void {
    this.overlays.initCmdlineUi();
  }

  private setCmdline(text: string | null): void {
    this.overlays.setCmdline(text);
  }

  private setCmdlineCursor(bytePos: number | null): void {
    this.overlays.setCmdlineCursor(bytePos);
  }

  private setMessage(text: string | null): void {
    this.overlays.setMessage(text);
  }

  private setPopupmenu(items: PopupMenuItem[] | null, selected: number): void {
    this.overlays.setPopupmenu(items as unknown as OverlayPopupMenuItem[] | null, selected);
  }

  private applyMonacoWrap(cols: number): void {
    const c = Math.max(this.opts.minCols, Number(cols) || 0);
    if (!Number.isFinite(c) || c <= 0) return;
    const strategy = this.opts.wrapStrategy;
    if (this.wrapColumnApplied === c && this.wrapStrategyApplied === strategy) return;
    try {
      this.editor.updateOptions({
        wordWrap: "wordWrapColumn",
        wordWrapColumn: c,
        wrappingStrategy: strategy,
      } as any);
      this.wrapColumnApplied = c;
      this.wrapStrategyApplied = strategy;
    } catch (_) {
    }
  }

  private syncTabstopFromMonaco(): void {
    const model = this.editor.getModel();
    if (!model) return;
    const anyModel = model as any;
    const tabSize = Math.max(1, Number(anyModel.getOptions?.().tabSize ?? 4) || 4);
    // Keep display width consistent across Neovim + Monaco for wrapped movement (gj/gk).
    this.sendNotify("nvim_command", [`set tabstop=${tabSize} shiftwidth=${tabSize} softtabstop=${tabSize}`]);
  }

  private updatePopupmenuSelection(selected: number): void {
    this.overlays.updatePopupmenuSelection(selected);
  }

  private initTextInputListeners(): Array<{ dispose(): void }> {
    return installTextInputListeners({
      editor: this.editor,
      shouldHandleKey: (ev) => this.opts.shouldHandleKey(ev),
      translateKey: (ev) => this.opts.translateKey(ev),
      debugLog: (line) => this.debugLog(line),
      modifiedKeyName: (ev) => this.keyAllowlist.modifiedKeyName(ev),
      hasExplicitModAllowlist: (insertMode) => this.keyAllowlist.hasExplicitModAllowlist(insertMode),
      shouldForwardModifiedKeys: (ev, insertMode) => this.keyAllowlist.shouldForwardModifiedKeys(ev, insertMode),
      isDelegateInsertToMonaco: () => this.insertDelegation.isDelegating(),
      isExitingInsertMode: () => this.insertDelegation.isExitingInsertMode(),
      getLastMode: () => this.lastMode,
      isCompositionActive: () => this.compositionActive,
      setCompositionActive: (active) => { this.compositionActive = active; },
      isPendingEscAfterComposition: () => this.pendingEscAfterComposition,
      setPendingEscAfterComposition: (pending) => { this.pendingEscAfterComposition = pending; },
      exitDelegatedInsertMode: (key) => this.insertDelegation.exitDelegatedInsertMode(key),
      setDelegatedInsertReplayPossible: (possible) => { this.insertDelegation.setDelegatedInsertReplayPossible(possible); },
      appendPendingKeysAfterExit: (keys) => { this.insertDelegation.appendPendingKeysAfterExit(keys); },
      flushPendingMonacoSync: () => this.flushPendingMonacoSync(),
      sendInput: (keys) => this.sendInput(keys),
      sendImeText: (text) => this.sendImeText(text),
      pasteText: (text) => this.pasteText(text),
      scheduleCursorRefresh: () => this.scheduleCursorRefresh(),
      scheduleVisualSelectionRefresh: () => this.visualSelection.scheduleRefresh(),
      scheduleCursorSyncToNvim: () => this.scheduleCursorSyncToNvim(),
      scheduleResync: () => this.scheduleResync(),
      setPreedit: (text) => this.setPreedit(text),
      armIgnoreNextInputEvent: (target, ms, expectedData) => this.inputEventDeduper.arm(target, ms, expectedData),
      shouldIgnoreNextInputEvent: (target, data) => this.inputEventDeduper.shouldIgnore(target, data),
      clearIgnoreNextInputEvent: () => this.inputEventDeduper.clear(),
      nowMs: () => this.nowMs(),
      setIgnoreSelectionSyncUntil: (deadlineMs) => { this.ignoreSelectionSyncUntil = deadlineMs; },
      sendNvimMouse: (button, action, mods, pos) => this.mouse.sendNvimMouse(button, action, mods, pos),
      isPendingResyncAfterComposition: () => this.pendingResyncAfterComposition,
      setPendingResyncAfterComposition: (pending) => { this.pendingResyncAfterComposition = pending; },
    });
  }

  private scheduleResync(): void {
    this.bufferSync.scheduleResync();
  }

  private scheduleSyncBufferToNvim(): void {
    this.bufferSync.scheduleSyncBufferToNvim();
  }

  private syncBufferToNvimNow(): void {
    this.bufferSync.syncBufferToNvimNow();
  }

  private applyBuffer(lines: string[] = [""]): void {
    this.bufferSync.applyBuffer(lines);
  }

  private clearSearchHighlights(): void {
    this.searchHighlights.clear();
  }

  private scheduleSearchHighlightRefresh(): void {
    this.searchHighlights.scheduleRefresh();
  }

  private applyNvimMode(mode: string, blocking?: boolean): void {
    const m = typeof mode === "string" ? mode : "";
    const nextBlocking = blocking == null ? this.nvimBlocking : Boolean(blocking);
    const modeChanged = Boolean(m && m !== this.lastMode);
    const blockingChanged = nextBlocking !== this.nvimBlocking;
    if (!modeChanged && !blockingChanged) return;
    const prevMode = this.lastMode;
    if (modeChanged) {
      this.lastMode = m;
      if (isCmdlineLike(m)) this.inputEventDeduper.clear();
      this.setMonacoHighlightsSuppressed(false);
    }
    this.nvimBlocking = nextBlocking;
    this.insertDelegation.applyMode(this.lastMode);

    if (modeChanged) {
      this.cursor.applyCursorStyle(m);
      if (this.opts.onModeChange) this.opts.onModeChange(m);
      void this.visualSelection.updateVisualSelection(m);
      if (isInsertLike(prevMode) && !isInsertLike(m)) {
        // When exiting delegated insert, Neovim's final "cursor-left" step can
        // be missed by CursorMoved autocmds in some environments. Force a
        // refresh so Monaco matches Neovim's normal-mode caret position.
        this.scheduleCursorRefresh();
      }
    }
    if (modeChanged && isVisualMode(prevMode) && !isVisualMode(m)) {
      // Monaco selection can persist even after leaving visual mode; clear it to
      // avoid Monaco-only deletes (e.g. Backspace).
      try {
        const pos = this.editor.getPosition() ?? this.cursor.getLastCursorPos();
        if (pos && !this.compositionActive) {
          this.suppressCursorSync = true;
          this.editor.setSelection(new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column));
          this.suppressCursorSync = false;
        }
      } catch (_) {
        this.suppressCursorSync = false;
      }
    }
    this.requestSearchHighlightRefresh();
  }

  private setEditorReadOnly(readOnly: boolean): void {
    const next = Boolean(readOnly);
    if (this.editorReadOnly === next) return;
    try {
      this.editor.updateOptions({ readOnly: next });
      this.editorReadOnly = next;
    } catch (_) {
    }
  }

  private async flushPendingMonacoSyncBlocking(): Promise<void> {
    await this.bufferSync.flushPendingMonacoSyncBlocking();
  }

  private scheduleModePull(): void {
    if (this.pendingModePull) return;
    this.pendingModePull = true;
    globalThis.setTimeout(() => {
      this.pendingModePull = false;
      void this.rpcCall("nvim_get_mode", []).then((info) => {
        const obj = info as any;
        const m = typeof obj?.mode === "string" ? String(obj.mode) : "";
        const blocking = typeof obj?.blocking === "boolean" ? Boolean(obj.blocking) : undefined;
        if (m) this.applyNvimMode(m, blocking);
      }).catch(() => {});
    }, 0);
  }

  private sendInput(keys: string): void {
    if (this.insertDelegation.isDelegating() && !this.insertDelegation.isExitingInsertMode()) {
      this.acceptNvimBufLinesDuringDelegatedInsertUntil = this.nowMs() + 500;
    }
    this.sendNotify("nvim_input", [keys]);
    if (
      this.lastMode.startsWith("n")
      && !this.insertDelegation.isDelegating()
      && !this.insertDelegation.isExitingInsertMode()
      && typeof keys === "string"
      && keys.length === 1
      && (keys === "i" || keys === "a" || keys === "I" || keys === "A" || keys === "o" || keys === "O")
    ) {
      // Host autocmd `monaco_mode` can lag slightly after insert-entry keys.
      // Pull mode via RPC to reduce the window where the first characters of a
      // delegated insert go through the non-delegated pipeline.
      this.scheduleModePull();
    }
  }

  private pasteText(text: string): void {
    const payload = String(text ?? "");
    if (!payload) return;
    const crlf = payload.includes("\r\n");
    this.sendNotify("nvim_paste", [payload, crlf, -1]);
  }

  private handleMonacoModelChange(ev: monaco.editor.IModelContentChangedEvent): void {
    const res = this.bufferSync.handleMonacoModelChange(ev);
    if (res.kind !== "delegatedInsertPatched") return;
    const dotRepeat = res.dotRepeat && res.dotRepeat.simple
      ? { deleted: res.dotRepeat.deleted, text: normalizeNvimInputText(res.dotRepeat.text, true) }
      : null;
    this.insertDelegation.handleDelegatedInsertPatched({
      resetDotRepeat: res.resetDotRepeat,
      resetReplayPossible: res.resetReplayPossible,
      dotRepeat,
    });
  }

  private scheduleCursorSyncToNvim(): void {
    this.bufferSync.scheduleCursorSyncToNvim();
  }

  private flushPendingMonacoSync(): void {
    this.bufferSync.flushPendingMonacoSync();
  }

  private syncCursorToNvimNow(force = false): void {
    if (!this.session || !this.session.isRunning()) return;
    if (!this.bufHandle) return;
    if (!force && !this.insertDelegation.isDelegating()) return;
    const model = this.editor.getModel();
    const pos = this.editor.getPosition();
    if (!model || !pos) return;
    const lineNumber = pos.lineNumber;
    const text = model.getLineContent(lineNumber) ?? "";
    const byteCol0 = charIndexToByteIndex(text, Math.max(0, pos.column - 1));
    this.sendNotify("nvim_win_set_cursor", [0, [lineNumber, byteCol0]]);
  }

  private async installHostAutocmds(): Promise<void> {
    await this.hostAutocmdInstaller.install();
  }

  private async handleBufEnter(arg: Record<string, unknown>): Promise<void> {
    const id = Number((arg as any).buf);
    if (!Number.isFinite(id) || id <= 0) return;
    await this.bufferManager.enterBuffer(
      { buf: id, name: (arg as any).name as any, filetype: (arg as any).filetype as any },
      {
        bufHandle: this.bufHandle,
        setBufHandle: (next) => { this.bufHandle = next; },
        rpcCall: (method, params) => this.rpcCall(method, params),
        setSuppressCursorSync: (suppress) => { this.suppressCursorSync = suppress; },
        delegateInsertToMonaco: this.insertDelegation.isDelegating(),
        flushPendingBeforeSwitch: () => this.flushPendingMonacoSync(),
        syncTabstopFromMonaco: () => this.syncTabstopFromMonaco(),
        syncTabstop: this.opts.syncTabstop,
        requestSearchHighlightRefresh: () => this.requestSearchHighlightRefresh(),
      },
    );
  }

  private handleBufDelete(arg: Record<string, unknown>): void {
    const id = Number((arg as any).buf);
    if (!Number.isFinite(id) || id <= 0) return;
    this.bufferManager.delete(id);
  }

  private async openText({ path, text }: { path: string; text: string }): Promise<void> {
    if (!this.session || !this.session.isRunning()) return;
    await this.bufferManager.openText(
      { path, text },
      { rpcCall: (method, params) => this.rpcCall(method, params), extractBufId: (val) => extractBufId(val) },
    );
  }

  private sendNotify(method: string, params: unknown[] = []): void {
    this.session?.notify(method, params);
  }

  private sendRpcResponse(msgid: number, error: unknown, result: unknown): void {
    this.session?.respond(msgid, error, result);
  }

  private rpcCall(method: string, params: unknown[] = []): Promise<any> {
    if (!this.session) return Promise.reject(new Error("session not started"));
    return this.session.call(method, params);
  }

  private updateCursor(lineNumber: number, column: number): void {
    const model = this.editor.getModel();
    const ln = Math.max(1, Number(lineNumber) || 1);
    const cl = Math.max(1, Number(column) || 1);
    const validated = model
      ? model.validatePosition(new monaco.Position(ln, cl))
      : new monaco.Position(ln, cl);
    const visualActive = this.visualSelection.isActive();
    this.debugLog(`updateCursor: line=${validated.lineNumber} col=${validated.column} (from line=${ln} col=${cl}) visual=${visualActive} mode=${JSON.stringify(this.lastMode)}`);
    this.cursor.setLastCursorPos(validated);
    if (this.compositionActive) return;
    const current = this.editor.getPosition();
    const same = current && current.lineNumber === validated.lineNumber && current.column === validated.column;
    if (!same) {
      const now = this.nowMs();
      const keepSelection = visualActive || this.visualSelection.shouldKeepSelection(now, 120);
      if (isVisualMode(this.lastMode) || keepSelection) {
        const applied = this.viewport.applyScrolloff(validated);
        if (!applied) this.editor.revealPositionInCenterIfOutsideViewport(validated);
        this.requestSearchHighlightRefresh();
        return;
      }
      this.suppressCursorSync = true;
      this.editor.setPosition(validated);
      const applied = this.viewport.applyScrolloff(validated);
      if (!applied) this.editor.revealPositionInCenterIfOutsideViewport(validated);
      this.suppressCursorSync = false;
    }
    this.requestSearchHighlightRefresh();
  }

  private async applyCursorSelectionFromNvim(lineNumber: number, column: number): Promise<void> {
    const model = this.editor.getModel();
    const ln = Math.max(1, Number(lineNumber) || 1);
    const cl = Math.max(1, Number(column) || 1);
    const validated = model
      ? model.validatePosition(new monaco.Position(ln, cl))
      : new monaco.Position(ln, cl);
    this.cursor.setLastCursorPos(validated);
    if (this.compositionActive) return;

    const visual = isVisualMode(this.lastMode);
    if (visual && this.pendingNvimBufUpdates > 0) {
      this.visualSelection.setPendingRefresh(true);
      return;
    }

    if (visual) {
      const token = this.visualSelection.createToken();
      try {
        const selections = await this.visualSelection.fetchVisualRanges();
        if (!this.visualSelection.isTokenValid(token)) return;
        if (!selections.length) {
          this.visualSelection.clearVisualSelection();
          return;
        }
        this.visualSelection.applyVisualSelection(selections);
      } catch (err) {
        const msg = (err as { message?: string })?.message ?? String(err);
        this.debugLog(`visual selection failed: ${msg}`);
        return;
      }
    } else {
      const selections = [new monaco.Selection(validated.lineNumber, validated.column, validated.lineNumber, validated.column)];
      const prev = this.editor.getSelections();
      const prev0 = prev && prev.length === 1 ? prev[0] : null;
      const same = Boolean(
        prev0
        && prev0.selectionStartLineNumber === selections[0].selectionStartLineNumber
        && prev0.selectionStartColumn === selections[0].selectionStartColumn
        && prev0.positionLineNumber === selections[0].positionLineNumber
        && prev0.positionColumn === selections[0].positionColumn,
      );
      if (!same) {
        try {
          this.suppressCursorSync = true;
          this.editor.setSelections(selections);
        } catch (_) {
        } finally {
          this.suppressCursorSync = false;
        }
      }
      this.visualSelection.deactivate();
      const applied = this.viewport.applyScrolloff(validated);
      if (!applied) this.editor.revealPositionInCenterIfOutsideViewport(validated);
    }
    this.requestSearchHighlightRefresh();
  }

  private scheduleCursorUpdate(lineNumber: number, column: number): void {
    this.cursor.scheduleCursorUpdate(lineNumber, column, (ln, col) => this.applyCursorSelectionFromNvim(ln, col));
  }

  private requestSearchHighlightRefresh(): void {
    this.searchHighlights.requestRefresh();
  }

  private scheduleCursorRefresh(): void {
    this.cursor.scheduleCursorRefresh(() => this.refreshCursorMode());
  }

  private async refreshCursorMode(): Promise<void> {
    const didRefresh = await this.cursor.refreshCursorMode((ln, col) => this.applyCursorSelectionFromNvim(ln, col));
    if (!didRefresh) return;
    await this.visualSelection.updateVisualSelection(this.lastMode || "n");
  }

  private async syncVisualSelectionColor(): Promise<void> {
    return;
  }

  private setMonacoHighlightsSuppressed(suppress: boolean): void {
    const EditorOption = monaco.editor.EditorOption;
    const next = Boolean(suppress);
    if (next === this.monacoHighlightsSuppressed) return;
    if (next) {
      try {
        this.monacoPrevOccurrencesHighlight = this.editor.getOption(EditorOption.occurrencesHighlight) as any;
      } catch (_) {
      }
      try {
        this.editor.updateOptions({
          occurrencesHighlight: "off" as any,
        } as any);
        this.monacoHighlightsSuppressed = true;
      } catch (_) {
      }
      return;
    }
    try {
      this.editor.updateOptions({
        occurrencesHighlight: (this.monacoPrevOccurrencesHighlight ?? "singleFile") as any,
      } as any);
    } catch (_) {
    }
    this.monacoHighlightsSuppressed = false;
    this.monacoPrevOccurrencesHighlight = null;
  }

  private async seedBuffer(bufHandle: number, seedOverride?: string[] | null): Promise<string[] | null> {
    const buf = extractBufId(bufHandle);
    if (!buf || buf <= 0) return null;
    const seed = seedOverride ?? this.opts.seedLines;
    if (!seed || !seed.length) return null;
    try {
      let restoreModifiable: boolean | null = null;
      try {
        const mod = await this.rpcCall("nvim_buf_get_option", [buf, "modifiable"]);
        if (mod === false) {
          restoreModifiable = false;
          await this.rpcCall("nvim_buf_set_option", [buf, "modifiable", true]);
        }
      } catch (_) {
      }
      await this.rpcCall("nvim_buf_set_lines", [buf, 0, -1, false, seed]);
      await this.rpcCall("nvim_buf_set_option", [buf, "modified", Boolean(this.opts.seedMarkModified)]);
      await this.rpcCall("nvim_buf_set_option", [buf, "buftype", ""]);
      if (this.opts.seedFiletype) {
        await this.rpcCall("nvim_buf_set_option", [buf, "filetype", this.opts.seedFiletype]);
      }
      // Only set a buffer name when explicitly provided: hostCommands may use the buffer name as the
      // default write target (e.g. `:w` without args). A shared default name can cause data loss.
      if (this.opts.seedName) {
        await this.rpcCall("nvim_buf_set_name", [buf, this.opts.seedName]);
      }
      if (restoreModifiable === false) {
        try { await this.rpcCall("nvim_buf_set_option", [buf, "modifiable", false]); } catch (_) {}
      }
      return seed;
    } catch (_) {
      return null;
    }
  }

}

export function createMonacoNeovim(
  editor: MonacoEditor.IStandaloneCodeEditor,
  options: MonacoNeovimOptions = {},
): MonacoNeovimClient {
  return new MonacoNeovimClient(editor, options);
}
