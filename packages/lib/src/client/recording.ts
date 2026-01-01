export type RecordingManagerInit = {
  isSessionRunning: () => boolean;
  rpcCall: (method: string, params: unknown[]) => Promise<any>;
};

export class RecordingManager {
  private readonly init: RecordingManagerInit;

  private recordingRegister = "";
  private executingRegister = "";
  private recordingRefreshArmed = false;
  private recordingRefreshTimer: number | null = null;

  constructor(init: RecordingManagerInit) {
    this.init = init;
  }

  reset(): void {
    this.recordingRegister = "";
    this.recordingRefreshArmed = false;
    if (this.recordingRefreshTimer) {
      clearTimeout(this.recordingRefreshTimer);
      this.recordingRefreshTimer = null;
    }
  }

  getRegister(): string {
    return this.recordingRegister;
  }

  getExecutingRegister(): string {
    return this.executingRegister;
  }

  setRegister(reg: unknown): void {
    this.recordingRegister = typeof reg === "string" ? String(reg) : String(reg ?? "");
  }

  setExecutingRegister(reg: unknown): void {
    this.executingRegister = typeof reg === "string" ? String(reg) : String(reg ?? "");
  }

  handleNormalModeKey(key: string): void {
    const k = String(key ?? "");
    if (k === "q") {
      if (this.recordingRegister) {
        this.recordingRegister = "";
        this.scheduleRefresh();
      } else {
        this.recordingRefreshArmed = true;
      }
      return;
    }
    if (this.recordingRefreshArmed && k.length === 1) {
      this.recordingRefreshArmed = false;
      this.recordingRegister = k;
      this.scheduleRefresh();
    }
  }

  scheduleRefresh(): void {
    if (this.recordingRefreshTimer) return;
    this.recordingRefreshTimer = globalThis.setTimeout(() => {
      this.recordingRefreshTimer = null;
      void this.refreshFromNvim();
    }, 0);
  }

  async refreshFromNvim(): Promise<void> {
    if (!this.init.isSessionRunning()) return;
    try {
      const reg = await this.init.rpcCall("nvim_call_function", ["reg_recording", []]);
      this.recordingRegister = typeof reg === "string" ? reg : String(reg ?? "");
      const exec = await this.init.rpcCall("nvim_call_function", ["reg_executing", []]);
      this.executingRegister = typeof exec === "string" ? exec : String(exec ?? "");
    } catch (_) {
    }
  }
}
