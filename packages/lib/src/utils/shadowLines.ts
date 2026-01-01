export function applyShadowLinesChange(
  lines: string[],
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  text: string,
): void {
  const beforeLine = lines[startRow] ?? "";
  const afterLine = lines[endRow] ?? "";
  const prefix = beforeLine.slice(0, Math.max(0, startCol));
  const suffix = afterLine.slice(Math.max(0, endCol));
  const inserted = String(text ?? "");
  const parts = inserted.split(/\r?\n/);

  let replacement: string[];
  if (parts.length <= 1) {
    replacement = [`${prefix}${parts[0] ?? ""}${suffix}`];
  } else {
    const first = `${prefix}${parts[0] ?? ""}`;
    const last = `${parts[parts.length - 1] ?? ""}${suffix}`;
    const middle = parts.slice(1, -1);
    replacement = [first, ...middle, last];
  }

  lines.splice(startRow, Math.max(0, endRow - startRow + 1), ...replacement);
}

