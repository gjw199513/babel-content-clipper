import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import {
  createClipperService,
  deleteClipperDatabase,
  type AttachmentGetResult,
  type AttachmentMutationResult,
  type BackupBundle,
  type BackupImportResult,
  type CaptureCreateResult,
  type CaptureListResult,
  type CoreService,
  type DiagnosticsResult,
} from "../../packages/core/src/index.js";
import { openClipperDatabase } from "../../packages/core/src/database.js";

const profile = { profileId: "profile-assets" } as const;
const services: CoreService[] = [];
const databases: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const database of databases.splice(0)) await deleteClipperDatabase(database);
});

function service(databaseName: string): CoreService {
  if (!databases.includes(databaseName)) databases.push(databaseName);
  const created = createClipperService({ databaseName });
  services.push(created);
  return created;
}

async function call<T>(target: CoreService, method: string, params: unknown): Promise<T> {
  return callAs(target, method, params, profile.profileId);
}

async function callAs<T>(
  target: CoreService,
  method: string,
  params: unknown,
  profileId: string,
): Promise<T> {
  return (await target.handle(method, params, { profileId })) as T;
}

async function createText(target: CoreService, requestId: string): Promise<CaptureCreateResult> {
  return call(target, "capture.create", {
    requestId,
    input: {
      kind: "text_selection",
      state: "sealed",
      source: {
        title: "Backup fixture",
        pageUrl: "https://example.test/backup",
        site: "example.test",
      },
      selection: { type: "text", exact: "Keep the original factual text." },
      captureMethod: "selection",
      assetsState: "saved",
      integrity: { status: "complete_selection", missing: [] },
    },
  });
}

