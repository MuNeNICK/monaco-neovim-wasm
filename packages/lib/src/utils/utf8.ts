export function utf8StringByteLength(text: string): number {
  try {
    return new TextEncoder().encode(String(text ?? "")).length;
  } catch (_) {
    return String(text ?? "").length;
  }
}

export function byteIndexToCharIndex(text: string, byteIndex: number): number {
  let totalBytes = 0;
  let charIndex = 0;
  const target = Math.max(0, Number(byteIndex) || 0);
  while (totalBytes < target) {
    if (charIndex >= text.length) {
      return charIndex + (target - totalBytes);
    }
    const code = text.codePointAt(charIndex);
    const bytes = utf8ByteLength(code ?? 0);
    if (totalBytes + bytes > target) return charIndex;
    totalBytes += bytes;
    charIndex += (code != null && code > 0xffff) ? 2 : 1;
  }
  return charIndex;
}

export function charIndexToByteIndex(text: string, charIndex: number): number {
  const target = Math.max(0, Number(charIndex) || 0);
  let bytes = 0;
  let i = 0;
  while (i < target && i < text.length) {
    const code = text.codePointAt(i);
    const b = utf8ByteLength(code ?? 0);
    bytes += b;
    i += (code != null && code > 0xffff) ? 2 : 1;
  }
  return bytes;
}

export function utf8ByteLength(point: number): number {
  if (point == null) return 0;
  if (point <= 0x7f) return 1;
  if (point <= 0x7ff) return 2;
  // Unpaired surrogates are encoded as U+FFFD by TextEncoder (3 bytes).
  if (point >= 0xd800 && point <= 0xdfff) return 3;
  if (point <= 0xffff) return 3;
  return 4;
}
