import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

export type DisposableLike = { dispose(): void };

export type EditorListenersManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  instanceClassName: string;
};

export type EditorListenersHandlers = {
  onDidChangeModel: () => void;
  onKeyDown: (ev: monaco.IKeyboardEvent) => void;
  onMouseDown: (ev: monaco.editor.IEditorMouseEvent) => void;
  onDidChangeCursorSelection: (ev: monaco.editor.ICursorSelectionChangedEvent) => void;
  onDidChangeCursorPosition: (ev: monaco.editor.ICursorPositionChangedEvent) => void;
  onDidScrollChangePreedit: () => void;
  onDidScrollChangeSearch: () => void;
  onDidChangeConfiguration: (e: monaco.editor.ConfigurationChangedEvent) => void;
  onDidLayoutChange?: () => void;
  onDidChangeConfigurationLayout?: (e: monaco.editor.ConfigurationChangedEvent) => void;
  onModelContentChange: (ev: monaco.editor.IModelContentChangedEvent) => void;
  initTextInputListeners: () => DisposableLike[];
};

export class EditorListenersManager {
  private readonly init: EditorListenersManagerInit;

  private disposables: DisposableLike[] = [];
  private modelContentDisposable: DisposableLike | null = null;
  private originalOptions: Partial<MonacoEditor.IStandaloneEditorConstructionOptions> | null = null;

  constructor(init: EditorListenersManagerInit) {
    this.init = init;
  }

  private captureOriginalOptions(): void {
    if (this.originalOptions != null) return;
    const EditorOption = monaco.editor.EditorOption;
    try {
      this.originalOptions = {
        readOnly: this.init.editor.getOption(EditorOption.readOnly),
        domReadOnly: this.init.editor.getOption(EditorOption.domReadOnly) as any,
        contextmenu: this.init.editor.getOption(EditorOption.contextmenu),
        minimap: this.init.editor.getOption(EditorOption.minimap),
        scrollBeyondLastLine: this.init.editor.getOption(EditorOption.scrollBeyondLastLine),
        smoothScrolling: this.init.editor.getOption(EditorOption.smoothScrolling),
        padding: this.init.editor.getOption(EditorOption.padding),
        cursorSmoothCaretAnimation: this.init.editor.getOption(EditorOption.cursorSmoothCaretAnimation),
        cursorStyle: this.init.editor.getOption(EditorOption.cursorStyle) as any,
        cursorBlinking: this.init.editor.getOption(EditorOption.cursorBlinking) as any,
        cursorWidth: this.init.editor.getOption(EditorOption.cursorWidth),
        wordWrap: this.init.editor.getOption(EditorOption.wordWrap) as any,
        wordWrapColumn: this.init.editor.getOption(EditorOption.wordWrapColumn) as any,
        wrappingStrategy: this.init.editor.getOption(EditorOption.wrappingStrategy) as any,
      };
    } catch (_) {
      this.originalOptions = null;
    }
  }

  private applyInstanceClass(add: boolean): void {
    try {
      const root = this.init.editor.getDomNode();
      if (!root) return;
      if (add) root.classList.add(this.init.instanceClassName);
      else root.classList.remove(this.init.instanceClassName);
    } catch (_) {
    }
  }

  private attachActiveModelListener(onModelContentChange: (ev: monaco.editor.IModelContentChangedEvent) => void): void {
    if (this.modelContentDisposable) {
      try { this.modelContentDisposable.dispose(); } catch (_) {}
      this.modelContentDisposable = null;
    }
    const model = this.init.editor.getModel();
    if (!model) return;
    this.modelContentDisposable = model.onDidChangeContent((ev) => onModelContentChange(ev));
  }

  attach(handlers: EditorListenersHandlers): void {
    this.detach();
    this.applyInstanceClass(true);
    this.captureOriginalOptions();
    this.attachActiveModelListener(handlers.onModelContentChange);

    this.disposables.push(
      this.init.editor.onDidChangeModel(() => {
        this.attachActiveModelListener(handlers.onModelContentChange);
        handlers.onDidChangeModel();
      }),
      this.init.editor.onKeyDown((ev) => handlers.onKeyDown(ev)),
      this.init.editor.onMouseDown((ev) => handlers.onMouseDown(ev)),
      this.init.editor.onDidChangeCursorSelection((ev) => handlers.onDidChangeCursorSelection(ev)),
      this.init.editor.onDidChangeCursorPosition((ev) => handlers.onDidChangeCursorPosition(ev)),
      this.init.editor.onDidScrollChange(() => handlers.onDidScrollChangePreedit()),
      this.init.editor.onDidScrollChange(() => handlers.onDidScrollChangeSearch()),
      this.init.editor.onDidChangeConfiguration((e) => handlers.onDidChangeConfiguration(e)),
    );
    if (handlers.onDidLayoutChange) {
      this.disposables.push(this.init.editor.onDidLayoutChange(() => handlers.onDidLayoutChange?.()));
    }
    if (handlers.onDidChangeConfigurationLayout) {
      this.disposables.push(this.init.editor.onDidChangeConfiguration((e) => handlers.onDidChangeConfigurationLayout?.(e)));
    }

    const textListeners = handlers.initTextInputListeners();
    if (Array.isArray(textListeners) && textListeners.length) {
      this.disposables.push(...textListeners);
    }
  }

  detach(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    if (this.modelContentDisposable) {
      try { this.modelContentDisposable.dispose(); } catch (_) {}
      this.modelContentDisposable = null;
    }
    this.applyInstanceClass(false);
    if (this.originalOptions) {
      try { this.init.editor.updateOptions(this.originalOptions); } catch (_) {}
      this.originalOptions = null;
    }
  }
}
