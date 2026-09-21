import type { CaptureCreateResult } from "../../../packages/core/src/types.js";

export interface CaptureActionFeedback {
  readonly tone: "success" | "info";
  readonly message: string;
  readonly badge: string;
}

function numericMetadata(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

export function describeCaptureSaveResult(
  result: unknown,
  completeMessage = "内容已保存到当前浏览器。",
): CaptureActionFeedback {
  const response = result as Partial<CaptureCreateResult> | undefined;
  const capture = response?.value?.capture;
  if (!capture) return { tone: "success", message: completeMessage, badge: "✓" };

  if (capture.kind === "image" && capture.assetsState !== "saved") {
    return {
      tone: "info",
      message: "图片来源引用已保存，但图片数据未保存；后续处理需要重新获取来源。",
      badge: "!",
    };
  }

  if (capture.integrity.status === "partial" && capture.integrity.missing.includes("image_bytes")) {
    const metadata = capture.selection.type === "text" ? capture.selection.locator?.metadata : undefined;
    const selected = numericMetadata(metadata, "selectedImageCount");
    const saved = capture.attachmentIds.length;
    const counts = selected === undefined ? "" : `（已保存 ${saved}/${selected} 张图片的数据）`;
    return {
      tone: "info",
      message: `选中内容已保存，但图片数据仅部分保存${counts}；其余图片引用和缺失事实已保留。`,
      badge: "!",
    };
  }

  if (capture.integrity.status === "partial") {
    return {
      tone: "info",
      message: "内容已保存，但部分附件数据不可用；缺失事实已记录。",
      badge: "!",
    };
  }
  return { tone: "success", message: completeMessage, badge: "✓" };
}
