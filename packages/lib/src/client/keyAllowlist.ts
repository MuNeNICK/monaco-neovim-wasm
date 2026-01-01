export type KeyAllowlistManagerInit = {
  ctrlKeysForNormalMode?: string[] | null;
  ctrlKeysForInsertMode?: string[] | null;
  altKeysForNormalMode?: string[] | null;
  altKeysForInsertMode?: string[] | null;
  metaKeysForNormalMode?: string[] | null;
  metaKeysForInsertMode?: string[] | null;
};

export class KeyAllowlistManager {
  private readonly ctrlKeysNormal: Set<string> | null;
  private readonly ctrlKeysInsert: Set<string> | null;
  private readonly altKeysNormal: Set<string> | null;
  private readonly altKeysInsert: Set<string> | null;
  private readonly metaKeysNormal: Set<string> | null;
  private readonly metaKeysInsert: Set<string> | null;

  constructor(init: KeyAllowlistManagerInit) {
    this.ctrlKeysNormal = init.ctrlKeysForNormalMode ? new Set(init.ctrlKeysForNormalMode.map((s) => String(s).toLowerCase())) : null;
    this.ctrlKeysInsert = init.ctrlKeysForInsertMode ? new Set(init.ctrlKeysForInsertMode.map((s) => String(s).toLowerCase())) : null;
    this.altKeysNormal = init.altKeysForNormalMode ? new Set(init.altKeysForNormalMode.map((s) => String(s).toLowerCase())) : null;
    this.altKeysInsert = init.altKeysForInsertMode ? new Set(init.altKeysForInsertMode.map((s) => String(s).toLowerCase())) : null;
    this.metaKeysNormal = init.metaKeysForNormalMode ? new Set(init.metaKeysForNormalMode.map((s) => String(s).toLowerCase())) : null;
    this.metaKeysInsert = init.metaKeysForInsertMode ? new Set(init.metaKeysForInsertMode.map((s) => String(s).toLowerCase())) : null;
  }

  modifiedKeyName(ev: KeyboardEvent): string | null {
    const key = ev.key;
    if (!key) return null;
    if (key.length === 1) {
      if (/^[A-Za-z]$/.test(key)) return key.toLowerCase();
      return key.toLowerCase();
    }
    switch (key) {
      case "ArrowUp": return "up";
      case "ArrowDown": return "down";
      case "ArrowLeft": return "left";
      case "ArrowRight": return "right";
      case "Backspace": return "backspace";
      case "Delete": return "delete";
      default: return null;
    }
  }

  hasExplicitModAllowlist(insertMode: boolean): boolean {
    return Boolean(
      (insertMode ? this.ctrlKeysInsert : this.ctrlKeysNormal)
      || (insertMode ? this.altKeysInsert : this.altKeysNormal)
      || (insertMode ? this.metaKeysInsert : this.metaKeysNormal),
    );
  }

  shouldForwardModifiedKeys(ev: KeyboardEvent, insertMode: boolean): boolean {
    const name = this.modifiedKeyName(ev);
    if (!name) return false;
    if (ev.ctrlKey) {
      const allow = insertMode ? this.ctrlKeysInsert : this.ctrlKeysNormal;
      if (allow && !allow.has(name)) return false;
    }
    if (ev.altKey) {
      const allow = insertMode ? this.altKeysInsert : this.altKeysNormal;
      if (allow && !allow.has(name)) return false;
    }
    if (ev.metaKey) {
      const allow = insertMode ? this.metaKeysInsert : this.metaKeysNormal;
      if (allow && !allow.has(name)) return false;
    }
    return true;
  }
}

