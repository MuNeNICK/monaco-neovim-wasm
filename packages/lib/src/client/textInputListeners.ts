import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

import { domListener, type Disposable } from "../utils/dom";
import { isCmdlineLike, isInsertLike, isVisualMode } from "./modes";

export type TextInputListenerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  shouldHandleKey: (ev: KeyboardEvent) => boolean;
  translateKey: (ev: KeyboardEvent) => string | null;
  debugLog: (line: string) => void;

  modifiedKeyName: (ev: KeyboardEvent) => string | null;
  hasExplicitModAllowlist: (insertMode: boolean) => boolean;
  shouldForwardModifiedKeys: (ev: KeyboardEvent, insertMode: boolean) => boolean;

  isDelegateInsertToMonaco: () => boolean;
  isExitingInsertMode: () => boolean;
  getLastMode: () => string;

  isCompositionActive: () => boolean;
  setCompositionActive: (active: boolean) => void;
  isPendingEscAfterComposition: () => boolean;
  setPendingEscAfterComposition: (pending: boolean) => void;
  exitDelegatedInsertMode: (key: string) => void;
  setDelegatedInsertReplayPossible: (possible: boolean) => void;
  appendPendingKeysAfterExit: (keys: string) => void;

  flushPendingMonacoSync: () => void;
  sendInput: (keys: string) => void;
  sendImeText: (text: string) => void;
  pasteText: (text: string) => void;

  scheduleCursorRefresh: () => void;
  scheduleVisualSelectionRefresh: () => void;
  scheduleCursorSyncToNvim: () => void;
  scheduleResync: () => void;

  setPreedit: (text: string | null) => void;

  armIgnoreNextInputEvent: (target: EventTarget | null, ms: number, expectedData?: string | null) => void;
  shouldIgnoreNextInputEvent: (target: EventTarget | null, data?: unknown) => boolean;
  clearIgnoreNextInputEvent: () => void;

  nowMs: () => number;
  setIgnoreSelectionSyncUntil: (deadlineMs: number) => void;
  sendNvimMouse: (
    button: "left" | "middle" | "right",
    action: "press" | "release" | "drag",
    mods: string,
    pos: monaco.Position,
  ) => Promise<void> | void;

  isPendingResyncAfterComposition: () => boolean;
  setPendingResyncAfterComposition: (pending: boolean) => void;
};

