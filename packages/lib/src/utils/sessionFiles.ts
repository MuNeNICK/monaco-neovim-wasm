export function normalizeSessionFiles(
  files?: Array<{ path: string; data: Uint8Array | string }> | null,
): Array<{ path: string; data: Uint8Array }> | undefined {
  if (!files || !Array.isArray(files) || files.length === 0) return undefined;
  const enc = new TextEncoder();
  const out: Array<{ path: string; data: Uint8Array }> = [];
  for (const f of files) {
    if (!f) continue;
    const path = String((f as any).path ?? "");
    if (!path) continue;
    const data = (f as any).data;
    if (data instanceof Uint8Array) out.push({ path, data });
    else out.push({ path, data: enc.encode(String(data ?? "")) });
  }
  return out.length ? out : undefined;
}

export function mergeSessionFiles(
  user?: Array<{ path: string; data: Uint8Array | string }> | null,
  internal?: Array<{ path: string; data: Uint8Array | string }> | null,
): Array<{ path: string; data: Uint8Array | string }> | undefined {
  const a = Array.isArray(internal) ? internal.filter(Boolean) : [];
  const b = Array.isArray(user) ? user.filter(Boolean) : [];
  const all = [...a, ...b];
  return all.length ? all : undefined;
}

