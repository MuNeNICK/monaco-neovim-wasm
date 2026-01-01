export type InputEventDeduperInit = {
  nowMs: () => number;
};

export class InputEventDeduper {
  private readonly init: InputEventDeduperInit;
  private armed = false;
  private untilMs = 0;
  private target: EventTarget | null = null;
  private expectedData: string | null = null;

  constructor(init: InputEventDeduperInit) {
    this.init = init;
  }

  reset(): void {
    this.clear();
  }

  arm(target?: EventTarget | null, ms = 80, expectedData?: string | null): void {
    this.armed = true;
    this.target = target ?? null;
    this.expectedData = expectedData != null ? String(expectedData) : null;
    const now = this.init.nowMs();
    this.untilMs = now + Math.max(10, Math.min(500, Number(ms) || 0));
  }

  shouldIgnore(target?: EventTarget | null, data?: unknown): boolean {
    if (!this.armed) return false;
    const now = this.init.nowMs();
    if (now > this.untilMs) {
      this.clear();
      return false;
    }
    if (this.target && target && this.target !== target) {
      return false;
    }
    if (this.expectedData != null) {
      const d = typeof data === "string" ? data : "";
      if (d !== this.expectedData) return false;
    }
    return true;
  }

  clear(): void {
    this.armed = false;
    this.target = null;
    this.untilMs = 0;
    this.expectedData = null;
  }
}
