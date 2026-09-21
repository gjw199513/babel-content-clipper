import type { CaptureState } from "../../../packages/core/src/types.js";

export const PENDING_MEDIA_SEAL_NOTICE = "上次媒体记录仍在等待本地封存，将在下次启动时重试。";

/** Stop resources before dropping temporary state for an already-terminal Capture. */
export async function discardTerminalMediaState(
  captureState: CaptureState,
  stopAndPreserveRecording: () => Promise<void>,
  removeTemporaryState: () => Promise<void>,
): Promise<boolean> {
  if (captureState === "open") return false;
  await stopAndPreserveRecording();
  await removeTemporaryState();
  return true;
}

export function isPendingMediaSealNotice(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const notice = value as { message?: unknown };
  return notice.message === PENDING_MEDIA_SEAL_NOTICE;
}
