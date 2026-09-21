import type { RecordingFailureFact } from "../../../packages/core/src/types.js";

export interface MediaToggleResult {
  readonly status?: "open";
  readonly recordLive?: boolean;
  readonly recording?: "started" | "unavailable";
  readonly recordingFailure?: RecordingFailureFact;
  readonly value?: { readonly state?: "sealed" | "interrupted" };
}

export interface MediaToggleFeedback {
  readonly tone: "success" | "info";
  readonly message: string;
  readonly badge: string;
  readonly keepBadge: boolean;
  readonly consumeRecordLive: boolean;
}

export function describeMediaToggleResult(
  value: unknown,
  requestedRecordLive: boolean,
): MediaToggleFeedback {
  const result = value && typeof value === "object" ? value as MediaToggleResult : {};
  if (result.status === "open") {
    if (result.recordLive === true && result.recording === "started") {
      return {
        tone: "success",
        message: "已开始记录时间范围和现场音画。",
        badge: "REC",
        keepBadge: true,
        consumeRecordLive: requestedRecordLive,
      };
    }
    if (result.recordLive === true && result.recording !== "started") {
      const reason = result.recordingFailure?.message ?? "浏览器没有确认现场音画录制已启动。";
      return {
        tone: "info",
        message: `现场音画未启动：${reason} 时间范围仍在记录。`,
        badge: "RNG",
        keepBadge: true,
        consumeRecordLive: requestedRecordLive,
      };
    }
    return {
      tone: "success",
      message: "已开始记录媒体时间范围。",
      badge: "REC",
      keepBadge: true,
      consumeRecordLive: requestedRecordLive,
    };
  }
  if (result.value?.state === "interrupted") {
    return {
      tone: "info",
      message: "片段已中断，并保留已有采集事实。",
      badge: "!",
      keepBadge: false,
      consumeRecordLive: false,
    };
  }
  return {
    tone: "success",
    message: result.value?.state === "sealed" ? "片段已保存。" : "媒体状态已更新。",
    badge: "✓",
    keepBadge: false,
    consumeRecordLive: false,
  };
}
