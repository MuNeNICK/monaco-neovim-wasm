export type NotifyRouterInit = {
  debugLog: (line: string) => void;
  notifyHandlers: Map<string, (params: unknown[]) => void | Promise<void>>;
  handleNvimBufLinesEvent: (params: unknown[]) => Promise<void>;
  handleNvimBufDetachEvent: (params: unknown[]) => void;
  handleRedraw: (params: unknown[]) => void;
};

export class NotifyRouter {
  private readonly init: NotifyRouterInit;
  private chain: Promise<void> = Promise.resolve();

  constructor(init: NotifyRouterInit) {
    this.init = init;
  }

  reset(): void {
    this.chain = Promise.resolve();
  }

  onNotify(method: string, params: unknown[]): void {
    const m = String(method ?? "");
    const p = Array.isArray(params) ? params : [];
    this.chain = this.chain
      .then(() => this.dispatch(m, p))
      .catch((err) => {
        const msg = (err as { message?: string })?.message ?? String(err);
        this.init.debugLog(`notify handler failed: method=${m} err=${msg}`);
      });
  }

  private async dispatch(method: string, params: unknown[]): Promise<void> {
    const handler = this.init.notifyHandlers.get(method);
    if (handler) {
      await handler(params);
      return;
    }
    if (method === "nvim_buf_lines_event") {
      await this.init.handleNvimBufLinesEvent(params);
      return;
    }
    if (method === "nvim_buf_detach_event") {
      this.init.handleNvimBufDetachEvent(params);
      return;
    }
    if (method === "redraw") {
      this.init.handleRedraw(params);
    }
  }
}

