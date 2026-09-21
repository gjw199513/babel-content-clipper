import { describe, expect, it } from "vitest";

import { describeMediaToggleResult } from "../../apps/extension/src/media-action.js";

describe("one-shot live recording choice", () => {
  it("consumes the choice only after an accepted start and preserves the concrete warning", () => {
    const warning = describeMediaToggleResult({
      status: "open",
      recordLive: true,
      recording: "unavailable",
      recordingFailure: {
        code: "TAB_CAPTURE_PERMISSION_REQUIRED",
        message: "请先在目标页面点击 Babel 扩展图标重新授予当前标签页访问权限。",
        stage: "start",
        started: false,
      },
    }, true);
    expect(warning).toMatchObject({ tone: "info", consumeRecordLive: true, keepBadge: true });
    expect(warning.message).toContain("重新授予当前标签页访问权限");

    const ended = describeMediaToggleResult({ value: { state: "sealed" } }, true);
    expect(ended).toMatchObject({
      tone: "success",
      message: "片段已保存。",
      consumeRecordLive: false,
    });
  });
});
