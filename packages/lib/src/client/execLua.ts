export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export class ExecLuaClient {
  private execLuaAvailable: boolean | null = null;
  private readonly rpcCall: RpcCall;

  constructor(rpcCall: RpcCall) {
    this.rpcCall = rpcCall;
  }

  async execLua<T = unknown>(code: string, args: unknown[] = []): Promise<T> {
    const source = String(code ?? "");
    const argv = Array.isArray(args) ? args : [];
    if (this.execLuaAvailable !== false) {
      try {
        const res = await this.rpcCall("nvim_exec_lua", [source, argv]) as T;
        this.execLuaAvailable = true;
        return res;
      } catch (err) {
        const msg = (err as { message?: string })?.message || String(err);
        if (msg.includes("Invalid method") && msg.includes("nvim_exec_lua")) {
          this.execLuaAvailable = false;
        } else {
          throw err;
        }
      }
    }
    const expr = `(function(...)\n${source}\nend)(unpack(_A))`;
    return this.rpcCall("nvim_call_function", ["luaeval", [expr, argv]]) as Promise<T>;
  }
}

