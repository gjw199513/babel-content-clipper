import { describe, expect, it } from "vitest";
import {
  EXTENSION_CHANNEL,
  isNativeMethod,
  isSourceStreamMessage,
} from "../../apps/extension/src/messages.js";

describe("extension-owned source acquisition protocol", () => {
  it("exposes acquisition only as a Babel native method", () => {
    expect(isNativeMethod("capture.acquireMedia")).toBe(true);
    expect(isNativeMethod("capture.getAcquisitionSource")).toBe(true);
    expect(isNativeMethod("navigate")).toBe(false);
    expect(isNativeMethod("cdp")).toBe(false);
  });

  it("accepts only the internal ordered source stream messages", () => {
    const common = { channel: EXTENSION_CHANNEL, requestId: "req-source-1" };

    expect(isSourceStreamMessage({
      ...common,
      type: "source_stream_start",
      mimeType: "video/mp4",
      totalBytes: 1024,
    })).toBe(true);
    expect(isSourceStreamMessage({
      ...common,
      type: "source_stream_chunk",
      offset: 0,
      dataBase64: "AAE=",
    })).toBe(true);
    expect(isSourceStreamMessage({
      ...common,
      type: "source_stream_complete",
      totalBytes: 2,
    })).toBe(true);
    expect(isSourceStreamMessage({
      ...common,
      type: "source_stream_error",
      error: { code: "SOURCE_FETCH_FAILED", message: "failed" },
    })).toBe(true);
    expect(isSourceStreamMessage({
      ...common,
      type: "content_reply",
      ok: true,
    })).toBe(false);
  });
});
