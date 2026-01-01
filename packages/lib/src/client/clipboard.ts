import type { ClipboardAdapter, StatusEmitter } from "../types";

export type ClipboardManagerInit = {
  adapter?: ClipboardAdapter | null;
  status?: StatusEmitter;
  getLastClipboardText: () => string;
  setLastClipboardText: (text: string) => void;
  sendRpcResponse: (msgid: number, error: unknown, result: unknown) => void;
  debugLog?: (line: string) => void;
};

export class ClipboardManager {
  private readonly init: ClipboardManagerInit;

  constructor(init: ClipboardManagerInit) {
    this.init = init;
  }

  handleCopy(lines: string[]): void {
    const text = (lines ?? []).join("\n");
    this.init.setLastClipboardText(text);
    const adapter = this.init.adapter;
    if (adapter === null) return;
    if (adapter?.writeText) {
      adapter.writeText(text)
        .catch(() => {
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => { tryLegacyCopy(text); });
          } else {
            tryLegacyCopy(text);
          }
        });
      return;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => { tryLegacyCopy(text); });
      return;
    }
    tryLegacyCopy(text);
  }

  handlePaste(msgid: number): void {
    const fallback = (text: string | null | undefined) => {
      this.init.setLastClipboardText(text == null ? "" : String(text));
      const lines = (text || "").split(/\r?\n/);
      this.init.sendRpcResponse(msgid, null, [lines, "v"]);
    };
    const promptPaste = () => {
      try {
        if (typeof navigator !== "undefined" && (navigator as any)?.webdriver) return null;
        if (typeof window === "undefined" || typeof window.prompt !== "function") return null;
        return window.prompt("Paste text");
      } catch (_) {
        return null;
      }
    };

    const adapter = this.init.adapter;
    if (adapter === null) {
      fallback("");
      return;
    }
    if (adapter?.readText) {
      adapter.readText()
        .then((text) => fallback(text || ""))
        .catch(() => {
          const manual = promptPaste();
          fallback(manual ?? this.init.getLastClipboardText());
        });
      return;
    }
    if (!navigator.clipboard?.readText) {
      const manual = promptPaste();
      fallback(manual ?? this.init.getLastClipboardText());
      return;
    }
    navigator.clipboard.readText()
      .then((text) => fallback(text || ""))
      .catch(() => {
        const manual = promptPaste();
        fallback(manual ?? this.init.getLastClipboardText());
      });
  }
}

function tryLegacyCopy(text: string): boolean {
  try {
    if (typeof document === "undefined") return false;
    const body = document.body;
    if (!body) return false;
    const el = document.createElement("textarea");
    el.value = String(text ?? "");
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.left = "0";
    el.style.top = "0";
    el.style.width = "1px";
    el.style.height = "1px";
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    body.appendChild(el);
    el.focus();
    el.select();
    el.setSelectionRange(0, el.value.length);
    const ok = Boolean((document as any).execCommand?.("copy"));
    body.removeChild(el);
    return ok;
  } catch (_) {
    return false;
  }
}
