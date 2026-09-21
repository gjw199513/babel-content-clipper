import type { RecordingFailureFact } from "../../../packages/core/src/types.js";

import { redactUrl, truncateText } from "./security.js";

const MAX_DIAGNOSTIC_LENGTH = 1_024;

function errorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return typeof error === "string" ? error : "现场录制失败。";
}

export function sanitizeRecorderDiagnostic(value: string): string {
  const withoutIdentifiers = value.replace(
    /\b(stream(?:Id)?|chromeMediaSourceId|token|credential|signature)\s*[:=]\s*[^\s,;]+/giu,
    "$1=[redacted]",
  );
  const withoutUrlCredentials = withoutIdentifiers.replace(/https?:\/\/[^\s"'<>]+/giu, (url) => redactUrl(url));
  return truncateText(withoutUrlCredentials || "现场录制失败。", MAX_DIAGNOSTIC_LENGTH);
}

export function isExplicitRecorderPermissionFailure(code: string, message: string, name = ""): boolean {
  return ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)
    || ["RECORDER_PERMISSION_DENIED", "TAB_CAPTURE_PERMISSION_REQUIRED"].includes(code)
    || /permission denied|not allowed|activeTab.{0,80}(?:required|missing|grant|permission)|(?:extension|capture) has not been invoked/iu.test(message);
}

export function classifyRecorderSetupError(
  error: unknown,
  stage: "get_user_media" | "media_recorder" | "recorder_start" | "start_ack",
): { readonly code: string; readonly message: string } {
  const name = errorName(error);
  const originalCode = errorCode(error);
  const message = sanitizeRecorderDiagnostic(rawErrorMessage(error));
  if (isExplicitRecorderPermissionFailure(originalCode, message, name)) {
    return { code: "RECORDER_PERMISSION_DENIED", message };
  }
  if (name === "NotFoundError") return { code: "RECORDER_STREAM_NOT_FOUND", message };
  if (name === "NotReadableError" || name === "AbortError") {
    return { code: "RECORDER_STREAM_UNREADABLE", message };
  }
  if (name === "OverconstrainedError") return { code: "RECORDER_CONSTRAINT_FAILED", message };
  if (originalCode && originalCode !== "INTERNAL_ERROR") return { code: originalCode, message };
  const codeByStage = {
    get_user_media: "RECORDER_STREAM_FAILED",
    media_recorder: "RECORDER_SETUP_FAILED",
    recorder_start: "RECORDER_START_FAILED",
    start_ack: "RECORDER_START_ACK_FAILED",
  } as const;
  return { code: codeByStage[stage], message };
}

export function recordingFailureFact(
  error: { readonly code: string; readonly message: string },
  stage: RecordingFailureFact["stage"],
  started: boolean,
): RecordingFailureFact {
  const diagnostic = sanitizeRecorderDiagnostic(error.message);
  if (isExplicitRecorderPermissionFailure(error.code, diagnostic)) {
    return {
      code: "TAB_CAPTURE_PERMISSION_REQUIRED",
      message: truncateText(
        `请先在目标页面点击 Babel 扩展图标重新授予当前标签页访问权限，再勾选现场音画重试；若仍失败，请检查浏览器的屏幕录制权限。具体原因：${diagnostic}`,
        4_096,
      ),
      stage,
      started,
    };
  }
  return {
    code: error.code === "INTERNAL_ERROR" ? "RECORDER_START_FAILED" : error.code,
    message: truncateText(diagnostic, 4_096),
    stage,
    started,
  };
}
