import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import { describeCaptureSaveResult } from "../../apps/extension/src/capture-feedback.js";
import { classifyContentAccessFailure } from "../../apps/extension/src/content-access.js";
import {
  classifyRecorderSetupError,
  recordingFailureFact,
  sanitizeRecorderDiagnostic,
} from "../../apps/extension/src/recording-errors.js";
import {
  MAX_SELECTION_IMAGE_FETCHES,
  MAX_SELECTION_IMAGE_REFERENCES,
  planSelectionImages,
} from "../../apps/extension/src/selection-images.js";
import {
  createClipperService,
  deleteClipperDatabase,
  redactUrlCredentials,
  type BackupBundle,
  type CaptureCreateResult,
  type CaptureDetailResult,
  type CoreService,
} from "../../packages/core/src/index.js";

const services: CoreService[] = [];
const databases: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.allSettled(databases.splice(0).map(deleteClipperDatabase));
});

function service(): CoreService {
  const databaseName = `security-boundary-${crypto.randomUUID()}`;
  databases.push(databaseName);
  const target = createClipperService({ databaseName, defaultProfileId: "security-profile" });
  services.push(target);
  return target;
}

describe("URL credential boundaries", () => {
  it("redacts case-insensitive auth, signed URL, fragment, and user-info credentials", () => {
    const redacted = redactUrlCredentials(
      "https://demo-user:demo-pass@example.test/watch?safe=visible&Access_Token=dummy-a&authToken=dummy-b&X-Amz-Credential=dummy-c&X-Amz-Security-Token=dummy-d&X-Amz-Signature=dummy-e#/lesson?chapter=2&ID_TOKEN=dummy-f",
    );
    expect(redacted).toContain("safe=visible");
    expect(redacted).toContain("chapter=2");
    expect(redacted).not.toMatch(/demo-user|demo-pass|dummy-[a-f]|access_token|authtoken|x-amz|id_token/iu);
  });

  it("sanitizes page, canonical, frame, media, and resource URLs before persistence and export", async () => {
    const target = service();
    const created = await target.handle("capture.create", {
      requestId: "sanitize-url-capture",
      input: {
        kind: "image",
        state: "sealed",
        source: {
          title: "Credential boundary",
          pageUrl: "https://example.test/page?safe=1&ACCESS_TOKEN=dummy-page",
          canonicalUrl: "https://example.test/canonical?X-Amz-Credential=dummy-canonical",
          chapterHref: "https://example.test/chapter?authToken=dummy-chapter",
          site: "example.test",
          frame: { frameId: 2, frameUrl: "https://frame.example.test/?signature=dummy-frame" },
          metadata: {
            mediaUrl: "https://cdn.example.test/video.mp4?X-Amz-Security-Token=dummy-media",
            nested: { posterUrl: "https://cdn.example.test/poster.jpg?api_key=dummy-poster" },
          },
        },
        selection: {
          type: "image",
          resourceUrl: "https://cdn.example.test/image.jpg?refresh_token=dummy-resource",
          locator: { thumbnailUrl: "https://cdn.example.test/thumb.jpg?client_secret=dummy-thumb" },
        },
        captureMethod: "security-fixture",
        assetsState: "location_only",
        integrity: { status: "partial", missing: ["image_bytes"] },
      },
    }) as CaptureCreateResult;
    const detail = await target.handle("capture.get", {
      captureId: created.value.capture.captureId,
    }) as CaptureDetailResult;
    const backup = await target.handle("backup.export", {
      includeAttachmentData: false,
    }) as BackupBundle;
    const serialized = JSON.stringify({ detail, backup });
    expect(serialized).toContain("safe=1");
    expect(serialized).not.toMatch(/dummy-(?:page|canonical|chapter|frame|media|poster|resource|thumb)/u);
    expect(detail.capture.sourceKey).toBe("https://example.test/canonical");
  });

  it("keeps acquisition context private while allowing a claimed Job to resolve it", async () => {
    const target = service();
    const privatePageUrl = "https://www.xiaohongshu.com/explore/demo?xsec_token=private-value&xsec_source=pc_search";
    const created = await target.handle("capture.create", {
      requestId: "private-acquisition-capture",
      input: {
        kind: "media_range",
        state: "sealed",
        source: {
          title: "Private source context",
          pageUrl: "https://www.xiaohongshu.com/explore/demo",
          acquisitionUrl: privatePageUrl,
          site: "www.xiaohongshu.com",
          mediaAcquisitionUrl: "blob:https://www.xiaohongshu.com/temporary",
        },
        selection: {
          type: "media",
          target: "media_object",
          timeBasis: "source_media",
          startClick: { mediaSeconds: 1, wallTime: "2026-09-21T00:00:00.000Z" },
          endClick: { mediaSeconds: 2, wallTime: "2026-09-21T00:00:01.000Z" },
          segments: [{ start: 1, end: 2 }],
        },
        captureMethod: "security-fixture",
        assetsState: "location_only",
        integrity: { status: "complete_selection", missing: [] },
      },
    }) as CaptureCreateResult;
    const captureId = created.value.capture.captureId;
    const jobId = created.value.job?.jobId;
    if (!jobId) throw new Error("media fixture did not create a Job");
    const claimed = await target.handle("job.claim", {
      requestId: "private-acquisition-claim",
      agentId: "private-acquisition-agent",
      jobIds: [jobId],
      requireOutputDirectory: false,
    }) as { items: Array<{ claimToken?: string }> };
    const claimToken = claimed.items[0]?.claimToken;
    if (!claimToken) throw new Error("media fixture was not claimed");

    const detail = await target.handle("capture.get", { captureId }) as CaptureDetailResult;
    const backup = await target.handle("backup.export", { includeAttachmentData: false }) as BackupBundle;
    expect(JSON.stringify({ detail, backup })).not.toContain("private-value");

    const context = await target.handle("capture.getAcquisitionSource", {
      captureId,
      jobId,
      claimToken,
    });
    expect(context).toMatchObject({ captureId, jobId, pageUrl: privatePageUrl, mediaUrl: "blob:https://www.xiaohongshu.com/temporary" });
    expect(JSON.stringify(context)).toContain("private-value");
  });
});