describe("bounded streaming attachments", () => {
  it("persists a diagnostic when browser recording never started", async () => {
    const databaseName = `recording-start-failure-${crypto.randomUUID()}`;
    const target = service(databaseName);
    const created = await call<AttachmentMutationResult>(target, "attachment.create", {
      requestId: "start-failure-create",
      kind: "browser_recording",
      mimeType: "video/webm",
      storage: "chunked",
    });
    const recordingFailure = {
      code: "TAB_CAPTURE_PERMISSION_REQUIRED",
      message: "请先在目标页面点击 Babel 扩展图标重新授予当前标签页访问权限。",
      stage: "start",
      started: false,
    } as const;
    const completed = await call<AttachmentMutationResult>(target, "attachment.complete", {
      requestId: "start-failure-complete",
      attachmentId: created.value.attachmentId,
      totalBytes: 0,
      interrupted: true,
      recordingFailure,
    });
    expect(completed.value).toMatchObject({
      status: "interrupted",
      byteLength: 0,
      dataAvailable: false,
      recordingFailure,
    });
    expect(completed.value.recordingCoverage).toBeUndefined();

    const replay = await call<AttachmentMutationResult>(target, "attachment.complete", {
      requestId: "start-failure-complete-retry",
      attachmentId: created.value.attachmentId,
      totalBytes: 0,
      interrupted: true,
      recordingFailure,
    });
    expect(replay.value.dataAvailable).toBe(false);

    // Recreate the persisted shape produced by older builds. Public reads and
    // exports must still derive unavailability from the immutable failure facts.
    const legacyDatabase = await openClipperDatabase(databaseName);
    const legacyAttachment = await legacyDatabase.get(
      "attachments",
      created.value.attachmentId,
    );
    expect(legacyAttachment).toBeDefined();
    await legacyDatabase.put("attachments", {
      ...legacyAttachment!,
      dataAvailable: true,
    });
    legacyDatabase.close();

    const read = await call<AttachmentGetResult>(target, "attachment.get", {
      attachmentId: created.value.attachmentId,
      encoding: "metadata",
      maxBytes: 1,
    });
    expect(read.attachment).toMatchObject({ dataAvailable: false, recordingFailure });
    await expect(call(target, "attachment.get", {
      attachmentId: created.value.attachmentId,
      encoding: "base64",
    })).rejects.toMatchObject({
      code: "ASSET_UNAVAILABLE",
      details: {
        reason: "recording_never_started",
        failureCode: "TAB_CAPTURE_PERMISSION_REQUIRED",
      },
    });

    const bundle = await call<BackupBundle>(target, "backup.export", { includeAttachmentData: true });
    expect(bundle).toMatchObject({
      attachmentDataIncluded: true,
      attachments: [{ dataAvailable: false, recordingFailure }],
      attachmentChunks: [],
    });
    const restored = service(`recording-start-failure-restored-${crypto.randomUUID()}`);
    await callAs<BackupImportResult>(restored, "backup.import", {
      requestId: "start-failure-import",
      bundle,
      conflictStrategy: "fail",
    }, "profile-start-failure-restored");
    const restoredAttachment = await callAs<AttachmentGetResult>(restored, "attachment.get", {
      attachmentId: created.value.attachmentId,
      encoding: "metadata",
      maxBytes: 1,
    }, "profile-start-failure-restored");
    expect(restoredAttachment.attachment).toMatchObject({
      dataAvailable: false,
      recordingFailure,
    });
    await expect(callAs(restored, "attachment.get", {
      attachmentId: created.value.attachmentId,
      encoding: "base64",
    }, "profile-start-failure-restored")).rejects.toMatchObject({
      code: "ASSET_UNAVAILABLE",
      details: { reason: "recording_never_started" },
    });

    await expect(call(target, "attachment.complete", {
      requestId: "start-failure-conflict",
      attachmentId: created.value.attachmentId,
      totalBytes: 0,
      interrupted: true,
      recordingFailure: { ...recordingFailure, code: "DIFFERENT_FAILURE" },
    })).rejects.toMatchObject({ code: "ATTACHMENT_CONFLICT" });
  });

  it("treats legacy diagnostic-free and started-but-empty terminal recordings as unavailable", async () => {
    const databaseName = `empty-terminal-recordings-${crypto.randomUUID()}`;
    const target = service(databaseName);
    const legacy = await call<AttachmentMutationResult>(target, "attachment.create", {
      requestId: "legacy-empty-create",
      kind: "browser_recording",
      mimeType: "video/webm",
      storage: "chunked",
    });
    const whileWriting = await call<AttachmentGetResult>(target, "attachment.get", {
      attachmentId: legacy.value.attachmentId,
      encoding: "base64",
    });
    expect(whileWriting).toMatchObject({
      dataBase64: "",
      returnedBytes: 0,
      eof: false,
      attachment: { status: "writing", dataAvailable: true },
    });

    const legacyCompleted = await call<AttachmentMutationResult>(
      target,
      "attachment.complete",
      {
        requestId: "legacy-empty-complete",
        attachmentId: legacy.value.attachmentId,
        totalBytes: 0,
        interrupted: true,
      },
    );
    expect(legacyCompleted.value).toMatchObject({
      status: "interrupted",
      byteLength: 0,
      dataAvailable: false,
    });
    expect(legacyCompleted.value.recordingFailure).toBeUndefined();

    // Older builds persisted true for this exact no-diagnostic terminal shape.
    const legacyDatabase = await openClipperDatabase(databaseName);
    await legacyDatabase.put("attachments", {
      ...legacyCompleted.value,
      dataAvailable: true,
    });
    legacyDatabase.close();
    const legacyMetadata = await call<AttachmentGetResult>(target, "attachment.get", {
      attachmentId: legacy.value.attachmentId,
      encoding: "metadata",
    });
    expect(legacyMetadata.attachment).toMatchObject({
      status: "interrupted",
      byteLength: 0,
      dataAvailable: false,
    });
    expect(legacyMetadata.attachment.recordingFailure).toBeUndefined();
    const legacyReadError = await call(target, "attachment.get", {
      attachmentId: legacy.value.attachmentId,
      encoding: "base64",
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(legacyReadError).toMatchObject({
      code: "ASSET_UNAVAILABLE",
      details: { reason: "empty_recording" },
    });
    expect(
      (legacyReadError as { details: Readonly<Record<string, unknown>> }).details,
    ).not.toHaveProperty("failureCode");

    const started = await call<AttachmentMutationResult>(target, "attachment.create", {
      requestId: "started-empty-create",
      kind: "browser_recording",
      mimeType: "video/webm",
      storage: "chunked",
    });
    const startedFailure = {
      code: "RECORDER_STOPPED_BEFORE_FIRST_CHUNK",
      message: "The recorder stopped before its first chunk was persisted.",
      stage: "stop",
      started: true,
    } as const;
    const startedCompleted = await call<AttachmentMutationResult>(
      target,
      "attachment.complete",
      {
        requestId: "started-empty-complete",
        attachmentId: started.value.attachmentId,
        totalBytes: 0,
        interrupted: true,
        recordingFailure: startedFailure,
      },
    );
    expect(startedCompleted.value).toMatchObject({
      status: "interrupted",
      byteLength: 0,
      dataAvailable: false,
      recordingFailure: startedFailure,
    });
    await expect(call(target, "attachment.get", {
      attachmentId: started.value.attachmentId,
      encoding: "base64",
    })).rejects.toMatchObject({
      code: "ASSET_UNAVAILABLE",
      details: { reason: "empty_recording" },
    });

    const bundle = await call<BackupBundle>(target, "backup.export", {
      includeAttachmentData: true,
    });
    expect(bundle.attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attachmentId: legacy.value.attachmentId,
        dataAvailable: false,
      }),
      expect.objectContaining({
        attachmentId: started.value.attachmentId,
        dataAvailable: false,
      }),
    ]));
    expect(bundle.attachmentChunks).toEqual([]);
  });

  it("persists measured recording coverage and never overwrites terminal facts", async () => {
    const target = service(`recording-coverage-${crypto.randomUUID()}`);
    const created = await call<AttachmentMutationResult>(target, "attachment.create", {
      requestId: "coverage-create",
      kind: "browser_recording",
      mimeType: "video/webm",
      storage: "chunked",
    });
    const coverage = {
      timeBasis: "recording_elapsed",
      recordingStartedAt: "2026-09-19T01:00:00.000Z",
      recordingStoppedAt: "2026-09-19T01:00:08.000Z",
      elapsedSeconds: 8,
      requestedPreRollSeconds: 3,
      actualPreRollSeconds: 0,
      requestedPostRollSeconds: 5,
      actualPostRollRecordingSeconds: 5,
      observedPostRollMediaSeconds: 4.8,
      postRollComplete: true,
      stopReason: "requested",
      hasAudio: true,
      hasVideo: true,
      audioMonitor: true,
    } as const;
    const completed = await call<AttachmentMutationResult>(target, "attachment.complete", {
      requestId: "coverage-complete",
      attachmentId: created.value.attachmentId,
      totalBytes: 0,
      interrupted: false,
      recordingCoverage: coverage,
    });
    expect(completed.value.recordingCoverage).toEqual(coverage);

    const replay = await call<AttachmentMutationResult>(target, "attachment.complete", {
      requestId: "coverage-complete-retry",
      attachmentId: created.value.attachmentId,
      totalBytes: 0,
      interrupted: false,
      recordingCoverage: coverage,
    });
    expect(replay.value.recordingCoverage).toEqual(coverage);

    const bundle = await call<BackupBundle>(target, "backup.export", { includeAttachmentData: false });
    const restored = service(`recording-coverage-restored-${crypto.randomUUID()}`);
    await callAs<BackupImportResult>(restored, "backup.import", {
      requestId: "coverage-import",
      bundle,
      conflictStrategy: "fail",
    }, "profile-coverage-restored");
    const restoredAttachment = await callAs<AttachmentGetResult>(restored, "attachment.get", {
      attachmentId: created.value.attachmentId,
      encoding: "metadata",
      maxBytes: 1,
    }, "profile-coverage-restored");
    expect(restoredAttachment.attachment.recordingCoverage).toEqual(coverage);

    await expect(call(target, "attachment.complete", {
      requestId: "coverage-conflict",
      attachmentId: created.value.attachmentId,
      totalBytes: 0,
      interrupted: false,
      recordingCoverage: { ...coverage, postRollComplete: false },
    })).rejects.toMatchObject({ code: "ATTACHMENT_CONFLICT" });
  });

  it("appends sequential chunks idempotently, reads bounded slices, and preserves bytes at budget stop", async () => {
    const target = service(`chunks-${crypto.randomUUID()}`);
    await call(target, "settings.update", {
      requestId: "small-budget",
      patch: {
        maxRecordingSeconds: 60,
        maxRecordingBytes: 3,
        maxAttachmentBytes: 10,
      },
    });
    const created = await call<AttachmentMutationResult>(target, "attachment.create", {
      requestId: "asset-create",
      kind: "browser_recording",
      mimeType: "video/webm",
      storage: "chunked",
    });
    const attachmentId = created.value.attachmentId;
    const first = await call<AttachmentMutationResult>(target, "attachment.appendChunk", {
      requestId: "asset-chunk-1",
      attachmentId,
      offset: 0,
      dataBase64: "AQID",
    });
    expect(first.value.byteLength).toBe(3);

    const duplicate = await call<AttachmentMutationResult>(target, "attachment.appendChunk", {
      requestId: "asset-chunk-duplicate",
      attachmentId,
      offset: 0,
      dataBase64: "AQID",
    });
    expect(duplicate.value.byteLength).toBe(3);
    await expect(
      call(target, "attachment.appendChunk", {
        requestId: "asset-chunk-conflict",
        attachmentId,
        offset: 0,
        dataBase64: "BAUG",
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_CONFLICT" });
    await expect(
      call(target, "attachment.appendChunk", {
        requestId: "asset-over-budget",
        attachmentId,
        offset: 3,
        dataBase64: "BA==",
      }),
    ).rejects.toMatchObject({ code: "STORAGE_BUDGET_EXCEEDED" });

    const head = await call<AttachmentGetResult>(target, "attachment.get", {
      attachmentId,
      offset: 0,
      maxBytes: 2,
      encoding: "base64",
    });
    const tail = await call<AttachmentGetResult>(target, "attachment.get", {
      attachmentId,
      offset: 2,
      maxBytes: 2,
      encoding: "base64",
    });
    expect(head).toMatchObject({ dataBase64: "AQI=", returnedBytes: 2, eof: false });
    expect(tail).toMatchObject({ dataBase64: "Aw==", returnedBytes: 1, eof: false });

    const completed = await call<AttachmentMutationResult>(target, "attachment.complete", {
      requestId: "asset-interrupted",
      attachmentId,
      totalBytes: 3,
      interrupted: true,
      recordingFailure: {
        code: "RECORDER_CHUNK_FAILED",
        message: "A later recorder chunk could not be persisted.",
        stage: "chunk",
        started: true,
      },
    });
    expect(completed.value).toMatchObject({
      status: "interrupted",
      byteLength: 3,
      dataAvailable: true,
      recordingFailure: { started: true },
    });
    const persistedPartial = await call<AttachmentGetResult>(target, "attachment.get", {
      attachmentId,
      offset: 0,
      maxBytes: 3,
      encoding: "base64",
    });
    expect(persistedPartial).toMatchObject({ dataBase64: "AQID", returnedBytes: 3 });
    const finalTail = await call<AttachmentGetResult>(target, "attachment.get", {
      attachmentId,
      offset: 3,
      maxBytes: 1,
    });
    expect(finalTail.eof).toBe(true);
    const partialBackup = await call<BackupBundle>(target, "backup.export", {
      includeAttachmentData: true,
    });
    expect(partialBackup.attachments[0]).toMatchObject({
      byteLength: 3,
      dataAvailable: true,
      recordingFailure: { started: true },
    });
    expect(partialBackup.attachmentChunks).toEqual([
      { attachmentId, offset: 0, dataBase64: "AQID" },
    ]);
    const diagnostics = await call<DiagnosticsResult>(target, "diagnostics.get", {});
    expect(diagnostics.counts.internalAttachmentBytes).toBe(3);
    expect(diagnostics.budgets).toMatchObject({
      maxRecordingSeconds: 60,
      maxRecordingBytes: 3,
      maxAttachmentBytes: 10,
      defaultsAreUnvalidated: true,
    });
  });

  it("reads a small window across chunk boundaries without requiring a whole attachment read", async () => {
    const target = service(`chunk-window-${crypto.randomUUID()}`);
    const created = await call<AttachmentMutationResult>(target, "attachment.create", {
      requestId: "window-create",
      kind: "text",
      mimeType: "application/octet-stream",
      storage: "chunked",
      expectedTotalBytes: 6,
    });
    const attachmentId = created.value.attachmentId;
    await call(target, "attachment.appendChunk", {
      requestId: "window-first",
      attachmentId,
      offset: 0,
      dataBase64: "AQID",
    });
    await call(target, "attachment.appendChunk", {
      requestId: "window-second",
      attachmentId,
      offset: 3,
      dataBase64: "BAUG",
    });
    await call(target, "attachment.complete", {
      requestId: "window-complete",
      attachmentId,
      totalBytes: 6,
      interrupted: false,
    });
    const window = await call<AttachmentGetResult>(target, "attachment.get", {
      attachmentId,
      offset: 2,
      maxBytes: 3,
    });
    expect(window).toMatchObject({
      offset: 2,
      returnedBytes: 3,
      totalBytes: 6,
      eof: false,
      dataBase64: "AwQF",
    });
  });

  it("keeps a valid zero-byte text attachment readable", async () => {
    const target = service(`zero-byte-text-${crypto.randomUUID()}`);
    const created = await call<AttachmentMutationResult>(target, "attachment.create", {
      requestId: "zero-text-create",
      kind: "text",
      mimeType: "text/plain",
      storage: "chunked",
      expectedTotalBytes: 0,
    });
    const completed = await call<AttachmentMutationResult>(target, "attachment.complete", {
      requestId: "zero-text-complete",
      attachmentId: created.value.attachmentId,
      totalBytes: 0,
      interrupted: false,
    });
    expect(completed.value).toMatchObject({
      kind: "text",
      status: "complete",
      byteLength: 0,
      dataAvailable: true,
    });
    const bytes = await call<AttachmentGetResult>(target, "attachment.get", {
      attachmentId: created.value.attachmentId,
      encoding: "base64",
    });
    expect(bytes).toMatchObject({
      dataBase64: "",
      returnedBytes: 0,
      totalBytes: 0,
      eof: true,
    });
  });
});

describe("backup import, export, and schema migration boundary", () => {
  it("restores all records into the explicitly selected new profile", async () => {
    const sourceProfileId = "profile-backup-source";
    const restoredProfileId = "profile-backup-restored";
    const source = service(`backup-new-profile-source-${crypto.randomUUID()}`);
    const created = await callAs<CaptureCreateResult>(
      source,
      "capture.create",
      {
        requestId: "new-profile-capture",
        input: {
          kind: "text_selection",
          state: "sealed",
          source: {
            title: "Portable record",
            pageUrl: "https://example.test/portable",
            site: "example.test",
          },
          selection: { type: "text", exact: "Restore me into another profile." },
          captureMethod: "selection",
          assetsState: "saved",
          integrity: { status: "complete_selection", missing: [] },
        },
      },
      sourceProfileId,
    );
    const bundle = await callAs<BackupBundle>(
      source,
      "backup.export",
      {},
      sourceProfileId,
    );
    expect(bundle.profileId).toBe(sourceProfileId);

    const destination = service(`backup-new-profile-destination-${crypto.randomUUID()}`);
    await callAs<BackupImportResult>(
      destination,
      "backup.import",
      { requestId: "new-profile-import", bundle, conflictStrategy: "fail" },
      restoredProfileId,
    );
    const listed = await callAs<CaptureListResult>(
      destination,
      "capture.list",
      { view: "all" },
      restoredProfileId,
    );
    expect(listed.profileId).toBe(restoredProfileId);
    expect(listed.records.map((record) => record.captureId)).toEqual([
      created.value.capture.captureId,
    ]);
    const detail = await callAs<{
      capture: { profileId: string };
      jobs: Array<{ profileId: string }>;
    }>(
      destination,
      "capture.get",
      { captureId: created.value.capture.captureId },
      restoredProfileId,
    );
    expect(detail.capture.profileId).toBe(restoredProfileId);
    expect(detail.jobs.every((job) => job.profileId === restoredProfileId)).toBe(true);
    expect(
      (await callAs<{ profileId: string }>(destination, "settings.get", {}, restoredProfileId))
        .profileId,
    ).toBe(restoredProfileId);
    expect(
      (await callAs<CaptureListResult>(destination, "capture.list", { view: "all" }, sourceProfileId))
        .records,
    ).toHaveLength(0);
  });

  it("round-trips relations and attachment bytes, skips identical replay, and rejects divergent ids", async () => {
    const source = service(`backup-source-${crypto.randomUUID()}`);
    const capture = await createText(source, "backup-capture");
    const attachment = await call<AttachmentMutationResult>(source, "attachment.create", {
      requestId: "backup-asset",
      captureId: capture.value.capture.captureId,
      kind: "text",
      mimeType: "text/plain",
      storage: "chunked",
      expectedTotalBytes: 3,
    });
    await call(source, "attachment.appendChunk", {
      requestId: "backup-chunk",
      attachmentId: attachment.value.attachmentId,
      offset: 0,
      dataBase64: "YWJj",
    });
    await call(source, "attachment.complete", {
      requestId: "backup-asset-complete",
      attachmentId: attachment.value.attachmentId,
      totalBytes: 3,
      interrupted: false,
    });
    const bundle = await call<BackupBundle>(source, "backup.export", {
      includeAttachmentData: true,
    });

    const destination = service(`backup-destination-${crypto.randomUUID()}`);
    const imported = await call<BackupImportResult>(destination, "backup.import", {
      requestId: "backup-import",
      bundle,
      conflictStrategy: "fail",
    });
    expect(imported.imported).toMatchObject({ captures: 1, jobs: 1, attachments: 1, chunks: 1 });
    expect((await call<CaptureListResult>(destination, "capture.list", { view: "all" })).records).toHaveLength(1);
    const bytes = await call<AttachmentGetResult>(destination, "attachment.get", {
      attachmentId: attachment.value.attachmentId,
    });
    expect(bytes.dataBase64).toBe("YWJj");

    const replay = await call<BackupImportResult>(destination, "backup.import", {
      requestId: "backup-import-again",
      bundle,
      conflictStrategy: "skip_identical",
    });
    expect(replay.imported).toEqual({
      captures: 0,
      jobs: 0,
      results: 0,
      events: 0,
      attachments: 0,
      chunks: 0,
    });
    expect(replay.skippedIdentical).toBeGreaterThan(0);

    const divergent = structuredClone(bundle) as unknown as {
      captures: Array<{ source: { title: string } }>;
    };
    divergent.captures[0]!.source.title = "Different content under same id";
    await expect(
      call(destination, "backup.import", {
        requestId: "backup-import-conflict",
        bundle: divergent,
        conflictStrategy: "skip_identical",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
  });

  it("fails closed for an unknown backup schema instead of clearing the database", async () => {
    const target = service(`backup-version-${crypto.randomUUID()}`);
    await createText(target, "version-existing");
    const bundle = await call<BackupBundle>(target, "backup.export", {});
    await expect(
      call(target, "backup.import", {
        requestId: "future-import",
        bundle: { ...bundle, schemaVersion: "99.0" },
        conflictStrategy: "fail",
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_UNSUPPORTED" });
    expect((await call<CaptureListResult>(target, "capture.list", { view: "all" })).records).toHaveLength(1);
  });

  it("marks bytes unavailable when importing a metadata-only backup", async () => {
    const source = service(`backup-metadata-source-${crypto.randomUUID()}`);
    const capture = await createText(source, "metadata-capture");
    const attachment = await call<AttachmentMutationResult>(source, "attachment.create", {
      requestId: "metadata-asset",
      captureId: capture.value.capture.captureId,
      kind: "text",
      mimeType: "text/plain",
      storage: "chunked",
      expectedTotalBytes: 3,
    });
    await call(source, "attachment.appendChunk", {
      requestId: "metadata-chunk",
      attachmentId: attachment.value.attachmentId,
      offset: 0,
      dataBase64: "YWJj",
    });
    await call(source, "attachment.complete", {
      requestId: "metadata-complete",
      attachmentId: attachment.value.attachmentId,
      totalBytes: 3,
      interrupted: false,
    });
    const bundle = await call<BackupBundle>(source, "backup.export", {
      includeAttachmentData: false,
    });
    expect(bundle.attachmentDataIncluded).toBe(false);
    expect(bundle.attachmentChunks).toBeUndefined();

    const destination = service(`backup-metadata-destination-${crypto.randomUUID()}`);
    await call(destination, "backup.import", {
      requestId: "metadata-import",
      bundle,
      conflictStrategy: "fail",
    });
    const metadata = await call<AttachmentGetResult>(destination, "attachment.get", {
      attachmentId: attachment.value.attachmentId,
      encoding: "metadata",
    });
    expect(metadata.attachment).toMatchObject({
      byteLength: 3,
      dataAvailable: false,
    });
    await expect(
      call(destination, "attachment.get", {
        attachmentId: attachment.value.attachmentId,
        encoding: "base64",
      }),
    ).rejects.toMatchObject({ code: "ASSET_UNAVAILABLE" });

    const reexported = await call<BackupBundle>(destination, "backup.export", {
      includeAttachmentData: true,
    });
    expect(reexported.attachmentDataIncluded).toBe(true);
    expect(reexported.attachments[0]?.dataAvailable).toBe(false);
    expect(reexported.attachmentChunks).toEqual([]);
    const secondDestination = service(`backup-metadata-second-${crypto.randomUUID()}`);
    await call(secondDestination, "backup.import", {
      requestId: "metadata-second-import",
      bundle: reexported,
      conflictStrategy: "fail",
    });
    const secondMetadata = await call<AttachmentGetResult>(
      secondDestination,
      "attachment.get",
      {
        attachmentId: attachment.value.attachmentId,
        encoding: "metadata",
      },
    );
    expect(secondMetadata.attachment.dataAvailable).toBe(false);
  });
});
