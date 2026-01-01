import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";

export function lspRangeToSelection(editor: MonacoEditor.IStandaloneCodeEditor) {
  return (range: any): monaco.Selection | null => {
    if (!range || !range.start || !range.end) return null;
    const model = editor.getModel();
    const startPos = parseLspPosition(range.start);
    const endPos = parseLspPosition(range.end);
    if (!startPos || !endPos) return null;
    const start = toMonacoLspPos(model, startPos);
    const end = toMonacoLspPos(model, endPos);
    if (!start || !end) return null;
    const reversed = compareLspPositions(startPos, endPos) > 0;
    let rangeObj = new monaco.Range(
      start.lineNumber,
      start.column,
      end.lineNumber,
      end.column,
    );
    if (model) {
      rangeObj = model.validateRange(rangeObj);
    }
    const rangeStart = rangeObj.getStartPosition();
    const rangeEnd = rangeObj.getEndPosition();
    if (reversed && (rangeStart.lineNumber !== rangeEnd.lineNumber || rangeStart.column !== rangeEnd.column)) {
      return new monaco.Selection(
        rangeEnd.lineNumber,
        rangeEnd.column,
        rangeStart.lineNumber,
        rangeStart.column,
      );
    }
    return new monaco.Selection(
      rangeStart.lineNumber,
      rangeStart.column,
      rangeEnd.lineNumber,
      rangeEnd.column,
    );
  };
}

export function parseLspPosition(pos: any): { line: number; character: number } | null {
  if (!pos) return null;
  if (typeof pos.line === "number" && typeof pos.character === "number") {
    if (!Number.isFinite(pos.line) || !Number.isFinite(pos.character)) return null;
    return { line: pos.line, character: pos.character };
  }
  if (Array.isArray(pos) && pos.length >= 2) {
    const line = Number(pos[0]);
    const character = Number(pos[1]);
    if (!Number.isFinite(line) || !Number.isFinite(character)) return null;
    return { line, character };
  }
  return null;
}

export function toMonacoLspPos(
  model: monaco.editor.ITextModel | null,
  pos: { line?: number; character?: number },
): monaco.Position | { lineNumber: number; column: number } | null {
  if (!pos || typeof pos.line !== "number" || typeof pos.character !== "number") return null;
  if (!Number.isFinite(pos.line) || !Number.isFinite(pos.character)) return null;
  const lineNumber = Math.max(1, Math.floor(pos.line) + 1);
  const column = Math.max(1, Math.floor(pos.character) + 1);
  if (!model) return { lineNumber, column };
  return model.validatePosition(new monaco.Position(lineNumber, column));
}

export function compareLspPositions(
  a: { line?: number; character?: number },
  b: { line?: number; character?: number },
): number {
  const aLine = Number(a?.line) || 0;
  const bLine = Number(b?.line) || 0;
  if (aLine !== bLine) return aLine < bLine ? -1 : 1;
  const aChar = Number(a?.character) || 0;
  const bChar = Number(b?.character) || 0;
  if (aChar === bChar) return 0;
  return aChar < bChar ? -1 : 1;
}
