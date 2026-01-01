export function normalizeNvimInputText(text: string, wrapEnter = true): string {
  const payload = String(text ?? "");
  if (!payload) return "";
  // `nvim_input()` treats `<...>` as special key notation.
  // For literal text input, escape `<` and optionally wrap newlines.
  const escaped = payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/</g, "<lt>");
  return wrapEnter ? escaped.replace(/\n/g, "<CR>") : escaped;
}

export function translateKey(ev: KeyboardEvent): string | null {
  const key = ev.key;
  if (!key || key === "Dead" || key === "Unidentified") return null;

  const isAltGraph = Boolean(ev.getModifierState?.("AltGraph"));
  const isCtrl = ev.ctrlKey && !isAltGraph;
  const isAlt = ev.altKey && !isAltGraph;
  const isMeta = ev.metaKey && !isAltGraph;
  const isShift = ev.shiftKey;

  // Neovim's nvim_input() parses `<...>` key notation, so a literal "<" must be
  // escaped as `<lt>` to avoid being treated as the start of a keycode.
  const normalizeSpecialKeyName = (name: string) => (name === "<" ? "lt" : name);
  const normalizeLiteralChar = (ch: string) => (ch === "<" ? "<lt>" : ch);

  const withMods = (name: string, includeShift = false) => {
    const all: string[] = [];
    if (isCtrl) all.push("C-");
    if (includeShift && isShift) all.push("S-");
    if (isAlt) all.push("A-");
    if (isMeta) all.push("D-");
    const normalized = normalizeSpecialKeyName(name);
    return all.length ? `<${all.join("")}${normalized}>` : `<${normalized}>`;
  };

  const isNumpad = (typeof ev.code === "string" && ev.code.startsWith("Numpad"))
    || (typeof (KeyboardEvent as any)?.DOM_KEY_LOCATION_NUMPAD === "number"
      && ev.location === (KeyboardEvent as any).DOM_KEY_LOCATION_NUMPAD);
  if (isNumpad) {
    switch (ev.code) {
      case "NumpadEnter": return withMods("kEnter", true);
      case "NumpadAdd": return withMods("kPlus", true);
      case "NumpadSubtract": return withMods("kMinus", true);
      case "NumpadMultiply": return withMods("kMultiply", true);
      case "NumpadDivide": return withMods("kDivide", true);
      case "NumpadDecimal": return withMods("kPoint", true);
      default: break;
    }
    if (/^\d$/.test(key)) return withMods(`k${key}`, true);
  }

  switch (key) {
    case "Backspace": return withMods("BS", true);
    case "Enter": return withMods("CR", true);
    case "Escape": return withMods("Esc", true);
    case "Tab": return isShift && !isCtrl && !isAlt && !isMeta ? "<S-Tab>" : withMods("Tab", true);
    case "ArrowUp": return withMods("Up", true);
    case "ArrowDown": return withMods("Down", true);
    case "ArrowLeft": return withMods("Left", true);
    case "ArrowRight": return withMods("Right", true);
    case "Delete": return withMods("Del", true);
    case "Home": return withMods("Home", true);
    case "End": return withMods("End", true);
    case "PageUp": return withMods("PageUp", true);
    case "PageDown": return withMods("PageDown", true);
    case "Insert": return withMods("Insert", true);
    default: break;
  }

  if (/^F\d{1,2}$/.test(key)) return withMods(key, true);

  if (key.length === 1) {
    if (!isCtrl && !isAlt && !isMeta) return normalizeLiteralChar(key);
    if (key === " " && isCtrl && !isAlt && !isMeta) return "<Nul>";
    const ch = /^[A-Za-z]$/.test(key) ? key.toLowerCase() : key;
    const normalized = normalizeSpecialKeyName(ch);
    const prefix = (isCtrl ? "C-" : "") + (isAlt ? "A-" : "") + (isMeta ? "D-" : "");
    return `<${prefix}${normalized}>`;
  }

  return null;
}

