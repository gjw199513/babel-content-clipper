import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import { reconcileMediaSegments } from "../../apps/extension/src/media-observation-policy.js";
import {
  createClipperService,
  deleteClipperDatabase,
  type AttachmentMutationResult,
  type CaptureCreateResult,
  type CaptureDetailResult,
  type CaptureFinalizeResult,
  type CoreService,
} from "../../packages/core/src/index.js";

const profile = { profileId: "profile-tail-boundary" } as const;
const services: CoreService[] = [];
const databases: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const database of databases.splice(0)) await deleteClipperDatabase(database);
});

function service(databaseName: string): CoreService {
  databases.push(databaseName);
  const created = createClipperService({ databaseName });
  services.push(created);
  return created;
}

async function call<T>(target: CoreService, method: string, params: unknown): Promise<T> {
  return (await target.handle(method, params, profile)) as T;
}

describe("media end boundary and recording tail", () => {
  it("keeps post-roll observation out of the selected source ranges", async () => {
    const target = service(`media-tail-boundary-${crypto.randomUUID()}`);
    await call(target, "settings.update", {
      requestId: "tail-padding-settings",
      patch: { paddingBeforeSeconds: 2, paddingAfterSeconds: 2 },
    });
    const mediaSource = "https://media.example/lesson.webm";
    const opened = await call<CaptureCreateResult>(target, "capture.create", {
      requestId: "tail-capture-open",
      input: {
        kind: "media_range",
        state: "open",
        source: {
          title: "Tail boundary lesson",
          pageUrl: "https://media.example/lesson",
          site: "media.example",
          mediaDurationSeconds: 30,
        },
        selection: {
          type: "media",
          target: "media_object",
          timeBasis: "source_media",
          startClick: { mediaSeconds: 2, wallTime: "2026-09-19T11:32:35.611Z" },
          segments: [{ start: 2, end: 2 }],
          events: [{
            type: "start",
            mediaSeconds: 2,
            wallTime: "2026-09-19T11:32:35.611Z",
          }],
          lastObservedMediaSeconds: 2,
        },
        captureMethod: "media-timeline",
        assetsState: "location_only",
        integrity: { status: "needs_completion", missing: ["end_click"] },
      },
    });
    const captureId = opened.value.capture.captureId;

    const startedSegments = [{ start: 2, end: 2, source: mediaSource }];
    const marked = reconcileMediaSegments(
      startedSegments,
      [{ start: 2, end: 5.364528, source: mediaSource }],
      false,
    );
    expect(marked.delta).toEqual([{ start: 2, end: 5.364528 }]);
    await call(target, "capture.updateDraft", {
      requestId: "tail-mark-end-observations",
      captureId,
      observations: {
        segments: marked.delta,
        events: [{
          type: "end",
          mediaSeconds: 5.364528,
          wallTime: "2026-09-19T11:32:40.052Z",
        }],
        lastObservedMediaSeconds: 5.364528,
      },
    });

    const tail = reconcileMediaSegments(
      marked.segments,
      [{ start: 2, end: 7.422781, source: mediaSource }],
      true,
    );
    expect(tail).toEqual({
      segments: [{ start: 2, end: 5.364528, source: mediaSource }],
      delta: [],
    });
    await call(target, "capture.updateDraft", {
      requestId: "tail-coverage-only-observation",
      captureId,
      observations: {
        segments: tail.delta,
        events: [{
          type: "observation",
          mediaSeconds: 7.422781,
          wallTime: "2026-09-19T11:32:42.109Z",
        }],
        lastObservedMediaSeconds: 7.422781,
      },
    });

    const attachment = await call<AttachmentMutationResult>(target, "attachment.create", {
      requestId: "tail-recording-create",
      captureId,
      kind: "browser_recording",
      mimeType: "video/webm",
      storage: "chunked",
    });
    await call(target, "attachment.appendChunk", {
      requestId: "tail-recording-chunk",
      attachmentId: attachment.value.attachmentId,
      offset: 0,
      dataBase64: "AA==",
    });
    const recordingCoverage = {
      timeBasis: "recording_elapsed",
      recordingStartedAt: "2026-09-19T11:32:35.637Z",
      recordingStoppedAt: "2026-09-19T11:32:42.112Z",
      elapsedSeconds: 6.475,
      requestedPreRollSeconds: 2,
      actualPreRollSeconds: 0,
      requestedPostRollSeconds: 2,
      actualPostRollRecordingSeconds: 2.047,
      observedPostRollMediaSeconds: 2.05684,
      postRollComplete: true,
      stopReason: "requested",
      hasAudio: true,
      hasVideo: true,
      audioMonitor: true,
    } as const;
    await call(target, "attachment.complete", {
      requestId: "tail-recording-complete",
      attachmentId: attachment.value.attachmentId,
      totalBytes: 1,
      interrupted: false,
      recordingCoverage,
    });

    const finalized = await call<CaptureFinalizeResult>(target, "capture.finalize", {
      requestId: "tail-capture-finalize",
      captureId,
      completion: {
        state: "sealed",
        endedAt: "2026-09-19T11:32:40.052Z",
        endClick: {
          mediaSeconds: 5.364528,
          wallTime: "2026-09-19T11:32:40.052Z",
        },
        observations: {
          segments: reconcileMediaSegments(
            tail.segments,
            [{ start: 2, end: 7.422781, source: mediaSource }],
            true,
          ).delta,
          lastObservedMediaSeconds: 7.422781,
          attachmentIds: [attachment.value.attachmentId],
        },
        assetsState: "saved",
        integrity: { status: "complete_selection", missing: [] },
      },
    });

    expect(finalized.value.capture.selection).toMatchObject({
      endClick: { mediaSeconds: 5.364528 },
      normalizedSegments: [{ start: 2, end: 5.364528 }],
      lastObservedMediaSeconds: 7.422781,
    });
    expect(finalized.value.capture.plannedAcquisitionRanges).toEqual([
      { start: 0, end: 7.364528 },
    ]);
    expect(finalized.value.job?.executionOptions.requestedAcquisitionRanges).toEqual([
      { start: 0, end: 7.364528 },
    ]);

    const detail = await call<CaptureDetailResult>(target, "capture.get", { captureId });
    expect(detail.attachments[0]?.recordingCoverage).toEqual(recordingCoverage);
    expect(detail.capture.selection.type === "media" && detail.capture.selection.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "end", mediaSeconds: 5.364528 }),
        expect.objectContaining({ type: "observation", mediaSeconds: 7.422781 }),
      ]),
    );
  });
});
