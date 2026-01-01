export type InputEventDeduperInit = {
  nowMs: () => number;
};

export class InputEventDeduper {
  private readonly init: InputEventDeduperInit;
  private armed = false;
  private untilMs = 0;
  private target: EventTarget | null = null;

  constructor(init: InputEventDeduperInit) {
    this.init = init;
  }

  reset(): void {
    this.clear();
  }

  arm(target?: EventTarget | null, ms = 80): void {
    this.armed = true;
    this.target = target ?? null;
    const now = this.init.nowMs();
    this.untilMs = now + Math.max(10, Math.min(500, Number(ms) || 0));
  }

  shouldIgnore(target?: EventTarget | null): boolean {
    if (!this.armed) return false;
    const now = this.init.nowMs();
    if (now > this.untilMs) {
      this.clear();
      return false;
    }
    if (this.target && target && this.target !== target) {
      return false;
    }
    return true;
  }

  clear(): void {
    this.armed = false;
    this.target = null;
    this.untilMs = 0;
  }
}

