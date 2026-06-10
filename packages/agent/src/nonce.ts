/** Random 128-bit hex nonce (per-conversation untrusted-content boundary). */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Short unique id for messages and tool-call parts. */
export function newId(prefix: string): string {
  return `${prefix}-${randomNonce().slice(0, 12)}`;
}
