import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import {
  ClipperError,
  createClipperService,
  deleteClipperDatabase,
  resolveOutputDirectory,
  type CaptureCreateResult,
  type CaptureDetailResult,
  type CaptureDraftUpdateResult,
  type CaptureFinalizeResult,
  type CaptureListResult,
  type ClaimBatchResult,
  type CleanupCommitResult,
  type CleanupPreviewResult,
  type CompleteJobResult,
  type CoreService,
  type DiagnosticsResult,
  type ReprocessJobResult,
  type SetCollectionResult,
  type SettingsUpdateResult,
} from "../../packages/core/src/index.js";

const profile = { profileId: "profile-test" } as const;
const services: CoreService[] = [];
const databases: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const database of databases.splice(0)) {
    await deleteClipperDatabase(database);
  }
});

function service(databaseName: string, now?: () => Date): CoreService {
  if (!databases.includes(databaseName)) databases.push(databaseName);
  const created = createClipperService({ databaseName, now });
  services.push(created);
  return created;
}

async function call<T>(
  target: CoreService,
  method: string,
  params: unknown,
): Promise<T> {
  return (await target.handle(method, params, profile)) as T;
}

async function createText(
  target: CoreService,
  requestId: string,
  exact = "A factual selection",
): Promise<CaptureCreateResult> {
  return call(target, "capture.create", {
    requestId,
    input: {
      kind: "text_selection",
      state: "sealed",
      source: {
        title: "Article",
        pageUrl: "https://example.test/article",
        site: "example.test",
      },
      selection: { type: "text", exact, prefix: "before", suffix: "after" },
      captureMethod: "selection",
      assetsState: "saved",
      integrity: { status: "complete_selection", missing: [] },
    },
  });
}

async function claim(
  target: CoreService,
  jobId: string,
  requestId: string,
  agentId = "agent-a",
): Promise<ClaimBatchResult> {
  return call(target, "job.claim", {
    requestId,
    agentId,
    jobIds: [jobId],
  });
}

function completion(jobId: string, claimToken: string, requestId: string) {
  return {
    requestId,
    jobId,
    claimToken,
    outcome: "completed",
    acquisitionMethod: "saved_text",
    requestedRanges: [],
    acquiredRanges: [],
    outputRanges: [],
    artifacts: [],
    verification: {
      level: "agent_reported",
      fileExists: true,
      warnings: [],
    },
  } as const;
}

