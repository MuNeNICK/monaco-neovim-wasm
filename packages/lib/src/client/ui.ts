import type { PopupMenuItem } from "./overlays";

export function uiChunksToText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let out = "";
  for (const part of content) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    if (Array.isArray(part)) {
      if (typeof part[1] === "string") {
        out += part[1];
      } else if (typeof part[0] === "string") {
        out += part[0];
      } else {
        out += uiChunksToText(part);
      }
      continue;
    }
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      out += (part as { text: string }).text;
    }
  }
  return out;
}

export function parsePopupmenuItems(items: unknown): PopupMenuItem[] {
  if (!Array.isArray(items)) return [];
  const out: PopupMenuItem[] = [];
  for (const it of items) {
    if (Array.isArray(it)) {
      out.push({
        word: String(it[0] ?? ""),
        kind: it[1] == null ? undefined : String(it[1]),
        menu: it[2] == null ? undefined : String(it[2]),
        info: it[3] == null ? undefined : String(it[3]),
      });
      continue;
    }
    if (it && typeof it === "object") {
      const obj = it as Record<string, unknown>;
      const word = obj.word ?? obj.abbr ?? obj.text;
      if (word != null) {
        out.push({
          word: String(word),
          kind: obj.kind ? String(obj.kind) : undefined,
          menu: obj.menu ? String(obj.menu) : undefined,
          info: obj.info ? String(obj.info) : undefined,
        });
      }
    }
  }
  return out.filter((x) => x.word.length > 0);
}

