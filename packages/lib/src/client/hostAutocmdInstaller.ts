import { buildHostAutocmdsLua } from "./hostAutocmds";

export type HostAutocmdInstallerInit = {
  isClipboardEnabled: () => boolean;
  isWrappedLineMotionsEnabled: () => boolean;
  isScrollMotionsEnabled: () => boolean;
  isSyncScrolloffEnabled: () => boolean;
  hasScrolloffOverride: () => boolean;
  isHostCommandsEnabled: () => boolean;

  rpcCall: (method: string, params: unknown[]) => Promise<any>;
  execLua: (code: string, args: unknown[]) => Promise<any>;
};

export class HostAutocmdInstaller {
  private readonly init: HostAutocmdInstallerInit;
  private installed = false;
  private channelId: number | null = null;

  constructor(init: HostAutocmdInstallerInit) {
    this.init = init;
  }

  reset(): void {
    this.installed = false;
    this.channelId = null;
  }

  isInstalled(): boolean {
    return this.installed;
  }

  markInstalledFromNotify(): void {
    this.installed = true;
  }

  getChannelId(): number | null {
    return this.channelId;
  }

  async install(): Promise<void> {
    if (this.installed) return;
    try {
      const info = await this.init.rpcCall("nvim_get_api_info", []);
      const chan = Array.isArray(info) ? Number(info[0]) : NaN;
      if (!Number.isFinite(chan) || chan <= 0) return;
      this.channelId = chan;
      const lua = buildHostAutocmdsLua({
        clipboard: this.init.isClipboardEnabled(),
        wrappedLineMotions: this.init.isWrappedLineMotionsEnabled(),
        scrollMotions: this.init.isScrollMotionsEnabled(),
        syncScrolloff: this.init.isSyncScrolloffEnabled() && !this.init.hasScrolloffOverride(),
        hostCommands: this.init.isHostCommandsEnabled(),
      });
      await this.init.execLua(lua, [chan]);
      this.installed = true;
    } catch (_) {
    }
  }
}