describe("job ownership and immutable terminal history", () => {
  it("reads one job by id only inside its trusted profile", async () => {
    const target = service(`job-get-${crypto.randomUUID()}`);
    const created = await createText(target, "job-get-capture");
    const jobId = created.value.job!.jobId;
    const job = (await target.handle("job.get", { jobId }, profile)) as {
      jobId: string;
      profileId: string;
    };
    expect(job).toMatchObject({ jobId, profileId: profile.profileId });
    await expect(
      target.handle("job.get", { jobId }, { profileId: "another-profile" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("allows only one of two agents to atomically claim the same job", async () => {
    const database = `claim-race-${crypto.randomUUID()}`;
    const first = service(database);
    const second = service(database);
    const created = await createText(first, "capture-once");
    const jobId = created.value.job?.jobId;
    expect(jobId).toBeTruthy();

    const [left, right] = await Promise.all([
      claim(first, jobId!, "claim-left", "agent-left"),
      claim(second, jobId!, "claim-right", "agent-right"),
    ]);

    const dispositions = [left.items[0]?.disposition, right.items[0]?.disposition].sort();
    expect(dispositions).toEqual(["accepted", "already_claimed"]);
    const detail = await call<CaptureDetailResult>(first, "capture.get", {
      captureId: created.value.capture.captureId,
    });
    expect(detail.jobs).toHaveLength(1);
    expect(detail.jobs[0]?.status).toBe("processing");
  });

  it("reports a stale heartbeat without releasing or re-queuing the job", async () => {
    const database = `lost-agent-${crypto.randomUUID()}`;
    let clock = Date.parse("2026-09-19T00:00:00.000Z");
    const now = () => new Date(clock);
    const first = service(database, now);
    const second = service(database, now);
    const created = await createText(first, "lost-capture");
    const jobId = created.value.job!.jobId;
    expect((await claim(first, jobId, "lost-claim")).items[0]?.disposition).toBe("accepted");

    clock += 10 * 60_000;
    const diagnostics = await call<DiagnosticsResult>(second, "diagnostics.get", {});
    expect(diagnostics.staleProcessing.map((item) => item.jobId)).toContain(jobId);

    const attempted = await claim(second, jobId, "claim-after-stale", "agent-b");
    expect(attempted.items[0]?.disposition).toBe("already_claimed");
    const detail = await call<CaptureDetailResult>(second, "capture.get", {
      captureId: created.value.capture.captureId,
    });
    expect(detail.jobs[0]?.status).toBe("processing");
    expect(detail.jobs[0]?.executionState).toBe("active");
  });

  it("accepts an identical terminal retry, rejects a conflict, and reprocesses as a new job", async () => {
    const target = service(`terminal-${crypto.randomUUID()}`);
    const created = await createText(target, "terminal-capture");
    const jobId = created.value.job!.jobId;
    const claimed = await claim(target, jobId, "terminal-claim");
    const token = claimed.items[0]!.claimToken!;

    const first = await call<CompleteJobResult>(
      target,
      "job.complete",
      completion(jobId, token, "terminal-complete-1"),
    );
    const retry = await call<CompleteJobResult>(
      target,
      "job.complete",
      completion(jobId, token, "terminal-complete-2"),
    );
    expect(retry.result.resultId).toBe(first.result.resultId);

    await expect(
      call(target, "job.complete", {
        ...completion(jobId, token, "terminal-conflict"),
        verification: {
          level: "agent_reported",
          fileExists: true,
          warnings: ["different terminal payload"],
        },
      }),
    ).rejects.toMatchObject({ code: "RESULT_CONFLICT" });

    const reprocessed = await call<ReprocessJobResult>(target, "job.reprocess", {
      requestId: "terminal-reprocess",
      captureId: created.value.capture.captureId,
      parentJobId: jobId,
    });
    expect(reprocessed.value.jobId).not.toBe(jobId);
    expect(reprocessed.value.status).toBe("pending");
    const detail = await call<CaptureDetailResult>(target, "capture.get", {
      captureId: created.value.capture.captureId,
    });
    expect(detail.jobs.map((job) => job.status)).toEqual(["completed", "pending"]);
    expect(detail.results).toHaveLength(1);
    expect(detail.results[0]?.resultId).toBe(first.result.resultId);
  });

  it("stores exhausted failure as the fourth terminal state and keeps it out of ordinary pending", async () => {
    const target = service(`failed-state-${crypto.randomUUID()}`);
    const created = await createText(target, "failed-capture");
    expect(created.value.job?.status).toBe("pending");
    const jobId = created.value.job!.jobId;
    const claimed = await claim(target, jobId, "failed-claim");
    expect(claimed.items[0]?.job?.status).toBe("processing");
    const token = claimed.items[0]!.claimToken!;
    await call(target, "job.heartbeat", {
      requestId: "failed-retry-heartbeat",
      jobId,
      claimToken: token,
      retryCount: 1,
      stage: "download",
    });
    const failed = await call<CompleteJobResult>(target, "job.complete", {
      requestId: "failed-complete",
      jobId,
      claimToken: token,
      outcome: "failed",
      requestedRanges: [],
      acquiredRanges: [],
      outputRanges: [],
      artifacts: [],
      verification: { level: "agent_reported", warnings: ["network unavailable"] },
      failure: {
        code: "NETWORK_UNAVAILABLE",
        message: "Temporary network error persisted after one retry",
        stage: "download",
        retryCount: 1,
        retryable: true,
      },
    });
    expect(failed.job.status).toBe("failed");
    expect(failed.result.failure).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      retryCount: 1,
    });
    expect((await call<CaptureListResult>(target, "capture.list", {})).records).toHaveLength(0);
    expect(
      (await call<CaptureListResult>(target, "capture.list", { view: "history" })).records[0]
        ?.latestJobStatus,
    ).toBe("failed");
    expect((await claim(target, jobId, "failed-claim-again")).items[0]?.disposition).toBe(
      "not_eligible",
    );
  });
});

describe("capture idempotency, collection, and range rules", () => {
  it("deduplicates a repeated request id, conflicts on divergent replay, and allows a new identical capture", async () => {
    const target = service(`capture-idempotency-${crypto.randomUUID()}`);
    const first = await createText(target, "same-request");
    const replay = await createText(target, "same-request");
    expect(replay.value.capture.captureId).toBe(first.value.capture.captureId);

    await expect(createText(target, "same-request", "Changed under same request id")).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    const deliberateDuplicate = await createText(target, "new-request");
    expect(deliberateDuplicate.value.capture.captureId).not.toBe(first.value.capture.captureId);
    const listed = await call<CaptureListResult>(target, "capture.list", { view: "all" });
    expect(listed.records).toHaveLength(2);
  });

  it("lists and filters by the persisted source identity instead of grouping by title or site", async () => {
    const target = service(`source-key-${crypto.randomUUID()}`);
    const first = await createText(target, "source-one");
    const second = await call<CaptureCreateResult>(target, "capture.create", {
      requestId: "source-two",
      input: {
        kind: "text_selection",
        state: "sealed",
        source: {
          title: first.value.capture.source.title,
          pageUrl: "https://example.test/a-different-article",
          site: first.value.capture.source.site,
        },
        selection: { type: "text", exact: "Second article with the same title" },
        captureMethod: "selection",
        assetsState: "saved",
        integrity: { status: "complete_selection", missing: [] },
      },
    });

    const listed = await call<CaptureListResult>(target, "capture.list", { view: "all" });
    const firstRow = listed.records.find(
      (record) => record.captureId === first.value.capture.captureId,
    );
    const secondRow = listed.records.find(
      (record) => record.captureId === second.value.capture.captureId,
    );
    expect(firstRow?.sourceKey).toBe(first.value.capture.sourceKey);
    expect(secondRow?.sourceKey).toBe(second.value.capture.sourceKey);
    expect(firstRow?.sourceKey).not.toBe(secondRow?.sourceKey);

    const filtered = await call<CaptureListResult>(target, "capture.list", {
      view: "all",
      sourceKey: firstRow!.sourceKey,
    });
    expect(filtered.records.map((record) => record.captureId)).toEqual([
      first.value.capture.captureId,
    ]);
  });

  it("does not expose an ACK or persist a revision when the IndexedDB transaction aborts", async () => {
    const databaseName = `transaction-abort-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const target = createClipperService({
      databaseName,
      randomUUID: () => "fixed-id",
    });
    services.push(target);
    const first = await createText(target, "transaction-first");
    await expect(createText(target, "transaction-conflict")).rejects.toBeInstanceOf(Error);

    const listed = await call<CaptureListResult>(target, "capture.list", { view: "all" });
    expect(listed.records.map((record) => record.captureId)).toEqual([
      first.value.capture.captureId,
    ]);
    expect(listed.revision).toBe(first.ack.revision);
  });

  it("unions rewind overlap only inside one capture and keeps a second capture independent", async () => {
    const target = service(`ranges-${crypto.randomUUID()}`);
    const opened = await call<CaptureCreateResult>(target, "capture.create", {
      requestId: "range-open",
      input: {
        kind: "media_range",
        state: "open",
        source: {
          title: "Course",
          pageUrl: "https://example.test/watch/1",
          site: "example.test",
          contentId: "video-1",
          mediaDurationSeconds: 1_000,
        },
        selection: {
          type: "media",
          target: "media_object",
          timeBasis: "source_media",
          startClick: { mediaSeconds: 100, wallTime: "2026-09-19T00:00:00.000Z" },
          segments: [{ start: 100, end: 150 }],
          events: [
            {
              type: "start",
              mediaSeconds: 100,
              wallTime: "2026-09-19T00:00:00.000Z",
              playbackRate: 1,
            },
          ],
        },
        captureMethod: "html_media_position",
        assetsState: "location_only",
        integrity: { status: "needs_completion", missing: ["end_click"] },
      },
    });
    const captureId = opened.value.capture.captureId;
    const updated = await call<CaptureDraftUpdateResult>(target, "capture.updateDraft", {
      requestId: "range-update",
      captureId,
      observations: {
        segments: [{ start: 120, end: 180 }],
        events: [
          {
            type: "seek",
            mediaSeconds: 120,
            wallTime: "2026-09-19T00:00:30.000Z",
          },
        ],
      },
    });
    expect(updated.value.selection).toMatchObject({
      type: "media",
      segments: [
        { start: 100, end: 150 },
        { start: 120, end: 180 },
      ],
      normalizedSegments: [{ start: 100, end: 180 }],
    });
    const finalized = await call<CaptureFinalizeResult>(target, "capture.finalize", {
      requestId: "range-finalize",
      captureId,
      completion: {
        state: "sealed",
        endedAt: "2026-09-19T00:01:00.000Z",
        endClick: { mediaSeconds: 180, wallTime: "2026-09-19T00:01:00.000Z" },
        integrity: { status: "complete_selection", missing: [] },
      },
    });
    expect(finalized.value.capture.plannedAcquisitionRanges).toEqual([
      { start: 90, end: 190 },
    ]);
    expect(finalized.value.capture.selection).toMatchObject({
      normalizedSegments: [{ start: 100, end: 180 }],
    });

    const second = await call<CaptureCreateResult>(target, "capture.create", {
      requestId: "range-separate-capture",
      input: {
        kind: "media_range",
        state: "sealed",
        source: finalized.value.capture.source,
        selection: {
          type: "media",
          target: "media_object",
          timeBasis: "source_media",
          startClick: { mediaSeconds: 100, wallTime: "2026-09-19T01:00:00.000Z" },
          endClick: { mediaSeconds: 180, wallTime: "2026-09-19T01:01:00.000Z" },
          segments: [{ start: 100, end: 180 }],
        },
        captureMethod: "html_media_position",
        assetsState: "location_only",
        integrity: { status: "complete_selection", missing: [] },
      },
    });
    expect(second.value.capture.captureId).not.toBe(captureId);
  });

  it("re-derives original output ranges at claim without shrinking padded acquisition", async () => {
    const target = service(`claim-original-ranges-${crypto.randomUUID()}`);
    const created = await call<CaptureCreateResult>(target, "capture.create", {
      requestId: "claim-original-capture",
      input: {
        kind: "media_range",
        state: "sealed",
        source: {
          title: "Range policy fixture",
          pageUrl: "https://example.test/watch/range-policy",
          site: "example.test",
          mediaDurationSeconds: 30,
        },
        selection: {
          type: "media",
          target: "media_object",
          timeBasis: "source_media",
          startClick: { mediaSeconds: 10, wallTime: "2026-09-19T00:00:00.000Z" },
          endClick: { mediaSeconds: 12, wallTime: "2026-09-19T00:00:02.000Z" },
          segments: [{ start: 10, end: 12 }],
        },
        padding: { beforeSeconds: 2, afterSeconds: 2 },
        captureMethod: "html_media_position",
        assetsState: "location_only",
        integrity: { status: "complete_selection", missing: [] },
      },
    });
    expect(created.value.job?.executionOptions).toMatchObject({
      outputRangePolicy: "padded",
      requestedAcquisitionRanges: [{ start: 8, end: 14 }],
      requestedOutputRanges: [{ start: 8, end: 14 }],
    });

    const claimed = await call<ClaimBatchResult>(target, "job.claim", {
      requestId: "claim-original-policy",
      agentId: "range-agent",
      jobIds: [created.value.job!.jobId],
      execution: { outputRangePolicy: "original" },
    });
    expect(claimed.items[0]?.job?.executionOptions).toMatchObject({
      outputRangePolicy: "original",
      requestedAcquisitionRanges: [{ start: 8, end: 14 }],
      requestedOutputRanges: [{ start: 10, end: 12 }],
    });
    const detail = await call<CaptureDetailResult>(target, "capture.get", {
      captureId: created.value.capture.captureId,
    });
    expect(detail.capture.plannedAcquisitionRanges).toEqual([{ start: 8, end: 14 }]);
    expect(detail.capture.selection).toMatchObject({
      normalizedSegments: [{ start: 10, end: 12 }],
    });
  });

  it("replays one draft observation request without duplicating interval or event facts", async () => {
    const target = service(`draft-replay-${crypto.randomUUID()}`);
    const opened = await call<CaptureCreateResult>(target, "capture.create", {
      requestId: "draft-replay-open",
      input: {
        kind: "media_range",
        state: "open",
        source: {
          title: "Replay-safe media",
          pageUrl: "https://example.test/replay-safe",
          site: "example.test",
          mediaDurationSeconds: 120,
        },
        selection: {
          type: "media",
          target: "media_object",
          timeBasis: "source_media",
          startClick: { mediaSeconds: 10, wallTime: "2026-09-19T00:00:00.000Z" },
          segments: [{ start: 10, end: 10 }],
          events: [{ type: "start", mediaSeconds: 10, wallTime: "2026-09-19T00:00:00.000Z" }],
        },
        captureMethod: "media-timeline",
        assetsState: "location_only",
        integrity: { status: "needs_completion", missing: ["end_click"] },
      },
    });
    const captureId = opened.value.capture.captureId;
    const update = {
      requestId: "draft-observation-batch-1",
      captureId,
      observations: {
        segments: [{ start: 10, end: 20 }],
        events: [
          {
            type: "observation",
            mediaSeconds: 20,
            wallTime: "2026-09-19T00:00:10.000Z",
          },
        ],
        lastObservedMediaSeconds: 20,
      },
    } as const;

    const first = await call<CaptureDraftUpdateResult>(target, "capture.updateDraft", update);
    const replay = await call<CaptureDraftUpdateResult>(target, "capture.updateDraft", update);
    expect(replay).toEqual(first);
    expect(replay.value.selection).toMatchObject({
      segments: [
        { start: 10, end: 10 },
        { start: 10, end: 20 },
      ],
      normalizedSegments: [{ start: 10, end: 20 }],
      events: [
        { type: "start", mediaSeconds: 10 },
        { type: "observation", mediaSeconds: 20 },
      ],
      lastObservedMediaSeconds: 20,
    });
    await expect(
      call(target, "capture.updateDraft", {
        ...update,
        observations: { ...update.observations, lastObservedMediaSeconds: 21 },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const detail = await call<CaptureDetailResult>(target, "capture.get", { captureId });
    expect(detail.capture.selection).toEqual(first.value.selection);
  });

  it("keeps saved-only separate from the four job states", async () => {
    const target = service(`saved-only-${crypto.randomUUID()}`);
    const created = await createText(target, "saved-capture");
    const saved = await call<SetCollectionResult>(target, "library.setCollection", {
      requestId: "save-only",
      captureId: created.value.capture.captureId,
      collection: "saved",
    });
    expect(saved.value.collection).toBe("saved");
    expect((await call<CaptureListResult>(target, "capture.list", {})).records).toHaveLength(0);
    expect((await claim(target, created.value.job!.jobId, "saved-claim")).items[0]).toMatchObject({
      disposition: "not_eligible",
      reason: "capture_saved_only",
    });
    await call(target, "library.setCollection", {
      requestId: "restore-inbox",
      captureId: created.value.capture.captureId,
      collection: "inbox",
    });
    expect((await claim(target, created.value.job!.jobId, "restored-claim")).items[0]?.disposition).toBe(
      "accepted",
    );
  });

  it("finalizes an interrupted recording without inventing an end click and keeps its partial attachment", async () => {
    const target = service(`interrupted-recording-${crypto.randomUUID()}`);
    const opened = await call<CaptureCreateResult>(target, "capture.create", {
      requestId: "interrupted-open",
      input: {
        kind: "media_range",
        state: "open",
        source: {
          title: "Live lesson",
          pageUrl: "https://example.test/live",
          site: "example.test",
        },
        selection: {
          type: "media",
          target: "page_scene",
          timeBasis: "recording_elapsed",
          startClick: {
            mediaSeconds: 0,
            wallTime: "2026-09-19T00:00:00.000Z",
          },
          segments: [{ start: 0, end: 2 }],
          events: [
            {
              type: "start",
              mediaSeconds: 0,
              wallTime: "2026-09-19T00:00:00.000Z",
            },
          ],
        },
        captureMethod: "tab-recording",
        assetsState: "location_only",
        integrity: { status: "needs_completion", missing: ["end_click"] },
      },
    });
    const captureId = opened.value.capture.captureId;
    const attachment = await call<{ value: { attachmentId: string } }>(
      target,
      "attachment.create",
      {
        requestId: "interrupted-attachment",
        captureId,
        kind: "browser_recording",
        mimeType: "video/webm",
        storage: "chunked",
        expectedTotalBytes: 3,
      },
    );
    await call(target, "attachment.appendChunk", {
      requestId: "interrupted-chunk",
      attachmentId: attachment.value.attachmentId,
      offset: 0,
      dataBase64: "AQID",
    });
    await call(target, "attachment.complete", {
      requestId: "interrupted-attachment-complete",
      attachmentId: attachment.value.attachmentId,
      totalBytes: 3,
      interrupted: true,
    });

    await expect(
      call(target, "capture.finalize", {
        requestId: "interrupted-invalid-end",
        captureId,
        completion: {
          state: "interrupted",
          endedAt: "2026-09-19T00:00:03.000Z",
          endClick: {
            mediaSeconds: 3,
            wallTime: "2026-09-19T00:00:03.000Z",
          },
          integrity: { status: "needs_completion", missing: ["end_click"] },
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const finalized = await call<CaptureFinalizeResult>(target, "capture.finalize", {
      requestId: "interrupted-finalize",
      captureId,
      completion: {
        state: "interrupted",
        endedAt: "2026-09-19T00:00:03.000Z",
        observations: {
          segments: [{ start: 2, end: 3 }],
          events: [
            {
              type: "interrupted",
              mediaSeconds: 3,
              wallTime: "2026-09-19T00:00:03.000Z",
            },
          ],
          lastObservedMediaSeconds: 3,
          attachmentIds: [attachment.value.attachmentId],
        },
        assetsState: "partial_saved",
        integrity: { status: "needs_completion", missing: ["end_click"] },
      },
    });
    expect(finalized.value.job).toBeUndefined();
    expect(finalized.value.capture).toMatchObject({
      state: "interrupted",
      assetsState: "partial_saved",
      attachmentIds: [attachment.value.attachmentId],
      interruptedAt: "2026-09-19T00:00:03.000Z",
    });
    expect(finalized.value.capture.selection).not.toHaveProperty("endClick");
    const detail = await call<CaptureDetailResult>(target, "capture.get", { captureId });
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]).toMatchObject({
      attachmentId: attachment.value.attachmentId,
      status: "interrupted",
      byteLength: 3,
    });
  });
});

describe("cleanup and output directory safety", () => {
  it("invalidates a cleanup preview when a new reprocess job appears", async () => {
    const target = service(`cleanup-race-${crypto.randomUUID()}`);
    const created = await createText(target, "cleanup-capture");
    const jobId = created.value.job!.jobId;
    const claimed = await claim(target, jobId, "cleanup-claim");
    await call(target, "job.complete", completion(jobId, claimed.items[0]!.claimToken!, "cleanup-complete"));
    const preview = await call<CleanupPreviewResult>(target, "library.cleanupPreview", {
      requestId: "cleanup-preview",
      scope: "capture_ids",
      captureIds: [created.value.capture.captureId],
    });
    expect(preview.candidates).toHaveLength(1);
    await call(target, "job.reprocess", {
      requestId: "cleanup-new-job",
      captureId: created.value.capture.captureId,
      parentJobId: jobId,
    });
    await expect(
      call(target, "library.cleanupCommit", {
        requestId: "cleanup-commit",
        cleanupToken: preview.cleanupToken,
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_CONFLICT" });
    expect(
      (await call<CaptureDetailResult>(target, "capture.get", {
        captureId: created.value.capture.captureId,
      })).jobs,
    ).toHaveLength(2);
  });

  it("deletes a stable terminal history while explicitly preserving external files", async () => {
    const target = service(`cleanup-success-${crypto.randomUUID()}`);
    const created = await createText(target, "cleanup-stable");
    const jobId = created.value.job!.jobId;
    const claimed = await claim(target, jobId, "cleanup-stable-claim");
    await call(
      target,
      "job.complete",
      completion(jobId, claimed.items[0]!.claimToken!, "cleanup-stable-complete"),
    );
    const preview = await call<CleanupPreviewResult>(target, "library.cleanupPreview", {
      requestId: "cleanup-stable-preview",
      scope: "all_processed",
    });
    const committed = await call<CleanupCommitResult>(target, "library.cleanupCommit", {
      requestId: "cleanup-stable-commit",
      cleanupToken: preview.cleanupToken,
    });
    expect(committed.deletedCaptureIds).toEqual([created.value.capture.captureId]);
    expect(committed.externalFilesPreserved).toBe(true);
    await expect(
      call(target, "capture.get", { captureId: created.value.capture.captureId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(
        target,
        "job.complete",
        completion(jobId, claimed.items[0]!.claimToken!, "cleanup-stable-complete"),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const recreated = await createText(target, "cleanup-stable");
    expect(recreated.value.capture.captureId).not.toBe(created.value.capture.captureId);
  });

  it("rejects a cleanup token at its expiry boundary and leaves history intact", async () => {
    let clock = Date.parse("2026-09-19T00:00:00.000Z");
    const target = service(`cleanup-expiry-${crypto.randomUUID()}`, () => new Date(clock));
    const created = await createText(target, "cleanup-expiry-capture");
    const jobId = created.value.job!.jobId;
    const claimed = await claim(target, jobId, "cleanup-expiry-claim");
    await call(
      target,
      "job.complete",
      completion(jobId, claimed.items[0]!.claimToken!, "cleanup-expiry-complete"),
    );
    const preview = await call<CleanupPreviewResult>(target, "library.cleanupPreview", {
      requestId: "cleanup-expiry-preview",
      scope: "capture_ids",
      captureIds: [created.value.capture.captureId],
    });
    clock += 15 * 60_000;
    await expect(
      call(target, "library.cleanupCommit", {
        requestId: "cleanup-expiry-commit",
        cleanupToken: preview.cleanupToken,
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_TOKEN_EXPIRED" });
    expect(
      (await call<CaptureDetailResult>(target, "capture.get", {
        captureId: created.value.capture.captureId,
      })).capture.captureId,
    ).toBe(created.value.capture.captureId);
  });

  it("resolves task, connection, and global directories in that order", async () => {
    expect(
      resolveOutputDirectory({ task: "/task", connection: "/connection", global: "/global" }),
    ).toEqual({ path: "/task", source: "task" });
    expect(resolveOutputDirectory({ connection: "/connection", global: "/global" })).toEqual({
      path: "/connection",
      source: "connection",
    });
    expect(resolveOutputDirectory({ global: "/global" })).toEqual({
      path: "/global",
      source: "global",
    });

    const target = service(`directory-${crypto.randomUUID()}`);
    const settings = await call<SettingsUpdateResult>(target, "settings.update", {
      requestId: "directory-setting",
      patch: { globalOutputDirectory: "/global-v1" },
    });
    expect(settings.value.globalOutputDirectory).toBe("/global-v1");
    const globalCapture = await createText(target, "directory-global-capture");
    const globalClaim = await claim(
      target,
      globalCapture.value.job!.jobId,
      "directory-global-claim",
    );
    expect(globalClaim.items[0]?.job?.directory).toEqual({ path: "/global-v1", source: "global" });

    const created = await createText(target, "directory-task-capture");
    const claimed = (await target.handle(
      "job.claim",
      {
        requestId: "directory-claim",
        agentId: "agent",
        jobIds: [created.value.job!.jobId],
        taskOutputDirectory: "/task",
      },
      { ...profile, connectionOutputDirectory: "/connection" },
    )) as ClaimBatchResult;
    expect(claimed.items[0]?.job?.directory).toEqual({ path: "/task", source: "task" });

    await call<SettingsUpdateResult>(target, "settings.update", {
      requestId: "directory-setting-change",
      patch: { globalOutputDirectory: "/global-v2" },
    });
    const persistedGlobal = await call<{ directory: { path?: string; source: string } }>(
      target,
      "job.get",
      { jobId: globalCapture.value.job!.jobId },
    );
    const persistedTask = await call<{ directory: { path?: string; source: string } }>(
      target,
      "job.get",
      { jobId: created.value.job!.jobId },
    );
    expect(persistedGlobal.directory).toEqual({ path: "/global-v1", source: "global" });
    expect(persistedTask.directory).toEqual({ path: "/task", source: "task" });

    const nextCapture = await createText(target, "directory-next-capture");
    const nextClaim = await claim(target, nextCapture.value.job!.jobId, "directory-next-claim");
    expect(nextClaim.items[0]?.job?.directory).toEqual({ path: "/global-v2", source: "global" });
  });
});