describe("bounded mixed-selection images and visible partial results", () => {
  it("preserves all typical selected references while bounding byte fetches and recording skipped counts", () => {
    const references = Array.from({ length: 23 }, (_, index) => `https://images.test/${index}.png`);
    const plan = planSelectionImages({ imageRefs: references, selectedImageCount: 23 });
    expect(plan.references).toEqual(references);
    expect(plan.fetchReferences).toHaveLength(MAX_SELECTION_IMAGE_FETCHES);
    expect(plan.skippedFetchCount).toBe(15);
    expect(plan.isPartial).toBe(true);

    const oversized = planSelectionImages({
      imageRefs: Array.from({ length: 70 }, (_, index) => `https://images.test/${index}.png`),
      selectedImageCount: 70,
    });
    expect(oversized.references).toHaveLength(MAX_SELECTION_IMAGE_REFERENCES);
    expect(oversized.omittedReferenceCount).toBe(6);
    expect(oversized.skippedFetchCount).toBe(62);
  });

  it("reports reference-only and partially saved image captures instead of generic success", () => {
    const referenceOnly = describeCaptureSaveResult({
      value: {
        capture: {
          kind: "image",
          assetsState: "location_only",
          integrity: { status: "partial", missing: ["image_bytes"] },
          attachmentIds: [],
          selection: { type: "image" },
        },
      },
    });
    expect(referenceOnly).toMatchObject({ tone: "info", badge: "!" });
    expect(referenceOnly.message).toContain("图片来源引用已保存");
    expect(referenceOnly.message).toContain("图片数据未保存");

    const partial = describeCaptureSaveResult({
      value: {
        capture: {
          kind: "mixed_selection",
          assetsState: "partial_saved",
          integrity: { status: "partial", missing: ["image_bytes", "image_fetch_limit"] },
          attachmentIds: Array.from({ length: 8 }, (_, index) => `asset-${index}`),
          selection: {
            type: "text",
            locator: { metadata: { selectedImageCount: 23 } },
          },
        },
      },
    });
    expect(partial).toMatchObject({ tone: "info", badge: "!" });
    expect(partial.message).toContain("8/23");
    expect(partial.message).toContain("其余图片引用和缺失事实已保留");
  });
});

describe("diagnosable browser and recorder failures", () => {
  it("maps restricted pages and frames to stable, visible codes without echoing the URL", () => {
    const page = classifyContentAccessFailure(
      new Error("Cannot access contents of url https://private.example.test/?token=dummy"),
      0,
    );
    const frame = classifyContentAccessFailure(new Error("Missing host permission for the tab"), 4);
    const gone = classifyContentAccessFailure(new Error("No frame with id 4 in tab 12"), 4);
    const protectedScheme = classifyContentAccessFailure(new Error("Cannot access a chrome:// URL"), 0);
    expect(page).toMatchObject({ code: "PAGE_ACCESS_RESTRICTED" });
    expect(frame).toMatchObject({ code: "FRAME_ACCESS_RESTRICTED" });
    expect(gone).toMatchObject({ code: "FRAME_UNAVAILABLE" });
    expect(protectedScheme).toMatchObject({ code: "PAGE_ACCESS_RESTRICTED" });
    expect(JSON.stringify({ page, frame, gone, protectedScheme })).not.toContain("private.example.test");
  });

  it("uses permission guidance only for explicit permission failures and preserves bounded diagnostics", () => {
    const permission = classifyRecorderSetupError(
      Object.assign(new Error("Permission denied for activeTab streamId=dummy-stream"), { name: "NotAllowedError" }),
      "get_user_media",
    );
    const unknown = classifyRecorderSetupError(
      new Error("tabCapture stream negotiation failed inside codec setup"),
      "media_recorder",
    );
    const unreadable = classifyRecorderSetupError(
      Object.assign(new Error("Could not start the captured media source"), { name: "NotReadableError" }),
      "get_user_media",
    );
    expect(permission.code).toBe("RECORDER_PERMISSION_DENIED");
    expect(permission.message).toContain("streamId=[redacted]");
    expect(unknown.code).toBe("RECORDER_SETUP_FAILED");
    expect(unreadable.code).toBe("RECORDER_STREAM_UNREADABLE");
    expect(recordingFailureFact(permission, "start", false)).toMatchObject({
      code: "TAB_CAPTURE_PERMISSION_REQUIRED",
      started: false,
    });
    const persistedUnknown = recordingFailureFact(unknown, "start", false);
    expect(persistedUnknown.code).toBe("RECORDER_SETUP_FAILED");
    expect(persistedUnknown.message).toContain("stream negotiation failed");
    expect(persistedUnknown.message).not.toContain("点击 Babel 扩展图标");
    const missingTrack = recordingFailureFact(
      { code: "PARTIAL_COVERAGE", message: "tabCapture 未取得音频轨道。" },
      "start",
      false,
    );
    expect(missingTrack.code).toBe("PARTIAL_COVERAGE");
    expect(missingTrack.message).not.toContain("点击 Babel 扩展图标");
    expect(sanitizeRecorderDiagnostic("x".repeat(2_000)).length).toBeLessThan(1_100);
  });
});
