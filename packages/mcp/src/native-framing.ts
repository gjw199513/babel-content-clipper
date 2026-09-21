import { MAX_NATIVE_MESSAGE_BYTES } from "./constants.js";
import { ClipperBridgeError } from "./errors.js";

/**
 * Chromium Native Messaging frames are UTF-8 JSON prefixed by a 32-bit
 * little-endian byte length. The broker uses the same framed JSON envelope on
 * its private local IPC sockets, so fragmented reads behave identically.
 */
export class NativeMessageDecoder {
  private buffered = Buffer.alloc(0);

  constructor(private readonly maxMessageBytes = MAX_NATIVE_MESSAGE_BYTES) {}

  push(chunk: Buffer | Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const messages: unknown[] = [];

    while (this.buffered.byteLength >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length > this.maxMessageBytes) {
        this.buffered = Buffer.alloc(0);
        throw new ClipperBridgeError("FRAME_TOO_LARGE", `A local bridge frame exceeded the ${this.maxMessageBytes}-byte limit.`);
      }
      if (this.buffered.byteLength < length + 4) break;

      const body = this.buffered.subarray(4, length + 4);
      this.buffered = this.buffered.subarray(length + 4);
      try {
        messages.push(JSON.parse(body.toString("utf8")) as unknown);
      } catch {
        throw new ClipperBridgeError("INVALID_JSON", "A local bridge frame did not contain valid JSON.");
      }
    }

    if (this.buffered.byteLength > this.maxMessageBytes + 4) {
      this.buffered = Buffer.alloc(0);
      throw new ClipperBridgeError("FRAME_TOO_LARGE", `A local bridge frame exceeded the ${this.maxMessageBytes}-byte limit.`);
    }
    return messages;
  }

  clear(): void {
    this.buffered = Buffer.alloc(0);
  }
}

export function encodeNativeMessage(value: unknown, maxMessageBytes = MAX_NATIVE_MESSAGE_BYTES): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new ClipperBridgeError("INVALID_MESSAGE", "The local bridge cannot frame an undefined message.");
  }
  const body = Buffer.from(json, "utf8");
  if (body.byteLength > maxMessageBytes) {
    throw new ClipperBridgeError("FRAME_TOO_LARGE", `A local bridge frame exceeded the ${maxMessageBytes}-byte limit.`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}