export function installTextInputListeners(init: TextInputListenerInit): Disposable[] {
  const root = init.editor.getDomNode();
  if (!root) return [];
  const ownerDoc = root.ownerDocument || document;
  const view: EventTarget = ownerDoc.defaultView || window;

  const stopAll = (e: Event) => {
    try { (e as any).stopImmediatePropagation?.(); } catch (_) {}
    try { e.stopPropagation(); } catch (_) {}
  };

  const isEditorEvent = (e: Event): boolean => {
    try {
      const hasTextFocus = typeof (init.editor as any).hasTextFocus === "function"
        ? Boolean((init.editor as any).hasTextFocus())
        : false;
      if (hasTextFocus) return true;
      const target = e.target as Node | null;
      if (target && root.contains(target)) return true;
      const active = ownerDoc.activeElement as Node | null;
      return Boolean(active && root.contains(active));
    } catch (_) {
      return false;
    }
  };

  const asMaybeInputTarget = (target: EventTarget | null): HTMLElement | null => {
    try {
      const el = target as HTMLElement | null;
      if (!el || typeof (el as any).tagName !== "string") return null;
      return el;
    } catch (_) {
      return null;
    }
  };

  const onKeydownCapture = (e: KeyboardEvent) => {
    if (!isEditorEvent(e)) return;
    if (init.isCompositionActive() || e.isComposing) return;
    if (e.getModifierState?.("AltGraph")) return;

    const insertMode = init.isDelegateInsertToMonaco() && !init.isExitingInsertMode();
    const lastMode = init.getLastMode();

    if (insertMode) {
      if (e.key === "Escape") {
        if (!init.shouldHandleKey(e)) return;
        stopAll(e);
        try { e.preventDefault(); } catch (_) {}
        if (init.isCompositionActive() || e.isComposing) {
          init.setPendingEscAfterComposition(true);
          return;
        }
        init.exitDelegatedInsertMode("<Esc>");
        return;
      }
      const k = e.key;
      if (
        k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown"
        || k === "Home" || k === "End"
        || k === "PageUp" || k === "PageDown"
        || k === "Tab"
        || k === "Enter"
      ) {
        init.setDelegatedInsertReplayPossible(false);
      }
    }

    if (!insertMode && (e.key === "Backspace" || e.key === "Delete" || e.key === "Escape")) {
      if (!init.shouldHandleKey(e)) return;
      const key = init.translateKey(e);
      if (!key) return;
      stopAll(e);
      try { e.preventDefault(); } catch (_) {}
      if (init.isExitingInsertMode() && key === "<Esc>") return;
      if (init.isExitingInsertMode()) {
        init.appendPendingKeysAfterExit(key);
      } else {
        init.sendInput(key);
        init.scheduleCursorRefresh();
        if (isVisualMode(lastMode)) init.scheduleVisualSelectionRefresh();
      }
      return;
    }

    if (
      !insertMode
      && !init.isExitingInsertMode()
      && (
        e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown"
        || e.key === "Home" || e.key === "End" || e.key === "PageUp" || e.key === "PageDown"
      )
    ) {
      if (!init.shouldHandleKey(e)) return;
      const key = init.translateKey(e);
      if (!key) return;
      stopAll(e);
      try { e.preventDefault(); } catch (_) {}
      if (init.isExitingInsertMode()) {
        init.appendPendingKeysAfterExit(key);
      } else {
        init.sendInput(key);
        init.scheduleCursorRefresh();
        if (isVisualMode(lastMode)) init.scheduleVisualSelectionRefresh();
      }
      return;
    }

    if (
      isCmdlineLike(lastMode)
      && !init.isDelegateInsertToMonaco()
      && !init.isExitingInsertMode()
      && !e.ctrlKey
      && !e.metaKey
      && (typeof e.key === "string" && e.key.length === 1)
    ) {
      const asciiPrintable = /^[\x20-\x7E]$/.test(e.key);
      const treatAsAltChord = Boolean(e.altKey && asciiPrintable);
      if (!treatAsAltChord) {
        if (!init.shouldHandleKey(e)) return;
        stopAll(e);
        return;
      }
    }

    if (!e.ctrlKey && !e.altKey && !e.metaKey) return;
    const name = init.modifiedKeyName(e);
    if (!name) return;
    if (!init.shouldHandleKey(e)) return;

    if (init.hasExplicitModAllowlist(insertMode)) {
      if (!init.shouldForwardModifiedKeys(e, insertMode)) return;
    } else {
      if (insertMode) return;
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (name !== "f" && name !== "b" && name !== "d" && name !== "u" && name !== "e" && name !== "y" && name !== "v") return;
    }

    const key = init.translateKey(e);
    if (!key) return;
    stopAll(e);
    try { e.preventDefault(); } catch (_) {}
    if (init.isExitingInsertMode()) {
      init.debugLog(
        `keydown(capture) buffer: key=${JSON.stringify(e.key)} code=${JSON.stringify(e.code)} mods=${e.ctrlKey ? "C" : ""}${e.altKey ? "A" : ""}${e.metaKey ? "D" : ""}${e.shiftKey ? "S" : ""} -> ${key}`,
      );
      init.appendPendingKeysAfterExit(key);
    } else {
      if (insertMode && (key === "<C-[>" || key === "<C-c>")) {
        init.debugLog(
          `keydown(capture) exit insert: key=${JSON.stringify(e.key)} code=${JSON.stringify(e.code)} mods=${e.ctrlKey ? "C" : ""}${e.altKey ? "A" : ""}${e.metaKey ? "D" : ""}${e.shiftKey ? "S" : ""} -> ${key}`,
        );
        init.exitDelegatedInsertMode(key);
      } else {
        if (insertMode) init.flushPendingMonacoSync();
        init.debugLog(
          `keydown(capture) send: key=${JSON.stringify(e.key)} code=${JSON.stringify(e.code)} mods=${e.ctrlKey ? "C" : ""}${e.altKey ? "A" : ""}${e.metaKey ? "D" : ""}${e.shiftKey ? "S" : ""} -> ${key}`,
        );
        init.sendInput(key);
        if (!insertMode) {
          init.scheduleCursorRefresh();
          if (isVisualMode(lastMode)) init.scheduleVisualSelectionRefresh();
        }
      }
    }
  };

  const onCompositionStart = (e: CompositionEvent) => {
    if (!isEditorEvent(e)) return;
    init.setCompositionActive(true);
    init.debugLog(`compositionstart delegateInsert=${init.isDelegateInsertToMonaco()} mode=${JSON.stringify(init.getLastMode())}`);
    if (init.isDelegateInsertToMonaco()) {
      init.setPreedit(null);
      return;
    }
    init.setPreedit("");
  };

  const onCompositionEnd = (e: CompositionEvent) => {
    if (!isEditorEvent(e)) return;
    init.setCompositionActive(false);
    init.setPreedit(null);
    init.debugLog(
      `compositionend delegateInsert=${init.isDelegateInsertToMonaco()} mode=${JSON.stringify(init.getLastMode())} data=${JSON.stringify((e as any).data ?? "")}`,
    );
    const lastMode = init.getLastMode();
    if (init.isDelegateInsertToMonaco()) {
      if (init.isPendingEscAfterComposition()) {
        init.setPendingEscAfterComposition(false);
        init.exitDelegatedInsertMode("<Esc>");
        return;
      }
      if (!init.isExitingInsertMode()) init.scheduleCursorSyncToNvim();
      return;
    }
    const target = asMaybeInputTarget(e.target);
    if (isInsertLike(lastMode) && !isCmdlineLike(lastMode)) {
      const data = typeof e.data === "string" ? e.data : "";
      const fallback = (!data && target && (target as any).tagName === "TEXTAREA" && (target as HTMLTextAreaElement).value)
        ? String((target as HTMLTextAreaElement).value)
        : (!data && target?.textContent ? String(target.textContent) : "");
      const commit = data || fallback;
      if (commit) init.sendImeText(commit);
    }
    if (isCmdlineLike(lastMode)) {
      const data = typeof e.data === "string" ? e.data : "";
      const fallback = (!data && target && (target as any).tagName === "TEXTAREA" && (target as HTMLTextAreaElement).value)
        ? String((target as HTMLTextAreaElement).value)
        : (!data && target?.textContent ? String(target.textContent) : "");
      const commit = data || fallback;
      if (commit) init.sendImeText(commit);
    }
    try {
      if (target && (target as any).tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
      else if (target) target.textContent = "";
    } catch (_) {}
    if (init.isPendingResyncAfterComposition()) {
      init.setPendingResyncAfterComposition(false);
      init.scheduleResync();
    }
  };

  const onCompositionUpdate = (e: CompositionEvent) => {
    if (!isEditorEvent(e)) return;
    if (!init.isCompositionActive()) init.setCompositionActive(true);
    if (init.isDelegateInsertToMonaco()) return;
    const target = asMaybeInputTarget(e.target);
    const data = typeof e.data === "string" ? e.data : (
      (target && (target as any).tagName === "TEXTAREA" && (target as HTMLTextAreaElement).value)
        ? String((target as HTMLTextAreaElement).value)
        : (target?.textContent ? String(target.textContent) : "")
    );
    init.setPreedit(data || "");
  };

  const onBeforeInput = (e: Event) => {
    if (!isEditorEvent(e)) return;
    const ie = e as InputEvent;
    if (init.isDelegateInsertToMonaco() && !init.isExitingInsertMode()) {
      // When we preventDefault a keydown (normal/visual/etc), some browsers can
      // still emit a follow-up `beforeinput`/`input`. If insert delegation was
      // toggled on in between, that stale event would apply to Monaco and can
      // reorder characters (e.g. first typed char appears at the end).
      if (init.shouldIgnoreNextInputEvent(ie.target, (ie as any).data)) {
        const target = asMaybeInputTarget(ie.target);
        stopAll(e);
        try { (e as InputEvent).preventDefault?.(); } catch (_) {}
        init.clearIgnoreNextInputEvent();
        try {
          if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
          else if (target) target.textContent = "";
        } catch (_) {}
      }
      return;
    }
    const target = asMaybeInputTarget(e.target);
    stopAll(e);
    try { (e as InputEvent).preventDefault?.(); } catch (_) {}

    const lastMode = init.getLastMode();
    if (isInsertLike(lastMode) && !init.isCompositionActive()) {
      const inputType = typeof (ie as any).inputType === "string" ? String((ie as any).inputType) : "";
      const composing = Boolean((ie as any).isComposing);
      const data = typeof ie.data === "string" ? ie.data : "";

      if (!composing && !inputType.includes("Composition")) {
        if (inputType === "insertText" || inputType === "insertReplacementText" || inputType === "insertFromDrop") {
          if (data) {
            init.armIgnoreNextInputEvent(ie.target, 120, data);
            init.sendImeText(data);
          }
          try {
            if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
            else if (target) target.textContent = "";
          } catch (_) {}
          return;
        }
        if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
          init.armIgnoreNextInputEvent(ie.target, 120, null);
          init.sendInput("<CR>");
          try {
            if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
            else if (target) target.textContent = "";
          } catch (_) {}
          return;
        }
        if (inputType === "deleteContentBackward") {
          init.armIgnoreNextInputEvent(ie.target, 120, null);
          init.sendInput("<BS>");
          try {
            if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
            else if (target) target.textContent = "";
          } catch (_) {}
          return;
        }
        if (inputType === "deleteContentForward") {
          init.armIgnoreNextInputEvent(ie.target, 120, null);
          init.sendInput("<Del>");
          try {
            if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
            else if (target) target.textContent = "";
          } catch (_) {}
          return;
        }
      }
    }

    if (isCmdlineLike(lastMode) && !init.isCompositionActive()) {
      const ie = e as InputEvent;
      const data = typeof ie.data === "string" ? ie.data : "";
      const inputType = typeof (ie as any).inputType === "string" ? String((ie as any).inputType) : "";
      const composing = Boolean((ie as any).isComposing);
      if (!composing && !inputType.includes("Composition") && data) {
        init.sendImeText(data);
      }
    }
  };

  const onInput = (e: Event) => {
    if (!isEditorEvent(e)) return;
    const ie = e as InputEvent;
    if (init.isDelegateInsertToMonaco() && !init.isExitingInsertMode()) {
      if (init.shouldIgnoreNextInputEvent(ie.target, (ie as any).data)) {
        const target = asMaybeInputTarget(ie.target);
        stopAll(e);
        try { (e as InputEvent).preventDefault?.(); } catch (_) {}
        init.clearIgnoreNextInputEvent();
        try {
          if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
          else if (target) target.textContent = "";
        } catch (_) {}
      }
      return;
    }
    const target = asMaybeInputTarget(ie.target);
    stopAll(e);

    if (init.shouldIgnoreNextInputEvent(ie.target, (ie as any).data)) {
      init.clearIgnoreNextInputEvent();
      try {
        if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
        else if (target) target.textContent = "";
      } catch (_) {}
      return;
    }
    if (init.isCompositionActive()) return;

    const lastMode = init.getLastMode();
    if (isInsertLike(lastMode) && !isCmdlineLike(lastMode)) {
      const data = typeof ie.data === "string" ? ie.data : "";
      const fallback = (!data && (target as any)?.tagName === "TEXTAREA" && (target as HTMLTextAreaElement).value)
        ? String((target as HTMLTextAreaElement).value)
        : (!data && target?.textContent ? String(target.textContent) : "");
      const commit = data || fallback;
      if (commit) {
        init.armIgnoreNextInputEvent(ie.target, 120, commit);
        init.sendImeText(commit);
      }
    }

    if (isCmdlineLike(lastMode)) {
      const data = typeof ie.data === "string" ? ie.data : "";
      const fallback = (!data && (target as any)?.tagName === "TEXTAREA" && (target as HTMLTextAreaElement).value)
        ? String((target as HTMLTextAreaElement).value)
        : (!data && target?.textContent ? String(target.textContent) : "");
      const commit = data || fallback;
      if (commit) init.sendImeText(commit);
    }

    try {
      if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
      else if (target) target.textContent = "";
    } catch (_) {}
  };

  const onPaste = (e: ClipboardEvent) => {
    if (!isEditorEvent(e)) return;
    if (init.isDelegateInsertToMonaco() && !init.isExitingInsertMode()) return;
    const target = asMaybeInputTarget(e.target);
    stopAll(e);
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) {
      e.preventDefault();
      init.armIgnoreNextInputEvent(e.target, 150, null);
      init.pasteText(text);
    }
    try {
      if ((target as any)?.tagName === "TEXTAREA") (target as HTMLTextAreaElement).value = "";
      else if (target) target.textContent = "";
    } catch (_) {}
  };

  let mouseDown = false;
  let mouseBtn: "left" | "middle" | "right" = "left";
  let lastMousePos: monaco.Position | null = null;
  let lastMouseMods = "";
  let dragTimer: number | null = null;

  const mouseMods = (e: MouseEvent) => `${e.shiftKey ? "S" : ""}${e.ctrlKey ? "C" : ""}${e.altKey ? "A" : ""}${e.metaKey ? "D" : ""}`;
  const mouseButton = (e: MouseEvent): "left" | "middle" | "right" => (e.button === 1 ? "middle" : (e.button === 2 ? "right" : "left"));
  const mousePosFromClient = (e: MouseEvent): monaco.Position | null => {
    try {
      const anyEditor = init.editor as any;
      const target = anyEditor.getTargetAtClientPoint?.(e.clientX, e.clientY);
      const pos = target?.position;
      if (!pos) return null;
      return new monaco.Position(pos.lineNumber, pos.column);
    } catch (_) {
      return null;
    }
  };

  const flushDrag = () => {
    dragTimer = null;
    if (!mouseDown) return;
    if (!lastMousePos) return;
    init.setIgnoreSelectionSyncUntil(init.nowMs() + 200);
    void init.sendNvimMouse(mouseBtn, "drag", lastMouseMods, lastMousePos);
  };

  const onMouseDownCapture = (e: MouseEvent) => {
    if (!isEditorEvent(e)) return;
    if (init.isDelegateInsertToMonaco() && !init.isExitingInsertMode()) return;
    if (init.isCompositionActive() || (e as any).isComposing) return;
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    const pos = mousePosFromClient(e);
    if (!pos) return;
    stopAll(e);
    try { e.preventDefault(); } catch (_) {}
    try { init.editor.focus(); } catch (_) {}
    mouseDown = true;
    mouseBtn = mouseButton(e);
    lastMouseMods = mouseMods(e);
    lastMousePos = pos;
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
    init.setIgnoreSelectionSyncUntil(init.nowMs() + 250);
    void init.sendNvimMouse(mouseBtn, "press", lastMouseMods, pos);
  };

  const onMouseMoveCapture = (e: MouseEvent) => {
    if (!mouseDown) return;
    if (!isEditorEvent(e)) return;
    if (init.isDelegateInsertToMonaco() && !init.isExitingInsertMode()) return;
    if (init.isCompositionActive() || (e as any).isComposing) return;
    const pos = mousePosFromClient(e);
    if (!pos) return;
    stopAll(e);
    try { e.preventDefault(); } catch (_) {}
    lastMouseMods = mouseMods(e);
    lastMousePos = pos;
    if (dragTimer) return;
    dragTimer = globalThis.setTimeout(flushDrag, 16);
  };

  const onMouseUpCapture = (e: MouseEvent) => {
    if (!mouseDown) return;
    mouseDown = false;
    const inEditor = isEditorEvent(e);
    if (inEditor && (init.isDelegateInsertToMonaco() && !init.isExitingInsertMode())) return;
    const pos = mousePosFromClient(e) ?? lastMousePos;
    if (!pos) return;
    if (inEditor) {
      stopAll(e);
      try { e.preventDefault(); } catch (_) {}
    }
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
    lastMouseMods = mouseMods(e);
    lastMousePos = pos;
    init.setIgnoreSelectionSyncUntil(init.nowMs() + 250);
    void init.sendNvimMouse(mouseBtn, "release", lastMouseMods, pos);
  };

  const onContextMenuCapture = (e: MouseEvent) => {
    if (!isEditorEvent(e)) return;
    if (init.isDelegateInsertToMonaco() && !init.isExitingInsertMode()) return;
    stopAll(e);
    try { e.preventDefault(); } catch (_) {}
  };

  return [
    domListener(view, "keydown", onKeydownCapture, true),
    domListener(view, "beforeinput", onBeforeInput, true),
    domListener(view, "input", onInput, true),
    domListener(view, "paste", onPaste, true),
    domListener(view, "mousedown", onMouseDownCapture, true),
    domListener(view, "mousemove", onMouseMoveCapture, true),
    domListener(view, "mouseup", onMouseUpCapture, true),
    domListener(view, "contextmenu", onContextMenuCapture, true),
    domListener(view, "compositionstart", onCompositionStart, true),
    domListener(view, "compositionupdate", onCompositionUpdate, true),
    domListener(view, "compositionend", onCompositionEnd, true),
  ];
}
