import { z, ZodError, type ZodType } from "zod";

import { ClipperError } from "./errors.js";
import { CORE_SCHEMA_VERSION, MAX_ATTACHMENT_CHUNK_BYTES, type CoreMethod } from "./types.js";

const idSchema = z.string().trim().min(1).max(256);
const requestIdSchema = z.string().trim().min(1).max(256);
const isoDateSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "Expected an ISO date-time");
const nonNegativeFinite = z.number().finite().nonnegative();
const positiveFinite = z.number().finite().positive();
const jsonObjectSchema = z.record(z.string(), z.unknown());

const timeRangeSchema = z
  .object({ start: nonNegativeFinite, end: nonNegativeFinite })
  .strict()
  .refine((range) => range.end >= range.start, {
    message: "Range end must be greater than or equal to start",
    path: ["end"],
  });

const sourceSchema = z
  .object({
    title: z.string().max(4096),
    pageUrl: z.string().min(1).max(8192),
    canonicalUrl: z.string().max(8192).optional(),
    site: z.string().min(1).max(1024),
    contentId: z.string().max(4096).optional(),
    bookTitle: z.string().max(4096).optional(),
    chapterTitle: z.string().max(4096).optional(),
    chapterHref: z.string().max(8192).optional(),
    mediaDurationSeconds: nonNegativeFinite.optional(),
    identityConfidence: z
      .enum(["exact", "adapter_reported", "page_reported", "best_effort", "unknown"])
      .optional(),
    frame: z
      .object({
        frameId: z.number().int().nonnegative().optional(),
        documentId: z.string().max(1024).optional(),
        frameUrl: z.string().max(8192).optional(),
      })
      .strict()
      .optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();

const textLocatorSchema = z
  .object({
    type: z.enum(["text_quote", "text_position", "epub_cfi", "pdf_page", "unknown"]),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
    epubCfi: z.string().max(8192).optional(),
    pageIndex: z.number().int().nonnegative().optional(),
    sourceConfidence: z.string().max(256).optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();

const mediaPointSchema = z
  .object({
    mediaSeconds: nonNegativeFinite.nullable(),
    wallTime: isoDateSchema,
    unavailableReason: z.string().max(2048).optional(),
  })
  .strict();

const mediaEventSchema = z
  .object({
    type: z.enum([
      "start",
      "end",
      "pause",
      "resume",
      "seek",
      "rate_change",
      "observation",
      "interrupted",
    ]),
    mediaSeconds: nonNegativeFinite.nullable(),
    wallTime: isoDateSchema,
    playbackRate: positiveFinite.optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();

const selectionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      exact: z.string().min(1).max(10_000_000),
      prefix: z.string().max(100_000).optional(),
      suffix: z.string().max(100_000).optional(),
      sanitizedHtml: z.string().max(20_000_000).optional(),
      locator: textLocatorSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("media"),
      target: z.enum(["media_object", "page_scene"]),
      timeBasis: z.enum(["source_media", "recording_elapsed", "unknown"]),
      startClick: mediaPointSchema,
      endClick: mediaPointSchema.optional(),
      segments: z.array(timeRangeSchema).max(100_000).optional(),
      events: z.array(mediaEventSchema).max(100_000).optional(),
      continuity: z.enum(["continuous", "discontinuous", "unknown"]).optional(),
      lastObservedMediaSeconds: nonNegativeFinite.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      resourceUrl: z.string().max(8192).optional(),
      naturalWidth: z.number().int().nonnegative().optional(),
      naturalHeight: z.number().int().nonnegative().optional(),
      altText: z.string().max(100_000).optional(),
      locator: jsonObjectSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("region"),
      x: z.number().finite(),
      y: z.number().finite(),
      width: positiveFinite,
      height: positiveFinite,
      viewportWidth: positiveFinite,
      viewportHeight: positiveFinite,
      devicePixelRatio: positiveFinite,
    })
    .strict(),
  z
    .object({
      type: z.literal("clipboard"),
      text: z.string().min(1).max(10_000_000),
      sourceKnown: z.boolean(),
    })
    .strict(),
]);

const paddingSchema = z
  .object({
    beforeSeconds: nonNegativeFinite.max(86_400),
    afterSeconds: nonNegativeFinite.max(86_400),
  })
  .strict();

const integritySchema = z
  .object({
    status: z.enum(["complete_selection", "partial", "needs_completion"]),
    missing: z.array(z.string().min(1).max(512)).max(1024),
  })
  .strict();

const observationsSchema = z
  .object({
    segments: z.array(timeRangeSchema).max(100_000).optional(),
    events: z.array(mediaEventSchema).max(100_000).optional(),
    lastObservedMediaSeconds: nonNegativeFinite.nullable().optional(),
    attachmentIds: z.array(idSchema).max(100_000).optional(),
  })
  .strict();

const recordingCoverageSchema = z
  .object({
    timeBasis: z.literal("recording_elapsed"),
    recordingStartedAt: isoDateSchema,
    recordingStoppedAt: isoDateSchema,
    elapsedSeconds: nonNegativeFinite.max(86_400),
    requestedPreRollSeconds: nonNegativeFinite.max(86_400),
    actualPreRollSeconds: nonNegativeFinite.max(86_400),
    requestedPostRollSeconds: nonNegativeFinite.max(86_400),
    actualPostRollRecordingSeconds: nonNegativeFinite.max(86_400),
    observedPostRollMediaSeconds: nonNegativeFinite.max(86_400).optional(),
    postRollComplete: z.boolean(),
    stopReason: z.enum([
      "requested",
      "max_duration",
      "track_ended",
      "chunk_failure",
      "service_worker_restart",
      "page_closed",
      "source_changed",
      "recorder_error",
      "unavailable",
    ]),
    hasAudio: z.boolean(),
    hasVideo: z.boolean(),
    audioMonitor: z.boolean(),
  })
  .strict();

const recordingFailureSchema = z
  .object({
    code: z.string().min(1).max(256),
    message: z.string().min(1).max(4096),
    stage: z.enum(["start", "stream", "chunk", "stop"]),
    started: z.boolean(),
  })
  .strict();

const outputRequestSchema = z
  .object({
    videoWithAudio: z.boolean().optional(),
    separateAudio: z.boolean().optional(),
    frames: z
      .object({
        enabled: z.boolean(),
        mode: z.enum(["specified_times", "interval"]).optional(),
        sourceSeconds: z.array(nonNegativeFinite).max(100_000).optional(),
        intervalSeconds: positiveFinite.optional(),
      })
      .strict()
      .optional(),
    text: z.boolean().optional(),
    images: z.boolean().optional(),
  })
  .strict();

const executionOptionsSchema = z
  .object({
    acquisitionStrategy: z.enum(["source_first", "saved_asset_only", "custom"]).optional(),
    allowTemporaryFullDownload: z.boolean().optional(),
    requestedAcquisitionRanges: z.array(timeRangeSchema).max(100_000).optional(),
    outputRangePolicy: z.enum(["original", "padded", "custom"]).optional(),
    requestedOutputRanges: z.array(timeRangeSchema).max(100_000).optional(),
    outputs: outputRequestSchema.optional(),
    retryLimit: z.number().int().min(0).max(1).optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();

const failureSchema = z
  .object({
    code: z.string().min(1).max(256),
    message: z.string().min(1).max(20_000),
    stage: z.string().min(1).max(256),
    retryCount: z.number().int().nonnegative().max(1_000_000),
    retryable: z.boolean().optional(),
    details: jsonObjectSchema.optional(),
  })
  .strict();

const artifactSchema = z
  .object({
    assetId: idSchema,
    kind: z.enum(["video", "audio", "image", "frame", "text", "manifest", "other"]),
    mimeType: z.string().min(1).max(512),
    fileReference: z.string().max(8192).optional(),
    attachmentId: idSchema.optional(),
    byteLength: z.number().int().nonnegative().optional(),
    durationSeconds: nonNegativeFinite.optional(),
    sourceMediaSeconds: nonNegativeFinite.optional(),
    hasVideo: z.boolean().optional(),
    hasAudio: z.boolean().optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();

const verificationSchema = z
  .object({
    level: z.enum(["agent_reported", "bridge_verified"]),
    fileExists: z.boolean().optional(),
    requiredTracksPresent: z.boolean().optional(),
    timeCoverageChecked: z.boolean().optional(),
    warnings: z.array(z.string().max(4096)).max(10_000),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();

const schemas = {
  "capture.create": z
    .object({
      requestId: requestIdSchema,
      input: z
        .object({
          kind: z.enum([
            "text_selection",
            "mixed_selection",
            "image",
            "media_range",
            "audio_range",
            "region_capture",
            "clipboard_import",
          ]),
          state: z.enum(["open", "sealed"]),
          source: sourceSchema,
          selection: selectionSchema,
          padding: paddingSchema.optional(),
          captureMethod: z.string().min(1).max(256),
          assetsState: z.enum(["location_only", "partial_saved", "saved"]),
          attachmentIds: z.array(idSchema).max(100_000).optional(),
          integrity: integritySchema,
          capturedAt: isoDateSchema.optional(),
          supersedesCaptureId: idSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  "capture.updateDraft": z
    .object({
      requestId: requestIdSchema,
      captureId: idSchema,
      observations: observationsSchema,
    })
    .strict(),
  "capture.finalize": z
    .object({
      requestId: requestIdSchema,
      captureId: idSchema,
      completion: z
        .object({
          state: z.enum(["sealed", "interrupted"]),
          endedAt: isoDateSchema,
          endClick: mediaPointSchema.optional(),
          observations: observationsSchema.optional(),
          assetsState: z.enum(["location_only", "partial_saved", "saved"]).optional(),
          integrity: integritySchema,
        })
        .strict()
        .superRefine((value, context) => {
          if (value.state !== "interrupted") return;
          if (value.endClick !== undefined) {
            context.addIssue({
              code: "custom",
              message: "An interrupted capture cannot contain a user end click",
              path: ["endClick"],
            });
          }
          if (
            value.integrity.status === "complete_selection" ||
            !value.integrity.missing.includes("end_click")
          ) {
            context.addIssue({
              code: "custom",
              message: "An interrupted capture must preserve the missing end-click fact",
              path: ["integrity"],
            });
          }
        }),
    })
    .strict(),
  "capture.list": z
    .object({
      view: z.enum(["pending", "history", "all"]).default("pending"),
      collection: z.enum(["inbox", "saved"]).optional(),
      kinds: z
        .array(
          z.enum([
            "text_selection",
            "mixed_selection",
            "image",
            "media_range",
            "audio_range",
            "region_capture",
            "clipboard_import",
          ]),
        )
        .max(7)
        .optional(),
      sourceKey: z.string().max(8192).optional(),
      createdFrom: isoDateSchema.optional(),
      createdTo: isoDateSchema.optional(),
      cursor: z.string().max(8192).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict()
    .default({ view: "pending", limit: 50 }),
  "capture.get": z.object({ captureId: idSchema }).strict(),
  "job.get": z.object({ jobId: idSchema }).strict(),
  "job.claim": z
    .object({
      requestId: requestIdSchema,
      agentId: idSchema,
      jobIds: z.array(idSchema).min(1).max(200),
      execution: executionOptionsSchema.optional(),
      taskOutputDirectory: z.string().max(4096).optional(),
      connectionOutputDirectory: z.string().max(4096).optional(),
      requireOutputDirectory: z.boolean().default(false),
    })
    .strict(),
  "job.heartbeat": z
    .object({
      requestId: requestIdSchema,
      jobId: idSchema,
      claimToken: idSchema,
      stage: z.string().max(256).optional(),
      retryCount: z.number().int().nonnegative().max(1_000_000).optional(),
      state: z.enum(["active", "uncertain"]).default("active"),
      message: z.string().max(20_000).optional(),
    })
    .strict(),
  "job.complete": z
    .object({
      requestId: requestIdSchema,
      jobId: idSchema,
      claimToken: idSchema,
      outcome: z.enum(["completed", "failed"]),
      acquisitionMethod: z
        .enum(["source_media", "browser_recording", "normalized_recording", "saved_text", "other"])
        .optional(),
      requestedRanges: z.array(timeRangeSchema).max(100_000).default([]),
      acquiredRanges: z.array(timeRangeSchema).max(100_000).default([]),
      outputRanges: z.array(timeRangeSchema).max(100_000).default([]),
      paddingInFinalOutput: z.boolean().optional(),
      artifacts: z.array(artifactSchema).max(100_000).default([]),
      verification: verificationSchema,
      failure: failureSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.outcome === "failed" && value.failure === undefined) {
        context.addIssue({
          code: "custom",
          message: "failure is required when outcome is failed",
          path: ["failure"],
        });
      }
      if (value.outcome === "completed" && value.failure !== undefined) {
        context.addIssue({
          code: "custom",
          message: "failure is not allowed when outcome is completed",
          path: ["failure"],
        });
      }
    }),
  "job.reprocess": z
    .object({
      requestId: requestIdSchema,
      captureId: idSchema,
      parentJobId: idSchema.optional(),
      execution: executionOptionsSchema.optional(),
    })
    .strict(),
  "library.setCollection": z
    .object({
      requestId: requestIdSchema,
      captureId: idSchema,
      collection: z.enum(["inbox", "saved"]),
    })
    .strict(),
  "library.cleanupPreview": z
    .object({
      requestId: requestIdSchema,
      scope: z.enum(["capture_ids", "all_processed"]).default("all_processed"),
      captureIds: z.array(idSchema).min(1).max(10_000).optional(),
      includeFailed: z.boolean().default(false),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.scope === "capture_ids" && value.captureIds === undefined) {
        context.addIssue({
          code: "custom",
          message: "captureIds is required for capture_ids scope",
          path: ["captureIds"],
        });
      }
    }),
  "library.cleanupCommit": z
    .object({ requestId: requestIdSchema, cleanupToken: idSchema })
    .strict(),
  "attachment.create": z
    .object({
      requestId: requestIdSchema,
      captureId: idSchema.optional(),
      jobId: idSchema.optional(),
      kind: z.enum([
        "source_image",
        "screen_region",
        "browser_recording",
        "text",
        "thumbnail",
        "other",
      ]),
      mimeType: z.string().min(1).max(512),
      storage: z.enum(["chunked", "external"]),
      fileReference: z.string().max(8192).optional(),
      expectedTotalBytes: z.number().int().nonnegative().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.storage === "external" && value.fileReference === undefined) {
        context.addIssue({
          code: "custom",
          message: "fileReference is required for external attachments",
          path: ["fileReference"],
        });
      }
    }),
  "attachment.appendChunk": z
    .object({
      requestId: requestIdSchema,
      attachmentId: idSchema,
      offset: z.number().int().nonnegative(),
      dataBase64: z
        .string()
        .min(1)
        .max(Math.ceil((MAX_ATTACHMENT_CHUNK_BYTES * 4) / 3) + 8),
    })
    .strict(),
  "attachment.complete": z
    .object({
      requestId: requestIdSchema,
      attachmentId: idSchema,
      totalBytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/u).optional(),
      interrupted: z.boolean().default(false),
      recordingCoverage: recordingCoverageSchema.optional(),
      recordingFailure: recordingFailureSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.recordingCoverage && value.recordingCoverage.actualPreRollSeconds > value.recordingCoverage.requestedPreRollSeconds) {
        context.addIssue({ code: "custom", message: "actual pre-roll cannot exceed requested pre-roll", path: ["recordingCoverage", "actualPreRollSeconds"] });
      }
      if (value.recordingCoverage && value.recordingCoverage.actualPostRollRecordingSeconds > value.recordingCoverage.elapsedSeconds) {
        context.addIssue({ code: "custom", message: "actual post-roll cannot exceed total elapsed recording time", path: ["recordingCoverage", "actualPostRollRecordingSeconds"] });
      }
      if (value.recordingFailure && !value.interrupted) {
        context.addIssue({ code: "custom", message: "a recording failure requires an interrupted attachment", path: ["recordingFailure"] });
      }
      if (value.recordingFailure?.started === false && value.recordingCoverage) {
        context.addIssue({ code: "custom", message: "an unstarted recording cannot contain measured recording coverage", path: ["recordingFailure", "started"] });
      }
    }),
  "attachment.get": z
    .object({
      attachmentId: idSchema,
      offset: z.number().int().nonnegative().default(0),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(MAX_ATTACHMENT_CHUNK_BYTES)
        .default(MAX_ATTACHMENT_CHUNK_BYTES),
      encoding: z.enum(["base64", "metadata"]).default("base64"),
    })
    .strict(),
  "settings.get": z.object({}).strict().default({}),
  "settings.update": z
    .object({
      requestId: requestIdSchema,
      patch: z
        .object({
          paddingBeforeSeconds: nonNegativeFinite.max(86_400).optional(),
          paddingAfterSeconds: nonNegativeFinite.max(86_400).optional(),
          reminderMinutes: z.number().int().min(1).max(10_080).nullable().optional(),
          defaultOutputRangePolicy: z.enum(["original", "padded"]).optional(),
          globalOutputDirectory: z.string().max(4096).nullable().optional(),
          maxRecordingSeconds: z.number().int().min(1).max(86_400).optional(),
          maxRecordingBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
          maxAttachmentBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .strict(),
    })
    .strict(),
  "backup.export": z
    .object({ includeAttachmentData: z.boolean().default(false) })
    .strict()
    .default({ includeAttachmentData: false }),
  "backup.import": z
    .object({
      requestId: requestIdSchema,
      bundle: z
        .object({
          format: z.literal("babel-content-clipper-backup"),
          schemaVersion: z.string().min(1).max(32),
          exportedAt: isoDateSchema,
          profileId: idSchema,
          attachmentDataIncluded: z.boolean().default(false),
          captures: z.array(z.unknown()).max(1_000_000),
          jobs: z.array(z.unknown()).max(1_000_000),
          results: z.array(z.unknown()).max(1_000_000),
          events: z.array(z.unknown()).max(2_000_000),
          attachments: z.array(z.unknown()).max(1_000_000),
          attachmentChunks: z
            .array(
              z
                .object({
                  attachmentId: idSchema,
                  offset: z.number().int().nonnegative(),
                  dataBase64: z
                    .string()
                    .min(1)
                    .max(Math.ceil((MAX_ATTACHMENT_CHUNK_BYTES * 4) / 3) + 8),
                })
                .strict(),
            )
            .max(2_000_000)
            .optional(),
          settings: z.unknown(),
        })
        .strict(),
      conflictStrategy: z.enum(["fail", "skip_identical"]).default("fail"),
    })
    .strict(),
  "diagnostics.get": z.object({}).strict().default({}),
  "connection.status": z.object({}).strict().default({}),
} satisfies Record<CoreMethod, ZodType>;

export function parseMethodParams<T>(method: CoreMethod, params: unknown): T {
  try {
    return schemas[method].parse(params) as T;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ClipperError("VALIDATION_ERROR", `Invalid parameters for ${method}`, {
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      });
    }
    throw error;
  }
}

export function assertCurrentBackupVersion(version: string): void {
  if (version !== CORE_SCHEMA_VERSION) {
    throw new ClipperError(
      "MIGRATION_UNSUPPORTED",
      `Backup schema ${version} cannot be migrated to ${CORE_SCHEMA_VERSION}`,
      { sourceVersion: version, targetVersion: CORE_SCHEMA_VERSION },
    );
  }
}
