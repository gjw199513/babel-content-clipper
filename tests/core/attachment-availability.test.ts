import { describe, expect, it } from "vitest";

import type { AttachmentRecord } from "../../packages/core/src/index.js";
import {
  attachmentAvailabilityLabel,
  attachmentHasAvailableBytes,
} from "../../apps/extension/src/ui-shared.js";

const legacyUnstartedRecording = {
  attachmentId: "asset_legacy_unstarted",
  profileId: "profile-ui",
  kind: "browser_recording",
  mimeType: "video/webm",
  storage: "chunked",
  dataAvailable: true,
  status: "interrupted",
  byteLength: 0,
  recordingFailure: {
    code: "TAB_CAPTURE_PERMISSION_REQUIRED",
    message: "Current-tab capture permission was not granted.",
    stage: "start",
    started: false,
  },
  createdAt: "2026-09-19T10:45:58.180Z",
  completedAt: "2026-09-19T10:45:58.184Z",
  revision: 8,
} satisfies AttachmentRecord;

const legacyEmptyRecordingWithoutDiagnostic = {
  attachmentId: "asset_legacy_empty_without_diagnostic",
  profileId: "profile-ui",
  kind: "browser_recording",
  mimeType: "video/webm",
  storage: "chunked",
  dataAvailable: true,
  status: "interrupted",
  byteLength: 0,
  createdAt: "2026-09-19T10:45:58.180Z",
  completedAt: "2026-09-19T10:45:58.184Z",
  revision: 8,
} satisfies AttachmentRecord;

describe("attachment availability presentation", () => {
  it("does not count a legacy unstarted zero-byte recording as byte data", () => {
    expect(attachmentHasAvailableBytes(legacyUnstartedRecording)).toBe(false);
    expect(attachmentAvailabilityLabel(legacyUnstartedRecording)).toBe(
      "无录制字节，失败事实可用",
    );
  });

  it("keeps persisted partial recording bytes available", () => {
    const partial = {
      ...legacyUnstartedRecording,
      byteLength: 3,
      recordingFailure: {
        code: "RECORDER_CHUNK_FAILED",
        message: "A later chunk failed.",
        stage: "chunk",
        started: true,
      },
    } satisfies AttachmentRecord;
    expect(attachmentHasAvailableBytes(partial)).toBe(true);
    expect(attachmentAvailabilityLabel(partial)).toBe("数据可用");
  });

  it("does not count a legacy terminal zero-byte recording without diagnostics", () => {
    expect(attachmentHasAvailableBytes(legacyEmptyRecordingWithoutDiagnostic)).toBe(false);
    expect(attachmentAvailabilityLabel(legacyEmptyRecordingWithoutDiagnostic)).toBe(
      "暂无可用录制数据",
    );
  });
});
