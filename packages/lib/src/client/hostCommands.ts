import type { editor as MonacoEditor } from "monaco-editor";

import type { BufferState } from "./bufferSync";
import type { BufferManager } from "./buffers";
import type { FileSystemAdapter, HostCommand, StatusEmitter } from "../types";

export type HostCommandManagerInit = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  bufferManager: BufferManager;
  fileSystem?: FileSystemAdapter | null;
  onHostCommand?: (cmd: HostCommand) => void | Promise<void>;
  status: StatusEmitter;
  seedName: string;
  rpcCall: (method: string, params: unknown[]) => Promise<any>;
  openText: (args: { path: string; text: string }) => Promise<void>;
  getActiveState: () => BufferState | null;
};

export class HostCommandManager {
  private readonly init: HostCommandManagerInit;

  constructor(init: HostCommandManagerInit) {
    this.init = init;
  }

  async handle(arg: Record<string, unknown>): Promise<void> {
    const action = typeof arg.action === "string" ? arg.action : "";
    if (!action) return;
    const cmd = { ...arg, action } as HostCommand;

    if (this.init.onHostCommand) {
      try { await this.init.onHostCommand(cmd); } catch (_) {}
      return;
    }

    const fs = this.init.fileSystem;
    if (!fs) {
      this.init.status(`host command ignored: ${action}`, true);
      return;
    }

    if (action === "edit") {
      const path = typeof (cmd as any).path === "string" ? String((cmd as any).path) : "";
      if (!path) {
        this.init.status("edit: no path (provide onHostCommand or fileSystem.readFile)", true);
        return;
      }
      if (!fs.readFile) {
        this.init.status("edit: fileSystem.readFile not set", true);
        return;
      }
      try {
        const res = await fs.readFile(path);
        if (res == null) return;
        const text = res instanceof Uint8Array ? new TextDecoder().decode(res) : String(res);
        await this.init.openText({ path, text });
        this.init.status(`opened: ${path}`);
      } catch (e) {
        this.init.status(`edit failed: ${(e as Error)?.message ?? e}`, true);
      }
      return;
    }

    if (action === "write" || action === "wq") {
      const model = this.init.editor.getModel();
      const text = model ? model.getValue() : "";
      let path = typeof (cmd as any).path === "string" ? String((cmd as any).path) : "";
      if (!path) {
        try {
          const name = await this.init.rpcCall("nvim_buf_get_name", [0]);
          if (typeof name === "string") path = name;
        } catch (_) {
        }
      }
      if (!path) path = this.init.seedName;
      if (!fs.writeFile) {
        this.init.status("write: fileSystem.writeFile not set", true);
        return;
      }
      try {
        await fs.writeFile(path, text);
        try { await this.init.rpcCall("nvim_buf_set_name", [0, path]); } catch (_) {}
        try { await this.init.rpcCall("nvim_buf_set_option", [0, "modified", false]); } catch (_) {}
        const state = this.init.getActiveState();
        if (state) this.init.bufferManager.setName(state.id, path);
        this.init.status(`written: ${path}`);
        if (action === "wq") {
          this.init.status("wq requested (provide onHostCommand to close the editor)");
        }
      } catch (e) {
        this.init.status(`write failed: ${(e as Error)?.message ?? e}`, true);
      }
      return;
    }

    if (action === "quit") {
      this.init.status("quit requested (provide onHostCommand to close the editor)");
      return;
    }

    this.init.status(`host command ignored: ${action}`, true);
  }
}
