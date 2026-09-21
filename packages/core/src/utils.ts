import { ClipperError } from "./errors.js";

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child !== undefined) {
        sorted[key] = stableValue(child);
      }
    }
    return sorted;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/** FNV-1a 64-bit is used as a compact equality fingerprint, not for security. */
export function fingerprint(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const triple = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(triple >> 18) & 63];
    output += BASE64_ALPHABET[(triple >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return output;
}

export function base64ToBytes(input: string): Uint8Array {
  const compact = input.replace(/\s/gu, "");
  if (
    compact.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      compact,
    )
  ) {
    throw new ClipperError("VALIDATION_ERROR", "Attachment chunk is not valid base64");
  }

  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((compact.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < compact.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(compact[index] ?? "");
    const b = BASE64_ALPHABET.indexOf(compact[index + 1] ?? "");
    const cChar = compact[index + 2] ?? "=";
    const dChar = compact[index + 3] ?? "=";
    const c = cChar === "=" ? 0 : BASE64_ALPHABET.indexOf(cChar);
    const d = dChar === "=" ? 0 : BASE64_ALPHABET.indexOf(dChar);
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < output.length) output[outputIndex++] = (triple >> 16) & 255;
    if (outputIndex < output.length) output[outputIndex++] = (triple >> 8) & 255;
    if (outputIndex < output.length) output[outputIndex++] = triple & 255;
  }
  return output;
}

export function makeId(prefix: string, randomUUID: () => string): string {
  return `${prefix}_${randomUUID()}`;
}

export function defaultRandomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  throw new ClipperError("STORAGE_FAILED", "A secure random UUID source is unavailable");
}

