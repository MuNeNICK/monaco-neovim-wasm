import { Directory, File, Inode, PreopenDirectory, wasi } from "@bjorn3/browser_wasi_shim";
import { gunzipSync } from "fflate";

export type DirNode = Directory & { contents: Map<string, any> };

export type TarEntry = { name: string; type: "dir" | "file"; data: Uint8Array };

export type WorkerFileData = Uint8Array | ArrayBuffer | ArrayLike<number> | { type: "Buffer"; data: number[] };
export type WorkerFile = { path: string; data: WorkerFileData };

export type ExtraFile = { path: string; data: unknown };

let cachedWasm: { url: string; bytes: Uint8Array } | null = null;
let cachedRuntime: { url: string; entries: TarEntry[] } | null = null;

export const FORWARD_NOTIFY_METHODS = new Set<string>([
  "nvim_buf_lines_event",
  "nvim_buf_detach_event",
  "redraw",
  "monaco_cursor",
  "monaco_mode",
  "monaco_cursorMove",
  "monaco_scroll",
  "monaco_reveal",
  "monaco_moveCursor",
  "monaco_scrolloff",
  "monaco_host_command",
  "monaco_buf_enter",
  "monaco_buf_delete",
  "monaco_visual_changed",
  "monaco_recording",
]);

function normalizeExtraFilePath(rawPath: unknown): string | null {
  const raw = String(rawPath ?? "");
  if (!raw) return null;
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\/+/, "");
  if (!normalized || normalized.endsWith("/")) return null;
  if (normalized.includes("\0")) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    if (part === "." || part === "..") return null;
  }
  return parts.join("/");
}

export function applyExtraFiles(fsRoot: DirNode, files: ExtraFile[]) {
  for (const file of files) {
    const clean = normalizeExtraFilePath(file?.path);
    if (!clean) continue;
    const data = toU8(file?.data);
    if (data == null) continue;
    const parts = clean.split("/").filter(Boolean);
    let dir: DirNode = fsRoot;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!dir.contents.has(part)) dir.contents.set(part, new Directory(new Map()));
      dir = dir.contents.get(part) as DirNode;
    }
    const leaf = parts[parts.length - 1];
    dir.contents.set(leaf, new File(data, { readonly: false }));
  }
}

