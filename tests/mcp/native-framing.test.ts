import { describe, expect, it } from "vitest";
import {
  NativeMessageDecoder,
  encodeNativeMessage,
} from "../../packages/mcp/src/native-framing.js";
import { MAX_NATIVE_MESSAGE_BYTES } from "../../packages/mcp/src/constants.js";

describe("Native Messaging framing", () => {
  it("reassembles fragmented frames and preserves adjacent messages", () => {
    const first = encodeNativeMessage({ v: 1, id: "one", method: "capture.list", params: {} });
    const second = encodeNativeMessage({ v: 1, id: "two", ok: true, result: { value: 2 } });
    const combined = Buffer.concat([first, second]);
    const decoder = new NativeMessageDecoder(MAX_NATIVE_MESSAGE_BYTES);

    expect(decoder.push(combined.subarray(0, 3))).toEqual([]);
    expect(decoder.push(combined.subarray(3, 11))).toEqual([]);
    expect(decoder.push(combined.subarray(11))).toEqual([
      { v: 1, id: "one", method: "capture.list", params: {} },
      { v: 1, id: "two", ok: true, result: { value: 2 } },
    ]);
  });

  it("rejects a declared frame above the Native Messaging limit before buffering it", () => {
    const frame = Buffer.alloc(4);
    frame.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
    const decoder = new NativeMessageDecoder(MAX_NATIVE_MESSAGE_BYTES);
    expect(() => decoder.push(frame)).toThrow(expect.objectContaining({ code: "FRAME_TOO_LARGE" }));
  });

  it("rejects malformed JSON without accepting a partial request", () => {
    const body = Buffer.from("{not-json", "utf8");
    const frame = Buffer.alloc(4 + body.byteLength);
    frame.writeUInt32LE(body.byteLength, 0);
    body.copy(frame, 4);
    const decoder = new NativeMessageDecoder(MAX_NATIVE_MESSAGE_BYTES);
    expect(() => decoder.push(frame)).toThrow(expect.objectContaining({ code: "INVALID_JSON" }));
  });
});
