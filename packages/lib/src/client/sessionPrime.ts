import type { editor as MonacoEditor } from "monaco-editor";

export type SessionPrimeOptions = {
  uiAttach: boolean;
  cols: number;
  rows: number;
  uiAttachOptions: Record<string, unknown>;
  startupCommands: string[];
  startupLua: string;
  seedLines: string[];
  seedFromMonaco: boolean;
  initialSync: "none" | "monacoToNvim" | "nvimToMonaco";
  syncTabstop: boolean;
  autoResize: boolean;
  onModeChange?: (mode: string) => void;
  status: (text: string, warn?: boolean) => void;
};

export type SessionPrimeManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  opts: SessionPrimeOptions;

  getUiCols: () => number;
  getUiRows: () => number;

  getBufHandle: () => number | null;
  setBufHandle: (id: number | null) => void;

  getNextSeedLines: () => string[] | null;
  clearNextSeedLines: () => void;

  extractBufId: (val: unknown) => number | null;

  rpcCall: (method: string, params: unknown[]) => Promise<any>;
  sendNotify: (method: string, params: unknown[]) => void;
  execLua: <T = unknown>(code: string, args: unknown[]) => Promise<T>;

  seedBuffer: (bufId: number, seedLines: string[]) => Promise<string[] | null>;
  applyBuffer: (lines: string[]) => void;
  ensureActiveState: () => boolean;
  setBufferName: (bufId: number, name: string) => void;
  setBufferFiletype: (bufId: number, filetype: string) => void;

  syncTabstopFromMonaco: () => void;
  installHostAutocmds: () => Promise<void>;
  syncVisualSelectionColor: () => Promise<void>;

  getLastMode: () => string;
  setLastMode: (mode: string) => void;

  focusEditor: () => void;
  scheduleResizeToEditor: () => void;
};

export class SessionPrimeManager {
  private readonly init: SessionPrimeManagerInit;

  constructor(init: SessionPrimeManagerInit) {
    this.init = init;
  }

  async prime(): Promise<void> {
    if (this.init.getBufHandle()) return;
    const { opts } = this.init;
    try {
      if (opts.uiAttach) {
        try {
          await this.init.rpcCall("nvim_ui_attach", [
            this.init.getUiCols() || opts.cols,
            this.init.getUiRows() || opts.rows,
            opts.uiAttachOptions,
          ]);
        } catch (_) {
        }
      }

      for (const cmd of opts.startupCommands) {
        if (!cmd) continue;
        this.init.sendNotify("nvim_command", [cmd]);
      }

      if (opts.startupLua) {
        try { await this.init.execLua(opts.startupLua, []); } catch (_) {}
      }

      const buf = await this.init.rpcCall("nvim_get_current_buf", []);
      const id = this.init.extractBufId(buf) ?? 1;
      this.init.setBufHandle(id);

      const seedFromMonaco = () => {
        if (!opts.seedFromMonaco) return null;
        const model = this.init.editor.getModel();
        if (!model) return null;
        const text = model.getValue();
        const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
        if (!normalized) return null;
        return normalized.split("\n");
      };

      const nextSeedLines = this.init.getNextSeedLines();
      const seedCandidate =
        (nextSeedLines && nextSeedLines.length ? nextSeedLines : null)
        ?? (opts.seedLines && opts.seedLines.length ? opts.seedLines : null)
        ?? seedFromMonaco();
      this.init.clearNextSeedLines();

      const syncMode = opts.initialSync;
      let seededLines: string[] | null = null;
      let attemptedSeed = false;
      if (syncMode !== "none" && seedCandidate && seedCandidate.length) {
        attemptedSeed = true;
        seededLines = await this.init.seedBuffer(id, seedCandidate);
      }

      // Important: In "monacoToNvim" mode, Monaco is treated as the source of truth at startup.
      // Attaching with `send_buffer=true` can emit an initial `nvim_buf_lines_event` for Neovim's
      // default (often empty) buffer, which would overwrite Monaco (and any external bindings like Yjs).
      const sendBufferOnAttach = syncMode === "nvimToMonaco";
      const attached = await this.init.rpcCall("nvim_buf_attach", [id, sendBufferOnAttach, {}]);
      if (attached !== true) throw new Error("nvim_buf_attach failed");
      const hasState = this.init.ensureActiveState();
      if (opts.syncTabstop) this.init.syncTabstopFromMonaco();

      if (syncMode === "none") {
        // Don't touch Monaco or seed Neovim; callers can coordinate their own hydration/sync.
      } else if (syncMode === "monacoToNvim") {
        // In embedded/collaborative editors, Monaco is often already bound to an external source (e.g. Yjs).
        // Avoid mutating Monaco on start; instead seed Neovim from Monaco (or explicit seedLines) so edits flow Monaco -> Neovim.
        if (attemptedSeed && !seededLines) {
          opts.status("warning: failed to seed Neovim from Monaco; leaving Monaco untouched", true);
        }
      } else {
        // "nvimToMonaco": reflect Neovim buffer into Monaco (optionally after seeding).
        if (seededLines && seededLines.length) {
          this.init.applyBuffer(seededLines);
        } else {
          const lines = await this.init.rpcCall("nvim_buf_get_lines", [id, 0, -1, false]);
          this.init.applyBuffer(Array.isArray(lines) ? (lines as string[]) : [""]);
        }
      }

      try {
        if (hasState) {
          const name = await this.init.rpcCall("nvim_buf_get_name", [id]);
          this.init.setBufferName(id, typeof name === "string" ? name : "");
          try {
            const ft = await this.init.rpcCall("nvim_buf_get_option", [id, "filetype"]);
            this.init.setBufferFiletype(id, typeof ft === "string" ? ft : "");
          } catch (_) {
          }
        }
      } catch (_) {
      }

      await this.init.installHostAutocmds();
      await this.init.syncVisualSelectionColor();

      if (!this.init.getLastMode()) this.init.setLastMode("n");
      opts.status("ready");
      this.init.focusEditor();
      if (opts.autoResize) this.init.scheduleResizeToEditor();
      try { opts.onModeChange?.(this.init.getLastMode()); } catch (_) {}
    } catch (err) {
      opts.status(`failed to attach: ${(err as Error)?.message ?? err}`, true);
    }
  }
}
