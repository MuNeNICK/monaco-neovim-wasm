export function isVisualMode(mode: string): boolean {
  const m = typeof mode === "string" ? mode : "";
  return m.includes("v") || m.includes("V") || m.includes("\u0016") || m.includes("s") || m.includes("S") || m.includes("\u0013");
}

export function isInsertLike(mode: string): boolean {
  const m = typeof mode === "string" ? mode : "";
  // Treat only insert-family modes as "insert-like" for Monaco delegation.
  // Replace mode (`R`) must be handled by Neovim directly; delegating it to
  // Monaco breaks `r{char}` and `R` semantics (replace vs insert).
  return m.startsWith("i");
}

export function isCmdlineLike(mode: string): boolean {
  const m = typeof mode === "string" ? mode : "";
  return m === "c" || m.startsWith("c");
}