export function toU8(data: unknown): Uint8Array | null {
  if (data == null) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof SharedArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  if (typeof data === "object") {
    const maybeBuffer = data as { type?: unknown; data?: unknown };
    if (maybeBuffer.type === "Buffer" && Array.isArray(maybeBuffer.data)) {
      return new Uint8Array(maybeBuffer.data as number[]);
    }
  }
  try {
    return new TextEncoder().encode(String(data));
  } catch (_) {
    return null;
  }
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed (${res.status})`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) throw new Error(`fetch ${url} returned HTML (likely wrong path or dev server fallback)`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (!data.byteLength) throw new Error(`fetch ${url} returned empty body`);
  return data;
}

export function looksLikeGzip(data: Uint8Array) {
  return data && data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

export async function getCachedWasmBytes(url: string): Promise<Uint8Array> {
  if (cachedWasm && cachedWasm.url === url && cachedWasm.bytes?.byteLength) return cachedWasm.bytes;
  const bytes = await fetchBytes(url);
  cachedWasm = { url, bytes };
  return bytes;
}

export async function getCachedRuntimeEntries(url: string): Promise<TarEntry[]> {
  if (cachedRuntime && cachedRuntime.url === url && cachedRuntime.entries?.length) return cachedRuntime.entries;
  const archive = await fetchBytes(url);
  let runtimeBytes: Uint8Array;
  if (looksLikeGzip(archive)) {
    try {
      runtimeBytes = gunzipSync(archive);
    } catch (e) {
      throw new Error(`gunzip runtime failed: ${(e as Error)?.message ?? e}`);
    }
  } else {
    runtimeBytes = archive;
  }
  let entries: TarEntry[];
  try {
    entries = untar(runtimeBytes);
  } catch (e) {
    throw new Error(`untar runtime failed: ${(e as Error)?.message ?? e}`);
  }
  cachedRuntime = { url, entries };
  return entries;
}

export function untar(bytes: Uint8Array): TarEntry[] {
  const files: TarEntry[] = [];
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let offset = 0;
  const decoder = new TextDecoder();
  let safety = 0;

  while (offset + 512 <= data.length) {
    if (safety++ > 100_000) throw new Error("untar safety break");
    const name = decodeTarString(decoder, data, offset, 100);
    const sizeText = decodeTarString(decoder, data, offset + 124, 12);
    const typeflag = data[offset + 156];
    const prefix = decodeTarString(decoder, data, offset + 345, 155);
    if (!name && !prefix) break;
    const sizeRaw = sizeText.trim() || "0";
    const size = parseInt(sizeRaw, 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`invalid tar size: ${sizeRaw}`);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    const payload = data.slice(bodyStart, bodyEnd);
    files.push({ name: fullName, type: typeflag === 53 ? "dir" : "file", data: payload });
    const blocks = Math.ceil(size / 512);
    const next = bodyStart + blocks * 512;
    if (next <= offset) throw new Error("tar parse did not advance");
    offset = next;
  }
  return files;
}

function decodeTarString(decoder: TextDecoder, data: Uint8Array, start: number, length: number): string {
  let end = start;
  const max = start + length;
  while (end < max && data[end] !== 0) end += 1;
  return decoder.decode(data.subarray(start, end)).trim();
}

export function buildFs(entries: TarEntry[], onProgress?: (count: number) => void) {
  const root = new Directory(new Map()) as DirNode;
  let count = 0;
  for (const entry of entries) {
    const clean = entry.name.replace(/^\.\/?/, "");
    if (!clean) continue;
    const parts = clean.split("/").filter(Boolean);
    if (!parts.length) continue;
    count += 1;
    if (onProgress && count % 500 === 0) onProgress(count);

    let dir: DirNode = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!dir.contents.has(part)) dir.contents.set(part, new Directory(new Map()));
      dir = dir.contents.get(part) as DirNode;
    }

    const leaf = parts[parts.length - 1];
    if (entry.type === "dir") {
      if (!dir.contents.has(leaf)) dir.contents.set(leaf, new Directory(new Map()));
    } else {
      dir.contents.set(leaf, new File(entry.data, { readonly: true }));
    }
  }

  ensureDir(root, "home");
  ensureDir(root, "tmp");
  ensureDir(root, "home/.config");
  ensureDir(root, "home/.local/share");
  ensureDir(root, "home/.local/state");

  return root;
}

function ensureDir(root: DirNode, path: string) {
  const parts = path.split("/").filter(Boolean);
  let node: DirNode = root;
  for (const p of parts) {
    if (!node.contents.has(p)) node.contents.set(p, new Directory(new Map()));
    node = node.contents.get(p) as DirNode;
  }
}

export function makeEnv(procExit?: (code: number) => void) {
  const wasmAny = WebAssembly as any;
  const cLongjmp = new wasmAny.Tag({ parameters: ["i32"], results: [] }) as any;
  return {
    flock: () => 0,
    getpid: () => 1,
    uv_random: () => -38,
    uv_wtf8_to_utf16: () => {},
    uv_utf16_length_as_wtf8: () => 0,
    uv_utf16_to_wtf8: () => -38,
    uv_wtf8_length_as_utf16: () => 0,
    __wasm_longjmp: (ptr: number) => {
      if (procExit) procExit(1);
      throw new wasmAny.Exception(cLongjmp, [ptr ?? 0]);
    },
    __wasm_setjmp: () => 0,
    __wasm_setjmp_test: () => 0,
    tmpfile: () => 0,
    clock: () => 0,
    system: () => -1,
    tmpnam: () => 0,
    __c_longjmp: cLongjmp,
  } as WebAssembly.ModuleImports;
}

export class RootedPreopenDirectory extends PreopenDirectory {
  #strip(path: string) { return path.replace(/^\/+/, ""); }
  path_open(
    dirflags: number,
    path_str: string,
    oflags: number,
    fs_rights_base: bigint,
    fs_rights_inheriting: bigint,
    fd_flags: number,
  ) {
    return super.path_open(dirflags, this.#strip(path_str), oflags, fs_rights_base, fs_rights_inheriting, fd_flags);
  }
  path_filestat_get(flags: number, path_str: string) { return super.path_filestat_get(flags, this.#strip(path_str)); }
  path_create_directory(path_str: string) { return super.path_create_directory(this.#strip(path_str)); }
  path_unlink_file(path_str: string) { return super.path_unlink_file(this.#strip(path_str)); }
  path_remove_directory(path_str: string) { return super.path_remove_directory(this.#strip(path_str)); }
  path_link(path_str: string, inode: Inode, allow_dir: boolean) { return super.path_link(this.#strip(path_str), inode, allow_dir); }
  path_readlink(path_str: string) { return super.path_readlink(this.#strip(path_str)); }
  path_symlink(old_path: string, new_path: string) {
    const target = (PreopenDirectory.prototype as unknown as { path_symlink?: (oldPath: string, newPath: string) => number }).path_symlink;
    if (!target) return wasi.ERRNO_NOTSUP;
    return target.call(this, this.#strip(old_path), this.#strip(new_path));
  }
}
