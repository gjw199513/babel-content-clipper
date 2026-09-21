import type { IDBPDatabase } from "idb";

import {
  type CleanupSnapshotRecord,
  type CoreDatabaseSchema,
  type MetaRecord,
  type ReceiptRecord,
  openClipperDatabase,
} from "./database.js";
import { ClipperError, invariant } from "./errors.js";
import { addPadding, normalizeRanges, resolveOutputDirectory, validateDirectory } from "./ranges.js";
import { redactUrlCredentials } from "./url-security.js";
import {
  CORE_METHODS,
  CORE_SCHEMA_VERSION,
  MAX_ATTACHMENT_CHUNK_BYTES,
  type AttachmentChunkRecord,
  type AttachmentGetResult,
  type AttachmentRecord,
  type BackupBundle,
  type BackupImportResult,
  type CaptureCreateInput,
  type CaptureDetailResult,
  type CaptureDraftObservations,
  type CaptureFinalizeInput,
  type CaptureListItem,
  type CaptureListResult,
  type CaptureRecord,
  type CaptureSelection,
  type ClaimBatchResult,
  type ClipperSettings,
  type CleanupCandidate,
  type CleanupCommitResult,
  type CleanupPreviewResult,
  type CleanupSkipped,
  type CompleteJobResult,
  type ConnectionStatusResult,
  type CoreMethod,
  type CoreService,
  type CreateClipperServiceOptions,
  type DiagnosticsResult,
  type DispatchContext,
  type DirectoryResolution,
  type ExecutionEvent,
  type ExecutionOptions,
  type FailureInfo,
  type JobRecord,
  type MutationResult,
  type PersistedAck,
  type ResultArtifact,
  type ResultRecord,
  type RecordingCoverage,
  type RecordingFailureFact,
  type TimeRange,
  type VerificationReport,
} from "./types.js";
import { assertCurrentBackupVersion, parseMethodParams } from "./validation.js";
import {
  base64ToBytes,
  bytesToBase64,
  defaultRandomUUID,
  fingerprint,
  makeId,
} from "./utils.js";

const DEFAULT_DATABASE_NAME = "babel-content-clipper";
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_STALE_PROCESSING_MS = 5 * 60_000;
const CLEANUP_TOKEN_TTL_MS = 15 * 60_000;

interface ReceiptStoreLike {
  get(key: string): Promise<ReceiptRecord | undefined>;
  put(value: ReceiptRecord): Promise<IDBValidKey>;
}

interface MetaStoreLike {
  get(key: string): Promise<MetaRecord | undefined>;
  put(value: MetaRecord): Promise<IDBValidKey>;
}

function observeTransaction(transaction: { readonly done: Promise<unknown> }): void {
  // A request may reject before the method reaches its final `await done`.
  // Observe the abort immediately so IndexedDB never produces an unhandled rejection;
  // successful paths still await the original promise before returning an ACK.
  void transaction.done.catch(() => undefined);
}

function isEmptyTerminalBrowserRecording(attachment: AttachmentRecord): boolean {
  return (
    attachment.kind === "browser_recording" &&
    attachment.status !== "writing" &&
    attachment.byteLength === 0
  );
}

function withEffectiveAttachmentAvailability(attachment: AttachmentRecord): AttachmentRecord {
  if (!isEmptyTerminalBrowserRecording(attachment) || attachment.dataAvailable === false) {
    return attachment;
  }
  return { ...attachment, dataAvailable: false };
}

interface CaptureCreateParams {
  readonly requestId: string;
  readonly input: CaptureCreateInput;
}

interface CaptureUpdateDraftParams {
  readonly requestId: string;
  readonly captureId: string;
  readonly observations: CaptureDraftObservations;
}

interface CaptureFinalizeParams {
  readonly requestId: string;
  readonly captureId: string;
  readonly completion: CaptureFinalizeInput;
}

interface CaptureListParams {
  readonly view: "pending" | "history" | "all";
  readonly collection?: "inbox" | "saved";
  readonly kinds?: readonly CaptureRecord["kind"][];
  readonly sourceKey?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly cursor?: string;
  readonly limit: number;
}

interface JobClaimParams {
  readonly requestId: string;
  readonly agentId: string;
  readonly jobIds: readonly string[];
  readonly execution?: ExecutionOptions;
  readonly taskOutputDirectory?: string;
  readonly connectionOutputDirectory?: string;
  readonly requireOutputDirectory: boolean;
}

interface JobHeartbeatParams {
  readonly requestId: string;
  readonly jobId: string;
  readonly claimToken: string;
  readonly stage?: string;
  readonly retryCount?: number;
  readonly state: "active" | "uncertain";
  readonly message?: string;
}

interface JobCompleteParams {
  readonly requestId: string;
  readonly jobId: string;
  readonly claimToken: string;
  readonly outcome: "completed" | "failed";
  readonly acquisitionMethod?: ResultRecord["acquisitionMethod"];
  readonly requestedRanges: readonly TimeRange[];
  readonly acquiredRanges: readonly TimeRange[];
  readonly outputRanges: readonly TimeRange[];
  readonly paddingInFinalOutput?: boolean;
  readonly artifacts: readonly ResultArtifact[];
  readonly verification: VerificationReport;
  readonly failure?: FailureInfo;
}

interface JobReprocessParams {
  readonly requestId: string;
  readonly captureId: string;
  readonly parentJobId?: string;
  readonly execution?: ExecutionOptions;
}

interface SetCollectionParams {
  readonly requestId: string;
  readonly captureId: string;
  readonly collection: "inbox" | "saved";
}

interface CleanupPreviewParams {
  readonly requestId: string;
  readonly scope: "capture_ids" | "all_processed";
  readonly captureIds?: readonly string[];
  readonly includeFailed: boolean;
}

interface CleanupCommitParams {
  readonly requestId: string;
  readonly cleanupToken: string;
}

interface AttachmentCreateParams {
  readonly requestId: string;
  readonly captureId?: string;
  readonly jobId?: string;
  readonly kind: AttachmentRecord["kind"];
  readonly mimeType: string;
  readonly storage: AttachmentRecord["storage"];
  readonly fileReference?: string;
  readonly expectedTotalBytes?: number;
}

interface AttachmentAppendParams {
  readonly requestId: string;
  readonly attachmentId: string;
  readonly offset: number;
  readonly dataBase64: string;
}

interface AttachmentCompleteParams {
  readonly requestId: string;
  readonly attachmentId: string;
  readonly totalBytes: number;
  readonly sha256?: string;
  readonly interrupted: boolean;
  readonly recordingCoverage?: RecordingCoverage;
  readonly recordingFailure?: RecordingFailureFact;
}

interface AttachmentGetParams {
  readonly attachmentId: string;
  readonly offset: number;
  readonly maxBytes: number;
  readonly encoding: "base64" | "metadata";
}

interface SettingsUpdateParams {
  readonly requestId: string;
  readonly patch: {
    readonly paddingBeforeSeconds?: number;
    readonly paddingAfterSeconds?: number;
    readonly reminderMinutes?: number | null;
    readonly defaultOutputRangePolicy?: "original" | "padded";
    readonly globalOutputDirectory?: string | null;
    readonly maxRecordingSeconds?: number;
    readonly maxRecordingBytes?: number;
    readonly maxAttachmentBytes?: number;
  };
}

interface BackupImportParams {
  readonly requestId: string;
  readonly bundle: BackupBundle & { readonly schemaVersion: string };
  readonly conflictStrategy: "fail" | "skip_identical";
}

function isCoreMethod(method: string): method is CoreMethod {
  return (CORE_METHODS as readonly string[]).includes(method);
}

function receiptKey(profileId: string, method: string, requestId: string): string {
  return `${profileId}\u0000${method}\u0000${requestId}`;
}

async function replayReceipt<T>(
  store: ReceiptStoreLike,
  profileId: string,
  method: string,
  requestId: string,
  requestFingerprint: string,
): Promise<T | undefined> {
  const existing = await store.get(receiptKey(profileId, method, requestId));
  if (!existing) return undefined;
  if (existing.requestFingerprint !== requestFingerprint) {
    throw new ClipperError(
      "IDEMPOTENCY_CONFLICT",
      `Request id ${requestId} was already used with different parameters`,
      { method, requestId },
    );
  }
  return existing.response as T;
}

async function saveReceipt(
  store: ReceiptStoreLike,
  profileId: string,
  method: string,
  requestId: string,
  requestFingerprint: string,
  response: unknown,
  createdAt: string,
): Promise<void> {
  await store.put({
    receiptKey: receiptKey(profileId, method, requestId),
    profileId,
    method,
    requestId,
    requestFingerprint,
    response,
    createdAt,
  });
}

async function bumpRevision(store: MetaStoreLike, profileId: string): Promise<number> {
  const key = `revision:${profileId}`;
  const current = await store.get(key);
  const revision = Number(current?.value ?? 0) + 1;
  await store.put({ key, value: revision });
  return revision;
}

async function currentRevision(store: MetaStoreLike, profileId: string): Promise<number> {
  const current = await store.get(`revision:${profileId}`);
  return Number(current?.value ?? 0);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function mergeExecutionOptions(
  base: ExecutionOptions,
  override?: ExecutionOptions,
  capture?: CaptureRecord,
): ExecutionOptions {
  if (!override) return base;
  const merged: ExecutionOptions = {
    ...base,
    ...override,
    outputs:
      base.outputs || override.outputs
        ? { ...base.outputs, ...override.outputs }
        : undefined,
    metadata:
      base.metadata || override.metadata
        ? { ...base.metadata, ...override.metadata }
        : undefined,
  };
  if (override.outputRangePolicy === undefined || override.requestedOutputRanges !== undefined) {
    return merged;
  }
  if (!capture) {
    throw new ClipperError(
      "VALIDATION_ERROR",
      "Changing outputRangePolicy requires the capture facts used to derive output ranges",
    );
  }
  if (override.outputRangePolicy === "custom") {
    if (base.outputRangePolicy === "custom" && base.requestedOutputRanges !== undefined) {
      return merged;
    }
    throw new ClipperError(
      "VALIDATION_ERROR",
      "A custom output range policy requires requestedOutputRanges",
    );
  }
  return {
    ...merged,
    requestedOutputRanges:
      override.outputRangePolicy === "padded"
        ? capture.plannedAcquisitionRanges
        : capture.selection.type === "media"
          ? capture.selection.normalizedSegments
          : [],
  };
}

function sourceKey(source: CaptureCreateInput["source"]): string {
  if (source.contentId) return `${source.site}\u0000${source.contentId}`;
  return source.canonicalUrl ?? source.pageUrl;
}

function redactUrlMetadataValue(value: unknown, key?: string, depth = 0): unknown {
  if (depth > 12) return value;
  if (
    typeof value === "string" &&
    key &&
    (/(?:url|uri|href)s?$/iu.test(key) || key === "imageReferences")
  ) {
    return redactUrlCredentials(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUrlMetadataValue(item, key, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactUrlMetadataValue(child, childKey, depth + 1),
    ]),
  );
}

function redactCaptureSourceUrls(
  source: CaptureCreateInput["source"],
): CaptureCreateInput["source"] {
  return {
    ...source,
    pageUrl: redactUrlCredentials(source.pageUrl),
    ...(source.canonicalUrl
      ? { canonicalUrl: redactUrlCredentials(source.canonicalUrl) }
      : {}),
    ...(source.chapterHref ? { chapterHref: redactUrlCredentials(source.chapterHref) } : {}),
    ...(source.frame
      ? {
          frame: {
            ...source.frame,
            ...(source.frame.frameUrl
              ? { frameUrl: redactUrlCredentials(source.frame.frameUrl) }
              : {}),
          },
        }
      : {}),
    ...(source.metadata
      ? {
          metadata: redactUrlMetadataValue(source.metadata) as CaptureCreateInput["source"]["metadata"],
        }
      : {}),
  };
}

function redactCaptureSelectionUrls(
  selection: CaptureCreateInput["selection"],
): CaptureCreateInput["selection"] {
  if (selection.type === "image") {
    return {
      ...selection,
      ...(selection.resourceUrl
        ? { resourceUrl: redactUrlCredentials(selection.resourceUrl) }
        : {}),
      ...(selection.locator
        ? { locator: redactUrlMetadataValue(selection.locator) as typeof selection.locator }
        : {}),
    };
  }
  if (selection.type === "text" && selection.locator?.metadata) {
    return {
      ...selection,
      locator: {
        ...selection.locator,
        metadata: redactUrlMetadataValue(selection.locator.metadata) as typeof selection.locator.metadata,
      },
    };
  }
  if (selection.type === "media" && selection.events) {
    return {
      ...selection,
      events: selection.events.map((event) => ({
        ...event,
        ...(event.metadata
          ? { metadata: redactUrlMetadataValue(event.metadata) as typeof event.metadata }
          : {}),
      })),
    };
  }
  return selection;
}

function redactCaptureRecordUrls(capture: CaptureRecord): CaptureRecord {
  const source = redactCaptureSourceUrls(capture.source);
  const selection = redactCaptureSelectionUrls(capture.selection) as CaptureSelection;
  return { ...capture, source, sourceKey: sourceKey(source), selection };
}

function selectionRanges(selection: CaptureSelection): TimeRange[] {
  if (selection.type !== "media") return [];
  if (selection.segments.length > 0) return [...selection.segments];
  const start = selection.startClick.mediaSeconds;
  const end = selection.endClick?.mediaSeconds;
  if (start === null || end === null || end === undefined) return [];
  if (end < start) {
    throw new ClipperError(
      "VALIDATION_ERROR",
      "A media selection that seeks backward must provide observed segments",
    );
  }
  return [{ start, end }];
}

function materializeSelection(input: CaptureCreateInput["selection"]): CaptureSelection {
  if (input.type !== "media") return input;
  const rawSegments = input.segments ? [...input.segments] : [];
  const selection: CaptureSelection = {
    ...input,
    segments: rawSegments,
    normalizedSegments: [],
    events: input.events ? [...input.events] : [],
  };
  const ranges = selectionRanges(selection);
  return { ...selection, normalizedSegments: normalizeRanges(ranges) };
}

function appendObservations(
  selection: CaptureSelection,
  observations: CaptureDraftObservations | undefined,
): CaptureSelection {
  if (!observations) return selection;
  if (selection.type !== "media") {
    throw new ClipperError(
      "VALIDATION_ERROR",
      "Draft observations are only valid for media selections",
    );
  }
  const segments = [...selection.segments, ...(observations.segments ?? [])];
  return {
    ...selection,
    segments,
    normalizedSegments: normalizeRanges(segments),
    events: [...selection.events, ...(observations.events ?? [])],
    lastObservedMediaSeconds:
      observations.lastObservedMediaSeconds !== undefined
        ? observations.lastObservedMediaSeconds
        : selection.lastObservedMediaSeconds,
  };
}

function defaultSettings(profileId: string, now: string, revision: number): ClipperSettings {
  return {
    profileId,
    paddingBeforeSeconds: 10,
    paddingAfterSeconds: 10,
    reminderMinutes: 10,
    defaultOutputRangePolicy: "padded",
    maxRecordingSeconds: 600,
    maxRecordingBytes: 256 * 1024 * 1024,
    maxAttachmentBytes: 1024 * 1024 * 1024,
    updatedAt: now,
    revision,
  };
}

function makePendingJob(input: {
  readonly jobId: string;
  readonly capture: CaptureRecord;
  readonly now: string;
  readonly revision: number;
  readonly reason: JobRecord["reason"];
  readonly parentJobId?: string;
  readonly executionOptions: ExecutionOptions;
}): JobRecord {
  return {
    jobId: input.jobId,
    profileId: input.capture.profileId,
    captureId: input.capture.captureId,
    reason: input.reason,
    ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
    status: "pending",
    createdAt: input.now,
    updatedAt: input.now,
    executionOptions: input.executionOptions,
    directory: { source: "none" },
    revision: input.revision,
  };
}

function makeExecutionEvent(input: {
  readonly eventId: string;
  readonly profileId: string;
  readonly jobId: string;
  readonly captureId: string;
  readonly type: ExecutionEvent["type"];
  readonly now: string;
  readonly workerId?: string;
  readonly stage?: string;
  readonly retryCount?: number;
  readonly message?: string;
}): ExecutionEvent {
  return {
    eventId: input.eventId,
    profileId: input.profileId,
    jobId: input.jobId,
    captureId: input.captureId,
    type: input.type,
    createdAt: input.now,
    ...(input.workerId ? { workerId: input.workerId } : {}),
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
    ...(input.message ? { message: input.message } : {}),
  };
}

function capturePreview(capture: CaptureRecord): string {
  const selection = capture.selection;
  if (selection.type === "text") {
    return selection.exact.length <= 120
      ? selection.exact
      : `${selection.exact.slice(0, 117)}…`;
  }
  if (selection.type === "clipboard") {
    return selection.text.length <= 120
      ? selection.text
      : `${selection.text.slice(0, 117)}…`;
  }
  if (selection.type === "media") {
    const start = selection.startClick.mediaSeconds;
    const end = selection.endClick?.mediaSeconds;
    const format = (value: number | null | undefined): string =>
      value === null || value === undefined ? "?" : value.toFixed(3).replace(/\.000$/u, "");
    return `${format(start)}–${format(end)}s`;
  }
  if (selection.type === "image") return selection.altText || "Image";
  return "Selected region";
}

function withoutTechnicalFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTechnicalFields);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "revision" || key === "profileId") continue;
      output[key] = withoutTechnicalFields(child);
    }
    return output;
  }
  return value;
}

function recordsEqual(left: unknown, right: unknown): boolean {
  return fingerprint(withoutTechnicalFields(left)) === fingerprint(withoutTechnicalFields(right));
}

const ENTITY_ID_FIELDS = new Set([
  "captureId",
  "jobId",
  "resultId",
  "attachmentId",
  "captureIds",
  "jobIds",
  "resultIds",
  "attachmentIds",
  "deletedCaptureIds",
]);

function responseReferencesEntityIds(value: unknown, entityIds: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => responseReferencesEntityIds(item, entityIds));
  }
  if (value === null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (ENTITY_ID_FIELDS.has(key)) {
      if (typeof child === "string" && entityIds.has(child)) return true;
      if (
        Array.isArray(child) &&
        child.some((item) => typeof item === "string" && entityIds.has(item))
      ) {
        return true;
      }
    }
    if (responseReferencesEntityIds(child, entityIds)) return true;
  }
  return false;
}

function importObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClipperError("VALIDATION_ERROR", `Backup ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function importString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 10_000) {
    throw new ClipperError("VALIDATION_ERROR", `Backup ${label}.${key} must be a string`);
  }
  return value;
}

function assertUniqueImportIds(
  records: readonly unknown[],
  key: string,
  label: string,
): Set<string> {
  const ids = new Set<string>();
  for (const value of records) {
    const record = importObject(value, label);
    const id = importString(record, key, label);
    if (ids.has(id)) {
      throw new ClipperError("VALIDATION_ERROR", `Backup contains duplicate ${label} id`, {
        id,
      });
    }
    ids.add(id);
  }
  return ids;
}

function assertImportProfile(
  record: Record<string, unknown>,
  label: string,
  sourceProfileId: string,
): void {
  const recordProfileId = importString(record, "profileId", label);
  if (recordProfileId !== sourceProfileId) {
    throw new ClipperError(
      "VALIDATION_ERROR",
      `Backup ${label} belongs to a different source profile`,
      { expectedProfileId: sourceProfileId, recordProfileId },
    );
  }
}

function validateImportedRecordingCoverage(value: unknown, attachmentId: string): void {
  if (value === undefined) return;
  const coverage = importObject(value, "attachment.recordingCoverage");
  const numericKeys = [
    "elapsedSeconds",
    "requestedPreRollSeconds",
    "actualPreRollSeconds",
    "requestedPostRollSeconds",
    "actualPostRollRecordingSeconds",
  ] as const;
  for (const key of numericKeys) {
    const field = coverage[key];
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0 || field > 86_400) {
      throw new ClipperError("VALIDATION_ERROR", `Backup recording coverage.${key} is invalid`, { attachmentId });
    }
  }
  if (coverage.observedPostRollMediaSeconds !== undefined && (
    typeof coverage.observedPostRollMediaSeconds !== "number" ||
    !Number.isFinite(coverage.observedPostRollMediaSeconds) ||
    coverage.observedPostRollMediaSeconds < 0 ||
    coverage.observedPostRollMediaSeconds > 86_400
  )) {
    throw new ClipperError("VALIDATION_ERROR", "Backup recording coverage observation is invalid", { attachmentId });
  }
  if (
    coverage.timeBasis !== "recording_elapsed" ||
    typeof coverage.recordingStartedAt !== "string" ||
    !Number.isFinite(Date.parse(coverage.recordingStartedAt)) ||
    typeof coverage.recordingStoppedAt !== "string" ||
    !Number.isFinite(Date.parse(coverage.recordingStoppedAt)) ||
    typeof coverage.postRollComplete !== "boolean" ||
    typeof coverage.hasAudio !== "boolean" ||
    typeof coverage.hasVideo !== "boolean" ||
    typeof coverage.audioMonitor !== "boolean" ||
    ![
      "requested", "max_duration", "track_ended", "chunk_failure",
      "service_worker_restart", "page_closed", "source_changed",
      "recorder_error", "unavailable",
    ].includes(String(coverage.stopReason))
  ) {
    throw new ClipperError("VALIDATION_ERROR", "Backup recording coverage is invalid", { attachmentId });
  }
  if (
    (coverage.actualPreRollSeconds as number) > (coverage.requestedPreRollSeconds as number) ||
    (coverage.actualPostRollRecordingSeconds as number) > (coverage.elapsedSeconds as number)
  ) {
    throw new ClipperError("VALIDATION_ERROR", "Backup recording coverage exceeds its measured bounds", { attachmentId });
  }
}

function validateImportedRecordingFailure(value: unknown, attachmentId: string): void {
  if (value === undefined) return;
  const failure = importObject(value, "attachment.recordingFailure");
  if (
    typeof failure.code !== "string" || failure.code.length === 0 || failure.code.length > 256 ||
    typeof failure.message !== "string" || failure.message.length === 0 || failure.message.length > 4_096 ||
    !["start", "stream", "chunk", "stop"].includes(String(failure.stage)) ||
    typeof failure.started !== "boolean"
  ) {
    throw new ClipperError("VALIDATION_ERROR", "Backup recording failure is invalid", { attachmentId });
  }
}

function validateBackupBundle(bundle: BackupImportParams["bundle"]): void {
  const captureIds = assertUniqueImportIds(bundle.captures, "captureId", "capture");
  const jobIds = assertUniqueImportIds(bundle.jobs, "jobId", "job");
  assertUniqueImportIds(bundle.results, "resultId", "result");
  assertUniqueImportIds(bundle.events, "eventId", "event");
  const attachmentIds = assertUniqueImportIds(
    bundle.attachments,
    "attachmentId",
    "attachment",
  );
  const sourceProfileId = bundle.profileId;
  const captureAttachmentRefs = new Map<string, readonly string[]>();
  const jobCaptureIds = new Map<string, string>();
  const jobRecords = new Map<string, Record<string, unknown>>();
  const resultRecords: Record<string, unknown>[] = [];

  for (const value of bundle.captures) {
    const record = importObject(value, "capture");
    assertImportProfile(record, "capture", sourceProfileId);
    if (importString(record, "schemaVersion", "capture") !== CORE_SCHEMA_VERSION) {
      throw new ClipperError("MIGRATION_UNSUPPORTED", "Backup capture schema is unsupported");
    }
    const captureId = importString(record, "captureId", "capture");
    const state = importString(record, "state", "capture");
    const collection = importString(record, "collection", "capture");
    if (!(["open", "sealed", "interrupted"] as const).includes(state as never)) {
      throw new ClipperError("VALIDATION_ERROR", "Backup capture has an invalid state", {
        state,
      });
    }
    if (!(["inbox", "saved"] as const).includes(collection as never)) {
      throw new ClipperError("VALIDATION_ERROR", "Backup capture has an invalid collection");
    }
    importObject(record.source, "capture.source");
    const selection = importObject(record.selection, "capture.selection");
    if (state === "interrupted" && selection.endClick !== undefined) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "An interrupted backup capture cannot contain a user end click",
        { captureId },
      );
    }
    if (!Array.isArray(record.attachmentIds)) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "Backup capture.attachmentIds must be an array",
        { captureId },
      );
    }
    const attachmentRefs = record.attachmentIds.map((attachmentId) => {
      if (typeof attachmentId !== "string" || attachmentId.length === 0) {
        throw new ClipperError(
          "VALIDATION_ERROR",
          "Backup capture contains an invalid attachment id",
          { captureId },
        );
      }
      return attachmentId;
    });
    captureAttachmentRefs.set(captureId, attachmentRefs);
  }
  for (const value of bundle.jobs) {
    const record = importObject(value, "job");
    assertImportProfile(record, "job", sourceProfileId);
    const jobId = importString(record, "jobId", "job");
    const captureId = importString(record, "captureId", "job");
    const status = importString(record, "status", "job");
    if (!captureIds.has(captureId)) {
      throw new ClipperError("VALIDATION_ERROR", "Backup job references a missing capture", {
        captureId,
      });
    }
    if (!(["pending", "processing", "completed", "failed"] as const).includes(status as never)) {
      throw new ClipperError("VALIDATION_ERROR", "Backup job has an invalid four-state status", {
        status,
      });
    }
    jobCaptureIds.set(jobId, captureId);
    jobRecords.set(jobId, record);
  }
  for (const [jobId, record] of jobRecords) {
    if (record.parentJobId === undefined) continue;
    if (typeof record.parentJobId !== "string" || !jobIds.has(record.parentJobId)) {
      throw new ClipperError("VALIDATION_ERROR", "Backup job references a missing parent", {
        jobId,
      });
    }
    if (jobCaptureIds.get(record.parentJobId) !== jobCaptureIds.get(jobId)) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "Backup parent job belongs to a different capture",
        { jobId, parentJobId: record.parentJobId },
      );
    }
  }
  for (const value of bundle.results) {
    const record = importObject(value, "result");
    assertImportProfile(record, "result", sourceProfileId);
    const jobId = importString(record, "jobId", "result");
    const captureId = importString(record, "captureId", "result");
    const status = importString(record, "status", "result");
    if (!jobIds.has(jobId) || !captureIds.has(captureId)) {
      throw new ClipperError("VALIDATION_ERROR", "Backup result has a broken relation");
    }
    if (jobCaptureIds.get(jobId) !== captureId) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "Backup result job and capture references do not match",
      );
    }
    if (status !== "completed" && status !== "failed") {
      throw new ClipperError("VALIDATION_ERROR", "Backup result has an invalid terminal status");
    }
    if (!Array.isArray(record.artifacts)) {
      throw new ClipperError("VALIDATION_ERROR", "Backup result.artifacts must be an array");
    }
    resultRecords.push(record);
  }
  for (const value of bundle.events) {
    const record = importObject(value, "event");
    assertImportProfile(record, "event", sourceProfileId);
    const jobId = importString(record, "jobId", "event");
    const captureId = importString(record, "captureId", "event");
    if (!jobIds.has(jobId) || !captureIds.has(captureId)) {
      throw new ClipperError("VALIDATION_ERROR", "Backup event has a broken relation");
    }
    if (jobCaptureIds.get(jobId) !== captureId) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "Backup event job and capture references do not match",
      );
    }
  }
  const attachmentRecords = new Map<string, Record<string, unknown>>();
  for (const value of bundle.attachments) {
    const record = importObject(value, "attachment");
    assertImportProfile(record, "attachment", sourceProfileId);
    const attachmentId = importString(record, "attachmentId", "attachment");
    attachmentRecords.set(attachmentId, record);
    const captureId = record.captureId;
    const jobId = record.jobId;
    if (captureId !== undefined && (typeof captureId !== "string" || !captureIds.has(captureId))) {
      throw new ClipperError("VALIDATION_ERROR", "Backup attachment references a missing capture");
    }
    if (jobId !== undefined && (typeof jobId !== "string" || !jobIds.has(jobId))) {
      throw new ClipperError("VALIDATION_ERROR", "Backup attachment references a missing job");
    }
    if (
      typeof captureId === "string" &&
      typeof jobId === "string" &&
      jobCaptureIds.get(jobId) !== captureId
    ) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "Backup attachment job and capture references do not match",
      );
    }
    if (record.storage !== "chunked" && record.storage !== "external") {
      throw new ClipperError("VALIDATION_ERROR", "Backup attachment storage is invalid");
    }
    if (typeof record.dataAvailable !== "boolean") {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "Backup attachment.dataAvailable must be boolean",
      );
    }
    if (!(["writing", "complete", "interrupted"] as const).includes(record.status as never)) {
      throw new ClipperError("VALIDATION_ERROR", "Backup attachment status is invalid");
    }
    if (
      typeof record.byteLength !== "number" ||
      !Number.isSafeInteger(record.byteLength) ||
      record.byteLength < 0
    ) {
      throw new ClipperError("VALIDATION_ERROR", "Backup attachment byteLength is invalid");
    }
    if ((record.recordingCoverage !== undefined || record.recordingFailure !== undefined) && record.kind !== "browser_recording") {
      throw new ClipperError("VALIDATION_ERROR", "Only a browser recording may contain recording facts", { attachmentId });
    }
    validateImportedRecordingCoverage(record.recordingCoverage, attachmentId);
    validateImportedRecordingFailure(record.recordingFailure, attachmentId);
    if (record.recordingFailure !== undefined && record.status !== "interrupted") {
      throw new ClipperError("VALIDATION_ERROR", "A recording failure requires an interrupted attachment", { attachmentId });
    }
    if (
      record.recordingFailure &&
      typeof record.recordingFailure === "object" &&
      (record.recordingFailure as Record<string, unknown>).started === false &&
      record.recordingCoverage !== undefined
    ) {
      throw new ClipperError("VALIDATION_ERROR", "An unstarted recording cannot contain measured coverage", { attachmentId });
    }
  }
  for (const [captureId, attachmentRefs] of captureAttachmentRefs) {
    for (const attachmentId of attachmentRefs) {
      const attachment = attachmentRecords.get(attachmentId);
      if (!attachment) {
        throw new ClipperError(
          "VALIDATION_ERROR",
          "Backup capture references a missing attachment",
          { captureId, attachmentId },
        );
      }
      if (attachment.captureId !== captureId) {
        throw new ClipperError(
          "VALIDATION_ERROR",
          "Backup capture and attachment ownership do not match",
          { captureId, attachmentId },
        );
      }
    }
  }
  for (const result of resultRecords) {
    const resultId = importString(result, "resultId", "result");
    const resultCaptureId = importString(result, "captureId", "result");
    const resultJobId = importString(result, "jobId", "result");
    for (const value of result.artifacts as unknown[]) {
      const artifact = importObject(value, "result.artifact");
      if (artifact.attachmentId === undefined) continue;
      if (typeof artifact.attachmentId !== "string") {
        throw new ClipperError(
          "VALIDATION_ERROR",
          "Backup result artifact has an invalid attachment id",
          { resultId },
        );
      }
      const attachment = attachmentRecords.get(artifact.attachmentId);
      if (!attachment) {
        throw new ClipperError(
          "VALIDATION_ERROR",
          "Backup result artifact references a missing attachment",
          { resultId, attachmentId: artifact.attachmentId },
        );
      }
      if (
        (attachment.captureId !== undefined && attachment.captureId !== resultCaptureId) ||
        (attachment.jobId !== undefined && attachment.jobId !== resultJobId)
      ) {
        throw new ClipperError(
          "VALIDATION_ERROR",
          "Backup result artifact attachment belongs to another record",
          { resultId, attachmentId: artifact.attachmentId },
        );
      }
    }
  }
  const chunkGroups = new Map<string, { offset: number; bytes: Uint8Array }[]>();
  for (const chunk of bundle.attachmentChunks ?? []) {
    const attachment = attachmentRecords.get(chunk.attachmentId);
    if (!attachmentIds.has(chunk.attachmentId) || !attachment) {
      throw new ClipperError("VALIDATION_ERROR", "Backup chunk references a missing attachment");
    }
    const bytes = base64ToBytes(chunk.dataBase64);
    if (attachment.storage !== "chunked" || attachment.dataAvailable !== true) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "Backup chunk belongs to an attachment without available internal data",
        { attachmentId: chunk.attachmentId },
      );
    }
    if (bytes.byteLength === 0) {
      throw new ClipperError("VALIDATION_ERROR", "Backup attachment chunks cannot be empty");
    }
    if (bytes.byteLength > MAX_ATTACHMENT_CHUNK_BYTES) {
      throw new ClipperError(
        "ATTACHMENT_CHUNK_TOO_LARGE",
        "Backup contains an oversized attachment chunk",
      );
    }
    const group = chunkGroups.get(chunk.attachmentId) ?? [];
    group.push({ offset: chunk.offset, bytes });
    chunkGroups.set(chunk.attachmentId, group);
  }
  if (!bundle.attachmentDataIncluded && (bundle.attachmentChunks?.length ?? 0) > 0) {
    throw new ClipperError(
      "VALIDATION_ERROR",
      "A metadata-only backup cannot contain attachment chunks",
    );
  }
  if (bundle.attachmentDataIncluded) {
    for (const [attachmentId, record] of attachmentRecords) {
      const chunks = (chunkGroups.get(attachmentId) ?? []).sort(
        (left, right) => left.offset - right.offset,
      );
      if (record.storage !== "chunked" || record.dataAvailable !== true) {
        if (chunks.length > 0) {
          throw new ClipperError(
            "VALIDATION_ERROR",
            "Backup includes data for an unavailable or external attachment",
            { attachmentId },
          );
        }
        continue;
      }
      let expectedOffset = 0;
      for (const chunk of chunks) {
        if (chunk.offset !== expectedOffset) {
          throw new ClipperError(
            "VALIDATION_ERROR",
            "Backup attachment chunks are not contiguous",
            { attachmentId, expectedOffset, receivedOffset: chunk.offset },
          );
        }
        expectedOffset += chunk.bytes.byteLength;
      }
      if (expectedOffset !== record.byteLength) {
        throw new ClipperError(
          "VALIDATION_ERROR",
          "Backup attachment chunks do not cover the declared byte length",
          { attachmentId, declaredBytes: record.byteLength as number, includedBytes: expectedOffset },
        );
      }
    }
  }
  const settings = importObject(bundle.settings, "settings");
  assertImportProfile(settings, "settings", sourceProfileId);
  for (const key of [
    "paddingBeforeSeconds",
    "paddingAfterSeconds",
    "maxRecordingSeconds",
    "maxRecordingBytes",
    "maxAttachmentBytes",
  ]) {
    if (typeof settings[key] !== "number" || !Number.isFinite(settings[key])) {
      throw new ClipperError("VALIDATION_ERROR", `Backup settings.${key} must be finite`);
    }
  }
  if (
    (settings.maxRecordingBytes as number) > (settings.maxAttachmentBytes as number)
  ) {
    throw new ClipperError(
      "VALIDATION_ERROR",
      "Backup recording budget exceeds its attachment budget",
    );
  }
}

class ClipperServiceImpl implements CoreService {
  readonly #databaseName: string;
  readonly #defaultProfileId: string;
  readonly #now: () => Date;
  readonly #randomUUID: () => string;
  readonly #browserAvailable: () => boolean;
  readonly #staleProcessingMs: number;
  readonly #databasePromise: Promise<IDBPDatabase<CoreDatabaseSchema>>;

  constructor(options: CreateClipperServiceOptions) {
    this.#databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    this.#defaultProfileId = options.defaultProfileId ?? DEFAULT_PROFILE_ID;
    this.#now = options.now ?? (() => new Date());
    this.#randomUUID = options.randomUUID ?? defaultRandomUUID;
    this.#browserAvailable = options.browserAvailable ?? (() => true);
    this.#staleProcessingMs = options.staleProcessingMs ?? DEFAULT_STALE_PROCESSING_MS;
    this.#databasePromise = openClipperDatabase(this.#databaseName);
  }

  async close(): Promise<void> {
    const database = await this.#databasePromise;
    database.close();
  }

  async handle(method: string, params: unknown, context: DispatchContext = {}): Promise<unknown> {
    if (!isCoreMethod(method)) {
      throw new ClipperError("METHOD_NOT_FOUND", `Unknown core method: ${method}`, { method });
    }
    const profileId = this.#profileId(context);
    if (method !== "connection.status" && !this.#browserAvailable()) {
      throw new ClipperError(
        "BROWSER_UNAVAILABLE",
        "The extension database is unavailable because the browser is not connected",
      );
    }

    switch (method) {
      case "capture.create":
        return this.#createCapture(profileId, parseMethodParams(method, params));
      case "capture.updateDraft":
        return this.#updateCaptureDraft(profileId, parseMethodParams(method, params));
      case "capture.finalize":
        return this.#finalizeCapture(profileId, parseMethodParams(method, params));
      case "capture.list":
        return this.#listCaptures(profileId, parseMethodParams(method, params));
      case "capture.get": {
        const parsed = parseMethodParams<{ captureId: string }>(method, params);
        return this.#getCapture(profileId, parsed.captureId);
      }
      case "job.get": {
        const parsed = parseMethodParams<{ jobId: string }>(method, params);
        return this.#getJob(profileId, parsed.jobId);
      }
      case "job.claim":
        return this.#claimJobs(
          profileId,
          parseMethodParams(method, params),
          context.connectionOutputDirectory,
        );
      case "job.heartbeat":
        return this.#heartbeat(profileId, parseMethodParams(method, params));
      case "job.complete":
        return this.#completeJob(profileId, parseMethodParams(method, params));
      case "job.reprocess":
        return this.#reprocess(profileId, parseMethodParams(method, params));
      case "library.setCollection":
        return this.#setCollection(profileId, parseMethodParams(method, params));
      case "library.cleanupPreview":
        return this.#cleanupPreview(profileId, parseMethodParams(method, params));
      case "library.cleanupCommit":
        return this.#cleanupCommit(profileId, parseMethodParams(method, params));
      case "attachment.create":
        return this.#createAttachment(profileId, parseMethodParams(method, params));
      case "attachment.appendChunk":
        return this.#appendAttachmentChunk(profileId, parseMethodParams(method, params));
      case "attachment.complete":
        return this.#completeAttachment(profileId, parseMethodParams(method, params));
      case "attachment.get":
        return this.#getAttachment(profileId, parseMethodParams(method, params));
      case "settings.get":
        parseMethodParams(method, params);
        return this.#getSettings(profileId);
      case "settings.update":
        return this.#updateSettings(profileId, parseMethodParams(method, params));
      case "backup.export": {
        const parsed = parseMethodParams<{ includeAttachmentData: boolean }>(method, params);
        return this.#exportBackup(profileId, parsed.includeAttachmentData);
      }
      case "backup.import":
        return this.#importBackup(profileId, parseMethodParams(method, params));
      case "diagnostics.get":
        parseMethodParams(method, params);
        return this.#diagnostics(profileId);
      case "connection.status":
        parseMethodParams(method, params);
        return this.#connectionStatus(profileId);
    }
  }

  #profileId(context: DispatchContext): string {
    const profileId = (context.profileId ?? this.#defaultProfileId).trim();
    if (
      profileId.length === 0 ||
      profileId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(profileId)
    ) {
      throw new ClipperError("PROFILE_REQUIRED", "A valid trusted profile id is required");
    }
    return profileId;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #id(prefix: string): string {
    return makeId(prefix, this.#randomUUID);
  }

  async #revision(profileId: string): Promise<number> {
    const database = await this.#databasePromise;
    const record = await database.get("meta", `revision:${profileId}`);
    return Number(record?.value ?? 0);
  }

  async #settingsForRead(profileId: string): Promise<ClipperSettings> {
    const database = await this.#databasePromise;
    const stored = await database.get("settings", profileId);
    if (stored) return stored;
    return defaultSettings(profileId, this.#timestamp(), await this.#revision(profileId));
  }

  async #createCapture(
    profileId: string,
    params: CaptureCreateParams,
  ): Promise<MutationResult<{ capture: CaptureRecord; job?: JobRecord }>> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      ["captures", "jobs", "executionEvents", "attachments", "settings", "receipts", "meta"],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<MutationResult<{ capture: CaptureRecord; job?: JobRecord }>>(
      receipts,
      profileId,
      "capture.create",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }

    const source = redactCaptureSourceUrls(params.input.source);
    const now = params.input.capturedAt ?? this.#timestamp();
    const settings =
      (await transaction.objectStore("settings").get(profileId)) ??
      defaultSettings(profileId, now, 0);
    const padding =
      params.input.padding ??
      ({
        beforeSeconds: settings.paddingBeforeSeconds,
        afterSeconds: settings.paddingAfterSeconds,
      } as const);
    const selection = materializeSelection(redactCaptureSelectionUrls(params.input.selection));

    if (params.input.state === "open" && selection.type !== "media") {
      throw new ClipperError("VALIDATION_ERROR", "Only media captures may be open drafts");
    }
    if (params.input.state === "sealed" && selection.type === "media" && !selection.endClick) {
      throw new ClipperError(
        "CAPTURE_INCOMPLETE",
        "A sealed media capture requires the user's end-click fact",
      );
    }
    if (params.input.state === "open" && selection.type === "media" && selection.endClick) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "An open media capture cannot already contain an end click",
      );
    }

    const captureId = this.#id("cap");
    const attachmentsToLink: AttachmentRecord[] = [];
    for (const attachmentId of uniqueStrings(params.input.attachmentIds ?? [])) {
      const attachment = await transaction.objectStore("attachments").get(attachmentId);
      invariant(
        attachment?.profileId === profileId,
        "NOT_FOUND",
        `Attachment ${attachmentId} does not exist in this profile`,
      );
      if (attachment.captureId && attachment.captureId !== captureId) {
        throw new ClipperError(
          "ATTACHMENT_CONFLICT",
          `Attachment ${attachmentId} already belongs to another capture`,
        );
      }
      attachmentsToLink.push(attachment);
    }
    const revision = await bumpRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    const normalizedRanges = selection.type === "media" ? selection.normalizedSegments : [];
    const plannedAcquisitionRanges = addPadding(
      normalizedRanges,
      padding.beforeSeconds,
      padding.afterSeconds,
      source.mediaDurationSeconds,
    );
    const initialJobId = params.input.state === "sealed" ? this.#id("job") : undefined;
    const capture: CaptureRecord = {
      schemaVersion: CORE_SCHEMA_VERSION,
      captureId,
      profileId,
      kind: params.input.kind,
      state: params.input.state,
      collection: "inbox",
      createdAt: now,
      ...(params.input.state === "sealed" ? { sealedAt: now } : {}),
      source,
      sourceKey: sourceKey(source),
      selection,
      padding,
      plannedAcquisitionRanges,
      captureMethod: params.input.captureMethod,
      assetsState: params.input.assetsState,
      attachmentIds: uniqueStrings(params.input.attachmentIds ?? []),
      integrity: params.input.integrity,
      ...(params.input.supersedesCaptureId
        ? { supersedesCaptureId: params.input.supersedesCaptureId }
        : {}),
      ...(initialJobId ? { initialJobId } : {}),
      revision,
    };

    for (const attachment of attachmentsToLink) {
      await transaction.objectStore("attachments").put({
        ...attachment,
        captureId,
        revision,
      });
    }

    await transaction.objectStore("captures").add(capture);
    let job: JobRecord | undefined;
    if (initialJobId) {
      job = makePendingJob({
        jobId: initialJobId,
        capture,
        now,
        revision,
        reason: "initial_processing",
        executionOptions: {
          acquisitionStrategy: "source_first",
          outputRangePolicy: settings.defaultOutputRangePolicy,
          requestedAcquisitionRanges: capture.plannedAcquisitionRanges,
          requestedOutputRanges:
            settings.defaultOutputRangePolicy === "padded"
              ? capture.plannedAcquisitionRanges
              : selection.type === "media"
                ? selection.normalizedSegments
                : [],
          retryLimit: 1,
        },
      });
      await transaction.objectStore("jobs").add(job);
      await transaction.objectStore("executionEvents").add(
        makeExecutionEvent({
          eventId: this.#id("evt"),
          profileId,
          jobId: job.jobId,
          captureId,
          type: "created",
          now,
        }),
      );
    }

    const result: MutationResult<{ capture: CaptureRecord; job?: JobRecord }> = {
      value: job ? { capture, job } : { capture },
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "capture.create",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #updateCaptureDraft(
    profileId: string,
    params: CaptureUpdateDraftParams,
  ): Promise<MutationResult<CaptureRecord>> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      ["captures", "attachments", "receipts", "meta"],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<MutationResult<CaptureRecord>>(
      receipts,
      profileId,
      "capture.updateDraft",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    const capture = await transaction.objectStore("captures").get(params.captureId);
    invariant(
      capture?.profileId === profileId,
      "NOT_FOUND",
      `Capture ${params.captureId} does not exist in this profile`,
    );
    if (capture.state !== "open") {
      throw new ClipperError(
        "CAPTURE_NOT_OPEN",
        "Draft observations cannot modify a sealed or interrupted capture",
        { captureId: capture.captureId, state: capture.state },
      );
    }
    const selection = appendObservations(capture.selection, params.observations);
    const attachmentIds = uniqueStrings([
      ...capture.attachmentIds,
      ...(params.observations.attachmentIds ?? []),
    ]);
    const attachmentsToLink: AttachmentRecord[] = [];
    for (const attachmentId of params.observations.attachmentIds ?? []) {
      const attachment = await transaction.objectStore("attachments").get(attachmentId);
      invariant(
        attachment?.profileId === profileId,
        "NOT_FOUND",
        `Attachment ${attachmentId} does not exist in this profile`,
      );
      if (attachment.captureId && attachment.captureId !== capture.captureId) {
        throw new ClipperError(
          "ATTACHMENT_CONFLICT",
          `Attachment ${attachmentId} already belongs to another capture`,
        );
      }
      attachmentsToLink.push(attachment);
    }
    const revision = await bumpRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    for (const attachment of attachmentsToLink) {
      await transaction.objectStore("attachments").put({
        ...attachment,
        captureId: capture.captureId,
        revision,
      });
    }
    const updated: CaptureRecord = {
      ...capture,
      selection,
      attachmentIds,
      plannedAcquisitionRanges:
        selection.type === "media"
          ? addPadding(
              selection.normalizedSegments,
              capture.padding.beforeSeconds,
              capture.padding.afterSeconds,
              capture.source.mediaDurationSeconds,
            )
          : [],
      revision,
    };
    await transaction.objectStore("captures").put(updated);
    const now = this.#timestamp();
    const result: MutationResult<CaptureRecord> = {
      value: updated,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "capture.updateDraft",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #finalizeCapture(
    profileId: string,
    params: CaptureFinalizeParams,
  ): Promise<MutationResult<{ capture: CaptureRecord; job?: JobRecord }>> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      ["captures", "jobs", "executionEvents", "attachments", "settings", "receipts", "meta"],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<MutationResult<{ capture: CaptureRecord; job?: JobRecord }>>(
      receipts,
      profileId,
      "capture.finalize",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    const capture = await transaction.objectStore("captures").get(params.captureId);
    invariant(
      capture?.profileId === profileId,
      "NOT_FOUND",
      `Capture ${params.captureId} does not exist in this profile`,
    );
    if (capture.state !== "open") {
      throw new ClipperError(
        "CAPTURE_IMMUTABLE",
        "Finalization cannot overwrite a sealed or interrupted capture",
        { captureId: capture.captureId, state: capture.state },
      );
    }
    let selection = appendObservations(capture.selection, params.completion.observations);
    invariant(selection.type === "media", "VALIDATION_ERROR", "Only media drafts can be finalized");
    if (params.completion.endClick) {
      selection = { ...selection, endClick: params.completion.endClick };
      const derived = selectionRanges(selection);
      selection = { ...selection, normalizedSegments: normalizeRanges(derived) };
    }
    if (params.completion.state === "sealed" && !selection.endClick) {
      throw new ClipperError(
        "CAPTURE_INCOMPLETE",
        "A sealed media capture requires the user's end-click fact",
      );
    }

    const settings =
      (await transaction.objectStore("settings").get(profileId)) ??
      defaultSettings(profileId, params.completion.endedAt, 0);
    const initialJobId =
      params.completion.state === "sealed" ? (capture.initialJobId ?? this.#id("job")) : undefined;
    const attachmentIds = uniqueStrings([
      ...capture.attachmentIds,
      ...(params.completion.observations?.attachmentIds ?? []),
    ]);
    const attachmentsToLink: AttachmentRecord[] = [];
    for (const attachmentId of params.completion.observations?.attachmentIds ?? []) {
      const attachment = await transaction.objectStore("attachments").get(attachmentId);
      invariant(
        attachment?.profileId === profileId,
        "NOT_FOUND",
        `Attachment ${attachmentId} does not exist in this profile`,
      );
      if (attachment.captureId && attachment.captureId !== capture.captureId) {
        throw new ClipperError(
          "ATTACHMENT_CONFLICT",
          `Attachment ${attachmentId} already belongs to another capture`,
        );
      }
      attachmentsToLink.push(attachment);
    }
    const revision = await bumpRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    for (const attachment of attachmentsToLink) {
      await transaction.objectStore("attachments").put({
        ...attachment,
        captureId: capture.captureId,
        revision,
      });
    }
    const updated: CaptureRecord = {
      ...capture,
      state: params.completion.state,
      ...(params.completion.state === "sealed"
        ? { sealedAt: params.completion.endedAt }
        : { interruptedAt: params.completion.endedAt }),
      selection,
      plannedAcquisitionRanges: addPadding(
        selection.normalizedSegments,
        capture.padding.beforeSeconds,
        capture.padding.afterSeconds,
        capture.source.mediaDurationSeconds,
      ),
      attachmentIds,
      assetsState: params.completion.assetsState ?? capture.assetsState,
      integrity: params.completion.integrity,
      ...(initialJobId ? { initialJobId } : {}),
      revision,
    };
    await transaction.objectStore("captures").put(updated);
    let job: JobRecord | undefined;
    if (initialJobId) {
      job = makePendingJob({
        jobId: initialJobId,
        capture: updated,
        now: params.completion.endedAt,
        revision,
        reason: "initial_processing",
        executionOptions: {
          acquisitionStrategy: "source_first",
          outputRangePolicy: settings.defaultOutputRangePolicy,
          requestedAcquisitionRanges: updated.plannedAcquisitionRanges,
          requestedOutputRanges:
            settings.defaultOutputRangePolicy === "padded"
              ? updated.plannedAcquisitionRanges
              : selection.normalizedSegments,
          retryLimit: 1,
        },
      });
      await transaction.objectStore("jobs").add(job);
      await transaction.objectStore("executionEvents").add(
        makeExecutionEvent({
          eventId: this.#id("evt"),
          profileId,
          jobId: job.jobId,
          captureId: capture.captureId,
          type: "created",
          now: params.completion.endedAt,
        }),
      );
    }
    const result: MutationResult<{ capture: CaptureRecord; job?: JobRecord }> = {
      value: job ? { capture: updated, job } : { capture: updated },
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "capture.finalize",
      params.requestId,
      requestFingerprint,
      result,
      params.completion.endedAt,
    );
    await transaction.done;
    return result;
  }

  async #listCaptures(
    profileId: string,
    params: CaptureListParams,
  ): Promise<CaptureListResult> {
    const database = await this.#databasePromise;
    const captures = (await database.getAll("captures"))
      .filter((capture) => capture.profileId === profileId)
      .map(redactCaptureRecordUrls);
    const jobs = (await database.getAll("jobs")).filter((job) => job.profileId === profileId);
    const jobsByCapture = new Map<string, JobRecord[]>();
    for (const job of jobs) {
      const list = jobsByCapture.get(job.captureId) ?? [];
      list.push(job);
      jobsByCapture.set(job.captureId, list);
    }
    for (const list of jobsByCapture.values()) {
      list.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    const requestedSourceKey = params.sourceKey && !params.sourceKey.includes("\u0000")
      ? redactUrlCredentials(params.sourceKey)
      : params.sourceKey;
    const filtered = captures
      .filter((capture) => {
        if (params.collection && capture.collection !== params.collection) return false;
        if (params.kinds && !params.kinds.includes(capture.kind)) return false;
        if (requestedSourceKey && capture.sourceKey !== requestedSourceKey) return false;
        if (params.createdFrom && capture.createdAt < params.createdFrom) return false;
        if (params.createdTo && capture.createdAt > params.createdTo) return false;
        const captureJobs = jobsByCapture.get(capture.captureId) ?? [];
        if (params.view === "pending") {
          return (
            capture.collection === "inbox" &&
            capture.state === "sealed" &&
            captureJobs.some((job) => job.status === "pending" || job.status === "processing")
          );
        }
        if (params.view === "history") {
          return captureJobs.some(
            (job) => job.status === "completed" || job.status === "failed",
          );
        }
        return true;
      })
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.captureId.localeCompare(left.captureId),
      );
    const afterCursor = params.cursor;
    const afterIndex = afterCursor
      ? filtered.findIndex(
          (capture) => `${capture.createdAt}\u0000${capture.captureId}` === afterCursor,
        )
      : -1;
    const startIndex = afterCursor ? Math.max(afterIndex + 1, 0) : 0;
    const page = filtered.slice(startIndex, startIndex + params.limit);
    const records: CaptureListItem[] = page.map((capture) => {
      const latestJob = jobsByCapture.get(capture.captureId)?.[0];
      return {
        captureId: capture.captureId,
        sourceKey: capture.sourceKey,
        kind: capture.kind,
        title: capture.source.title || capture.source.site,
        site: capture.source.site,
        preview: capturePreview(capture),
        state: capture.state,
        collection: capture.collection,
        assetsState: capture.assetsState,
        createdAt: capture.createdAt,
        ...(latestJob
          ? { latestJobId: latestJob.jobId, latestJobStatus: latestJob.status }
          : {}),
      };
    });
    const last = page.at(-1);
    const nextCursor =
      startIndex + page.length < filtered.length && last
        ? `${last.createdAt}\u0000${last.captureId}`
        : null;
    return {
      schemaVersion: CORE_SCHEMA_VERSION,
      profileId,
      records,
      nextCursor,
      revision: await this.#revision(profileId),
    };
  }

  async #getCapture(profileId: string, captureId: string): Promise<CaptureDetailResult> {
    const database = await this.#databasePromise;
    const capture = await database.get("captures", captureId);
    invariant(
      capture?.profileId === profileId,
      "NOT_FOUND",
      `Capture ${captureId} does not exist in this profile`,
    );
    const [jobs, results, events, attachments] = await Promise.all([
      database.getAllFromIndex("jobs", "by-capture", captureId),
      database.getAllFromIndex("results", "by-capture", captureId),
      database.getAllFromIndex("executionEvents", "by-capture", captureId),
      database.getAllFromIndex("attachments", "by-capture", captureId),
    ]);
    jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    results.sort((left, right) => left.completedAt.localeCompare(right.completedAt));
    events.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {
      capture: redactCaptureRecordUrls(capture),
      jobs,
      results,
      events,
      attachments: attachments.map(withEffectiveAttachmentAvailability),
    };
  }

  async #getJob(profileId: string, jobId: string): Promise<JobRecord> {
    const database = await this.#databasePromise;
    const job = await database.get("jobs", jobId);
    invariant(
      job?.profileId === profileId,
      "NOT_FOUND",
      `Job ${jobId} does not exist in this profile`,
    );
    return job;
  }

  async #claimJobs(
    profileId: string,
    params: JobClaimParams,
    contextDirectory?: string,
  ): Promise<ClaimBatchResult> {
    if (new Set(params.jobIds).size !== params.jobIds.length) {
      throw new ClipperError("VALIDATION_ERROR", "jobIds must not contain duplicates");
    }
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      ["jobs", "captures", "executionEvents", "settings", "receipts", "meta"],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<ClaimBatchResult>(
      receipts,
      profileId,
      "job.claim",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    const now = this.#timestamp();
    const settings =
      (await transaction.objectStore("settings").get(profileId)) ??
      defaultSettings(profileId, now, 0);
    const directory = resolveOutputDirectory({
      task: params.taskOutputDirectory,
      connection: contextDirectory ?? params.connectionOutputDirectory,
      global: settings.globalOutputDirectory,
    });
    if (params.requireOutputDirectory && !directory.path) {
      throw new ClipperError(
        "OUTPUT_DIRECTORY_REQUIRED",
        "No task, connection, or global output directory is configured",
      );
    }
    const revisionBefore = await currentRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    let revision = revisionBefore;
    const accepted: { job: JobRecord; event: ExecutionEvent }[] = [];
    const items: ClaimBatchResult["items"][number][] = [];
    for (const jobId of params.jobIds) {
      const job = await transaction.objectStore("jobs").get(jobId);
      if (!job || job.profileId !== profileId) {
        items.push({ jobId, disposition: "not_found" });
        continue;
      }
      if (job.status === "processing") {
        items.push({ jobId, disposition: "already_claimed", reason: "job_is_processing" });
        continue;
      }
      if (job.status !== "pending") {
        items.push({ jobId, disposition: "not_eligible", reason: `job_is_${job.status}` });
        continue;
      }
      const capture = await transaction.objectStore("captures").get(job.captureId);
      if (!capture || capture.profileId !== profileId) {
        items.push({ jobId, disposition: "not_eligible", reason: "capture_missing" });
        continue;
      }
      if (capture.state !== "sealed") {
        items.push({ jobId, disposition: "not_eligible", reason: "capture_not_sealed" });
        continue;
      }
      if (capture.collection !== "inbox") {
        items.push({ jobId, disposition: "not_eligible", reason: "capture_saved_only" });
        continue;
      }
      if (revision === revisionBefore) {
        revision = await bumpRevision(
          transaction.objectStore("meta") as unknown as MetaStoreLike,
          profileId,
        );
      }
      const claimToken = this.#id("claim");
      const updated: JobRecord = {
        ...job,
        status: "processing",
        updatedAt: now,
        executionOptions: mergeExecutionOptions(job.executionOptions, params.execution, capture),
        directory,
        claim: {
          workerId: params.agentId,
          claimToken,
          requestId: params.requestId,
          claimedAt: now,
          lastHeartbeatAt: now,
        },
        executionState: "active",
        revision,
      };
      const event = makeExecutionEvent({
        eventId: this.#id("evt"),
        profileId,
        jobId,
        captureId: job.captureId,
        type: "claimed",
        now,
        workerId: params.agentId,
      });
      accepted.push({ job: updated, event });
      items.push({ jobId, disposition: "accepted", claimToken, job: updated });
    }
    for (const item of accepted) {
      await transaction.objectStore("jobs").put(item.job);
      await transaction.objectStore("executionEvents").add(item.event);
    }
    const result: ClaimBatchResult = {
      items,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "job.claim",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #heartbeat(
    profileId: string,
    params: JobHeartbeatParams,
  ): Promise<MutationResult<JobRecord>> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      ["jobs", "executionEvents", "receipts", "meta"],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<MutationResult<JobRecord>>(
      receipts,
      profileId,
      "job.heartbeat",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    const job = await transaction.objectStore("jobs").get(params.jobId);
    invariant(job?.profileId === profileId, "NOT_FOUND", `Job ${params.jobId} was not found`);
    invariant(job.status === "processing", "NOT_ELIGIBLE", "Only processing jobs accept heartbeats");
    invariant(
      job.claim?.claimToken === params.claimToken,
      "CLAIM_TOKEN_INVALID",
      "The claim token does not own this job",
    );
    const retryLimit = job.executionOptions.retryLimit ?? 1;
    if (params.retryCount !== undefined && params.retryCount > retryLimit) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "Heartbeat retry count exceeds the job's snapshotted retry limit",
        { retryCount: params.retryCount, retryLimit },
      );
    }
    const now = this.#timestamp();
    const revision = await bumpRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    const updated: JobRecord = {
      ...job,
      updatedAt: now,
      executionState: params.state,
      claim: { ...job.claim, lastHeartbeatAt: now },
      revision,
    };
    await transaction.objectStore("jobs").put(updated);
    await transaction.objectStore("executionEvents").add(
      makeExecutionEvent({
        eventId: this.#id("evt"),
        profileId,
        jobId: job.jobId,
        captureId: job.captureId,
        type:
          params.state === "uncertain"
            ? "uncertain"
            : params.retryCount !== undefined && params.retryCount > 0
              ? "retry"
              : "heartbeat",
        now,
        workerId: job.claim.workerId,
        stage: params.stage,
        retryCount: params.retryCount,
        message: params.message,
      }),
    );
    const result: MutationResult<JobRecord> = {
      value: updated,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "job.heartbeat",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  #assertRequiredOutputs(job: JobRecord, params: JobCompleteParams): void {
    if (params.outcome !== "completed") return;
    const requested = job.executionOptions.outputs;
    if (!requested) return;
    const artifacts = params.artifacts;
    if (
      requested.videoWithAudio &&
      !artifacts.some(
        (artifact) =>
          artifact.kind === "video" && artifact.hasVideo === true && artifact.hasAudio === true,
      )
    ) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "A completed result is missing the requested video and audio tracks",
      );
    }
    if (
      requested.separateAudio &&
      !artifacts.some((artifact) => artifact.kind === "audio")
    ) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "A completed result is missing the requested separate audio artifact",
      );
    }
    if (
      requested.frames?.enabled &&
      !artifacts.some((artifact) => artifact.kind === "frame")
    ) {
      throw new ClipperError("VALIDATION_ERROR", "A completed result is missing requested frames");
    }
    if (requested.text && !artifacts.some((artifact) => artifact.kind === "text")) {
      throw new ClipperError("VALIDATION_ERROR", "A completed result is missing requested text");
    }
    if (
      requested.images &&
      !artifacts.some((artifact) => artifact.kind === "image" || artifact.kind === "frame")
    ) {
      throw new ClipperError("VALIDATION_ERROR", "A completed result is missing requested images");
    }
  }

  async #completeJob(
    profileId: string,
    params: JobCompleteParams,
  ): Promise<CompleteJobResult> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      ["jobs", "results", "executionEvents", "attachments", "receipts", "meta"],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<CompleteJobResult>(
      receipts,
      profileId,
      "job.complete",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    const job = await transaction.objectStore("jobs").get(params.jobId);
    invariant(job?.profileId === profileId, "NOT_FOUND", `Job ${params.jobId} was not found`);
    invariant(
      job.claim?.claimToken === params.claimToken,
      "CLAIM_TOKEN_INVALID",
      "The claim token does not own this job",
    );
    const completionFingerprint = fingerprint({
      jobId: params.jobId,
      outcome: params.outcome,
      acquisitionMethod: params.acquisitionMethod,
      requestedRanges: params.requestedRanges,
      acquiredRanges: params.acquiredRanges,
      outputRanges: params.outputRanges,
      paddingInFinalOutput: params.paddingInFinalOutput,
      artifacts: params.artifacts,
      verification: params.verification,
      failure: params.failure,
    });
    const existing = await transaction.objectStore("results").index("by-job").get(job.jobId);
    if (existing) {
      if (existing.completionFingerprint !== completionFingerprint) {
        throw new ClipperError(
          "RESULT_CONFLICT",
          "A different terminal result is already stored for this job",
          { jobId: job.jobId, resultId: existing.resultId },
        );
      }
      const currentRevisionValue = await currentRevision(
        transaction.objectStore("meta") as unknown as MetaStoreLike,
        profileId,
      );
      const result: CompleteJobResult = {
        job,
        result: existing,
        ack: { persisted: true, revision: currentRevisionValue },
      };
      await saveReceipt(
        receipts,
        profileId,
        "job.complete",
        params.requestId,
        requestFingerprint,
        result,
        this.#timestamp(),
      );
      await transaction.done;
      return result;
    }
    invariant(job.status === "processing", "NOT_ELIGIBLE", "Only processing jobs can complete");
    if (
      params.failure &&
      params.failure.retryCount > (job.executionOptions.retryLimit ?? 1)
    ) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "Failure retry count exceeds the job's snapshotted retry limit",
        {
          retryCount: params.failure.retryCount,
          retryLimit: job.executionOptions.retryLimit ?? 1,
        },
      );
    }
    for (const artifact of params.artifacts) {
      if (!artifact.attachmentId) continue;
      const attachment = await transaction.objectStore("attachments").get(artifact.attachmentId);
      invariant(
        attachment?.profileId === profileId,
        "NOT_FOUND",
        `Result attachment ${artifact.attachmentId} was not found`,
      );
      if (attachment.captureId && attachment.captureId !== job.captureId) {
        throw new ClipperError(
          "ATTACHMENT_CONFLICT",
          "Result attachment belongs to another capture",
          { attachmentId: attachment.attachmentId },
        );
      }
      if (attachment.jobId && attachment.jobId !== job.jobId) {
        throw new ClipperError(
          "ATTACHMENT_CONFLICT",
          "Result attachment belongs to another job",
          { attachmentId: attachment.attachmentId },
        );
      }
      if (attachment.status === "writing") {
        throw new ClipperError(
          "ATTACHMENT_NOT_COMPLETE",
          "A writing attachment cannot be committed as a terminal result",
          { attachmentId: attachment.attachmentId },
        );
      }
    }
    this.#assertRequiredOutputs(job, params);
    const now = this.#timestamp();
    const revision = await bumpRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    const resultId = this.#id("result");
    const terminal: ResultRecord = {
      resultId,
      profileId,
      jobId: job.jobId,
      captureId: job.captureId,
      status: params.outcome,
      completedAt: now,
      ...(params.acquisitionMethod ? { acquisitionMethod: params.acquisitionMethod } : {}),
      requestedRanges: normalizeRanges(params.requestedRanges),
      acquiredRanges: normalizeRanges(params.acquiredRanges),
      outputRanges: normalizeRanges(params.outputRanges),
      ...(params.paddingInFinalOutput !== undefined
        ? { paddingInFinalOutput: params.paddingInFinalOutput }
        : {}),
      artifacts: params.artifacts,
      verification: params.verification,
      ...(params.failure ? { failure: params.failure } : {}),
      completionFingerprint,
      revision,
    };
    const updated: JobRecord = {
      ...job,
      status: params.outcome,
      updatedAt: now,
      executionState: "active",
      resultId,
      ...(params.failure ? { failure: params.failure } : {}),
      revision,
    };
    await transaction.objectStore("results").add(terminal);
    await transaction.objectStore("jobs").put(updated);
    await transaction.objectStore("executionEvents").add(
      makeExecutionEvent({
        eventId: this.#id("evt"),
        profileId,
        jobId: job.jobId,
        captureId: job.captureId,
        type: params.outcome,
        now,
        workerId: job.claim.workerId,
        stage: params.failure?.stage,
        retryCount: params.failure?.retryCount,
        message: params.failure?.message,
      }),
    );
    const response: CompleteJobResult = {
      job: updated,
      result: terminal,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "job.complete",
      params.requestId,
      requestFingerprint,
      response,
      now,
    );
    await transaction.done;
    return response;
  }

  async #reprocess(
    profileId: string,
    params: JobReprocessParams,
  ): Promise<MutationResult<JobRecord>> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      ["captures", "jobs", "executionEvents", "receipts", "meta"],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<MutationResult<JobRecord>>(
      receipts,
      profileId,
      "job.reprocess",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    const capture = await transaction.objectStore("captures").get(params.captureId);
    invariant(
      capture?.profileId === profileId,
      "NOT_FOUND",
      `Capture ${params.captureId} was not found`,
    );
    if (capture.state === "open") {
      throw new ClipperError("CAPTURE_INCOMPLETE", "An open capture cannot be reprocessed");
    }
    if (
      capture.state === "interrupted" &&
      !(params.execution?.requestedAcquisitionRanges?.length ||
        params.execution?.requestedOutputRanges?.length)
    ) {
      throw new ClipperError(
        "CAPTURE_INCOMPLETE",
        "An interrupted capture needs an explicit execution range",
      );
    }
    const existingJobs = await transaction.objectStore("jobs").index("by-capture").getAll(capture.captureId);
    existingJobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const parent = params.parentJobId
      ? existingJobs.find((job) => job.jobId === params.parentJobId)
      : existingJobs.find((job) => job.status === "completed" || job.status === "failed");
    if (params.parentJobId && !parent) {
      throw new ClipperError("NOT_FOUND", "The requested parent job was not found on this capture");
    }
    if (parent && parent.status !== "completed" && parent.status !== "failed") {
      throw new ClipperError(
        "NOT_ELIGIBLE",
        "Reprocessing requires a terminal parent job",
        { parentJobId: parent.jobId, status: parent.status },
      );
    }
    const now = this.#timestamp();
    const revision = await bumpRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    const baseOptions: ExecutionOptions = parent?.executionOptions ?? {
      acquisitionStrategy: "source_first",
      outputRangePolicy: "padded",
      requestedAcquisitionRanges: capture.plannedAcquisitionRanges,
      requestedOutputRanges: capture.plannedAcquisitionRanges,
      retryLimit: 1,
    };
    const job = makePendingJob({
      jobId: this.#id("job"),
      capture,
      now,
      revision,
      reason: "reprocess",
      parentJobId: parent?.jobId,
      executionOptions: mergeExecutionOptions(baseOptions, params.execution, capture),
    });
    await transaction.objectStore("jobs").add(job);
    await transaction.objectStore("executionEvents").add(
      makeExecutionEvent({
        eventId: this.#id("evt"),
        profileId,
        jobId: job.jobId,
        captureId: capture.captureId,
        type: "created",
        now,
      }),
    );
    const result: MutationResult<JobRecord> = {
      value: job,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "job.reprocess",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #setCollection(
    profileId: string,
    params: SetCollectionParams,
  ): Promise<MutationResult<CaptureRecord>> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(["captures", "receipts", "meta"], "readwrite");
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<MutationResult<CaptureRecord>>(
      receipts,
      profileId,
      "library.setCollection",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    const capture = await transaction.objectStore("captures").get(params.captureId);
    invariant(
      capture?.profileId === profileId,
      "NOT_FOUND",
      `Capture ${params.captureId} was not found`,
    );
    const now = this.#timestamp();
    let revision = capture.revision;
    let updated = capture;
    if (capture.collection !== params.collection) {
      revision = await bumpRevision(
        transaction.objectStore("meta") as unknown as MetaStoreLike,
        profileId,
      );
      updated = { ...capture, collection: params.collection, revision };
      await transaction.objectStore("captures").put(updated);
    }
    const result: MutationResult<CaptureRecord> = {
      value: redactCaptureRecordUrls(updated),
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "library.setCollection",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #cleanupPreview(
    profileId: string,
    params: CleanupPreviewParams,
  ): Promise<CleanupPreviewResult> {
    return this.#cleanupPreviewImpl(profileId, params);
  }

  async #cleanupCommit(
    profileId: string,
    params: CleanupCommitParams,
  ): Promise<CleanupCommitResult> {
    return this.#cleanupCommitImpl(profileId, params);
  }

  async #createAttachment(
    profileId: string,
    params: AttachmentCreateParams,
  ): Promise<MutationResult<AttachmentRecord>> {
    return this.#createAttachmentImpl(profileId, params);
  }

  async #appendAttachmentChunk(
    profileId: string,
    params: AttachmentAppendParams,
  ): Promise<MutationResult<AttachmentRecord>> {
    return this.#appendAttachmentChunkImpl(profileId, params);
  }

  async #completeAttachment(
    profileId: string,
    params: AttachmentCompleteParams,
  ): Promise<MutationResult<AttachmentRecord>> {
    return this.#completeAttachmentImpl(profileId, params);
  }

  async #getAttachment(
    profileId: string,
    params: AttachmentGetParams,
  ): Promise<AttachmentGetResult> {
    return this.#getAttachmentImpl(profileId, params);
  }

  async #getSettings(profileId: string): Promise<ClipperSettings> {
    return this.#settingsForRead(profileId);
  }

  async #updateSettings(
    profileId: string,
    params: SettingsUpdateParams,
  ): Promise<MutationResult<ClipperSettings>> {
    return this.#updateSettingsImpl(profileId, params);
  }

  async #exportBackup(profileId: string, includeData: boolean): Promise<BackupBundle> {
    return this.#exportBackupImpl(profileId, includeData);
  }

  async #importBackup(
    profileId: string,
    params: BackupImportParams,
  ): Promise<BackupImportResult> {
    return this.#importBackupImpl(profileId, params);
  }

  async #diagnostics(profileId: string): Promise<DiagnosticsResult> {
    return this.#diagnosticsImpl(profileId);
  }

  async #connectionStatus(profileId: string): Promise<ConnectionStatusResult> {
    const revision = await this.#revision(profileId);
    return {
      browserAvailable: this.#browserAvailable(),
      databaseAvailable: true,
      profileId,
      revision,
      capabilities: {
        methods: CORE_METHODS,
        maxAttachmentChunkBytes: MAX_ATTACHMENT_CHUNK_BYTES,
        fourJobStates: true,
      },
    };
  }

  async #cleanupPreviewImpl(
    profileId: string,
    params: CleanupPreviewParams,
  ): Promise<CleanupPreviewResult> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      [
        "captures",
        "jobs",
        "results",
        "executionEvents",
        "attachments",
        "cleanupPreviews",
        "receipts",
        "meta",
      ],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<CleanupPreviewResult>(
      receipts,
      profileId,
      "library.cleanupPreview",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }

    const allCaptures = await transaction.objectStore("captures").getAll();
    const requestedIds =
      params.scope === "capture_ids"
        ? uniqueStrings(params.captureIds ?? [])
        : allCaptures
            .filter((capture) => capture.profileId === profileId)
            .map((capture) => capture.captureId);
    const candidates: CleanupCandidate[] = [];
    const skipped: CleanupSkipped[] = [];
    const captureRevisions: Record<string, number> = {};
    const relationFingerprints: Record<string, string> = {};

    for (const captureId of requestedIds) {
      const capture = allCaptures.find((item) => item.captureId === captureId);
      if (!capture) {
        skipped.push({ captureId, reason: "not_found" });
        continue;
      }
      if (capture.profileId !== profileId) {
        skipped.push({ captureId, reason: "profile_mismatch" });
        continue;
      }
      const [jobs, results, events, attachments] = await Promise.all([
        transaction.objectStore("jobs").index("by-capture").getAll(captureId),
        transaction.objectStore("results").index("by-capture").getAll(captureId),
        transaction.objectStore("executionEvents").index("by-capture").getAll(captureId),
        transaction.objectStore("attachments").index("by-capture").getAll(captureId),
      ]);
      if (jobs.some((job) => job.status === "pending" || job.status === "processing")) {
        skipped.push({ captureId, reason: "active_job" });
        continue;
      }
      jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const latest = jobs[0];
      const terminalEligible =
        latest?.status === "completed" || (params.includeFailed && latest?.status === "failed");
      if (!terminalEligible) {
        skipped.push({ captureId, reason: "not_processed" });
        continue;
      }
      candidates.push({
        captureId,
        jobCount: jobs.length,
        resultCount: results.length,
        attachmentCount: attachments.length,
        captureRevision: capture.revision,
      });
      captureRevisions[captureId] = capture.revision;
      relationFingerprints[captureId] = fingerprint({
        jobs: jobs.map((job) => ({ id: job.jobId, status: job.status, revision: job.revision })),
        results: results.map((result) => ({ id: result.resultId, revision: result.revision })),
        events: events.map((event) => event.eventId).sort(),
        attachments: attachments
          .map((attachment) => ({ id: attachment.attachmentId, revision: attachment.revision }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      });
    }

    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + CLEANUP_TOKEN_TTL_MS).toISOString();
    const cleanupToken = this.#id("cleanup");
    const snapshot: CleanupSnapshotRecord = {
      cleanupToken,
      profileId,
      createdAt: now,
      expiresAt,
      captureRevisions,
      relationFingerprints,
      captureIds: candidates.map((candidate) => candidate.captureId),
    };
    await transaction.objectStore("cleanupPreviews").add(snapshot);
    const revision = await currentRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    const result: CleanupPreviewResult = {
      cleanupToken,
      expiresAt,
      candidates,
      skipped,
      externalFilesPreserved: true,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "library.cleanupPreview",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #cleanupCommitImpl(
    profileId: string,
    params: CleanupCommitParams,
  ): Promise<CleanupCommitResult> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      [
        "captures",
        "jobs",
        "results",
        "executionEvents",
        "attachments",
        "attachmentChunks",
        "cleanupPreviews",
        "receipts",
        "meta",
      ],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<CleanupCommitResult>(
      receipts,
      profileId,
      "library.cleanupCommit",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    const snapshot = await transaction.objectStore("cleanupPreviews").get(params.cleanupToken);
    invariant(
      snapshot?.profileId === profileId,
      "NOT_FOUND",
      "The cleanup preview token does not exist in this profile",
    );
    if (Date.parse(snapshot.expiresAt) <= this.#now().getTime()) {
      throw new ClipperError("CLEANUP_TOKEN_EXPIRED", "The cleanup preview has expired");
    }

    const relations = new Map<
      string,
      {
        capture: CaptureRecord;
        jobs: JobRecord[];
        results: ResultRecord[];
        events: ExecutionEvent[];
        attachments: AttachmentRecord[];
      }
    >();
    for (const captureId of snapshot.captureIds) {
      const capture = await transaction.objectStore("captures").get(captureId);
      if (!capture || capture.profileId !== profileId) {
        throw new ClipperError(
          "CLEANUP_CONFLICT",
          "A cleanup candidate changed after preview",
          { captureId, reason: "capture_missing" },
        );
      }
      if (capture.revision !== snapshot.captureRevisions[captureId]) {
        throw new ClipperError(
          "CLEANUP_CONFLICT",
          "A cleanup candidate changed after preview",
          { captureId, reason: "capture_changed" },
        );
      }
      const [jobs, results, events, attachments] = await Promise.all([
        transaction.objectStore("jobs").index("by-capture").getAll(captureId),
        transaction.objectStore("results").index("by-capture").getAll(captureId),
        transaction.objectStore("executionEvents").index("by-capture").getAll(captureId),
        transaction.objectStore("attachments").index("by-capture").getAll(captureId),
      ]);
      if (jobs.some((job) => job.status === "pending" || job.status === "processing")) {
        throw new ClipperError(
          "CLEANUP_CONFLICT",
          "A cleanup candidate now has an active task",
          { captureId, reason: "active_job" },
        );
      }
      const currentFingerprint = fingerprint({
        jobs: [...jobs]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map((job) => ({ id: job.jobId, status: job.status, revision: job.revision })),
        results: results.map((result) => ({ id: result.resultId, revision: result.revision })),
        events: events.map((event) => event.eventId).sort(),
        attachments: attachments
          .map((attachment) => ({ id: attachment.attachmentId, revision: attachment.revision }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      });
      if (currentFingerprint !== snapshot.relationFingerprints[captureId]) {
        throw new ClipperError(
          "CLEANUP_CONFLICT",
          "A cleanup candidate gained new history after preview",
          { captureId, reason: "relations_changed" },
        );
      }
      relations.set(captureId, { capture, jobs, results, events, attachments });
    }

    let deletedJobCount = 0;
    let deletedResultCount = 0;
    let deletedEventCount = 0;
    let deletedAttachmentRecords = 0;
    const deletedEntityIds = new Set<string>();
    for (const [captureId, related] of relations) {
      deletedEntityIds.add(captureId);
      for (const job of related.jobs) deletedEntityIds.add(job.jobId);
      for (const result of related.results) deletedEntityIds.add(result.resultId);
      const attachmentIds = new Set(related.attachments.map((item) => item.attachmentId));
      for (const result of related.results) {
        for (const artifact of result.artifacts) {
          if (artifact.attachmentId) attachmentIds.add(artifact.attachmentId);
        }
      }
      for (const attachmentId of attachmentIds) {
        const attachment = await transaction.objectStore("attachments").get(attachmentId);
        if (!attachment || attachment.profileId !== profileId) continue;
        const referencedElsewhere = (await transaction.objectStore("captures").getAll()).some(
          (other) =>
            other.captureId !== captureId && other.attachmentIds.includes(attachmentId),
        );
        const referencedByOtherResult = (await transaction.objectStore("results").getAll()).some(
          (other) =>
            other.captureId !== captureId &&
            other.artifacts.some((artifact) => artifact.attachmentId === attachmentId),
        );
        if (referencedElsewhere || referencedByOtherResult) continue;
        deletedEntityIds.add(attachmentId);
        const chunks = await transaction
          .objectStore("attachmentChunks")
          .index("by-attachment")
          .getAllKeys(attachmentId);
        for (const chunkKey of chunks) {
          await transaction.objectStore("attachmentChunks").delete(chunkKey);
        }
        await transaction.objectStore("attachments").delete(attachmentId);
        deletedAttachmentRecords += 1;
      }
      for (const event of related.events) {
        await transaction.objectStore("executionEvents").delete(event.eventId);
        deletedEventCount += 1;
      }
      for (const result of related.results) {
        await transaction.objectStore("results").delete(result.resultId);
        deletedResultCount += 1;
      }
      for (const job of related.jobs) {
        await transaction.objectStore("jobs").delete(job.jobId);
        deletedJobCount += 1;
      }
      await transaction.objectStore("captures").delete(captureId);
    }
    const profileReceipts = (await transaction.objectStore("receipts").getAll()).filter(
      (receipt) => receipt.profileId === profileId,
    );
    for (const receipt of profileReceipts) {
      if (responseReferencesEntityIds(receipt.response, deletedEntityIds)) {
        await transaction.objectStore("receipts").delete(receipt.receiptKey);
      }
    }
    const profilePreviews = (await transaction.objectStore("cleanupPreviews").getAll()).filter(
      (preview) => preview.profileId === profileId,
    );
    for (const preview of profilePreviews) {
      if (preview.captureIds.some((captureId) => deletedEntityIds.has(captureId))) {
        await transaction.objectStore("cleanupPreviews").delete(preview.cleanupToken);
      }
    }
    await transaction.objectStore("cleanupPreviews").delete(snapshot.cleanupToken);
    const revision =
      relations.size > 0
        ? await bumpRevision(
            transaction.objectStore("meta") as unknown as MetaStoreLike,
            profileId,
          )
        : await currentRevision(
            transaction.objectStore("meta") as unknown as MetaStoreLike,
            profileId,
          );
    const now = this.#timestamp();
    const result: CleanupCommitResult = {
      deletedCaptureIds: [...relations.keys()],
      deletedJobCount,
      deletedResultCount,
      deletedEventCount,
      deletedAttachmentRecords,
      externalFilesPreserved: true,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "library.cleanupCommit",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #createAttachmentImpl(
    profileId: string,
    params: AttachmentCreateParams,
  ): Promise<MutationResult<AttachmentRecord>> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      ["attachments", "captures", "jobs", "settings", "receipts", "meta"],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<MutationResult<AttachmentRecord>>(
      receipts,
      profileId,
      "attachment.create",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    if (params.captureId) {
      const capture = await transaction.objectStore("captures").get(params.captureId);
      invariant(
        capture?.profileId === profileId,
        "NOT_FOUND",
        `Capture ${params.captureId} was not found`,
      );
    }
    if (params.jobId) {
      const job = await transaction.objectStore("jobs").get(params.jobId);
      invariant(job?.profileId === profileId, "NOT_FOUND", `Job ${params.jobId} was not found`);
      if (params.captureId && job.captureId !== params.captureId) {
        throw new ClipperError(
          "ATTACHMENT_CONFLICT",
          "Attachment job and capture references do not match",
        );
      }
    }
    const now = this.#timestamp();
    const settings =
      (await transaction.objectStore("settings").get(profileId)) ??
      defaultSettings(profileId, now, 0);
    if (params.storage === "chunked" && params.expectedTotalBytes !== undefined) {
      if (params.expectedTotalBytes > settings.maxAttachmentBytes) {
        throw new ClipperError(
          "STORAGE_BUDGET_EXCEEDED",
          "Expected attachment size exceeds the profile attachment budget",
          {
            expectedTotalBytes: params.expectedTotalBytes,
            maxAttachmentBytes: settings.maxAttachmentBytes,
          },
        );
      }
      if (
        params.kind === "browser_recording" &&
        params.expectedTotalBytes > settings.maxRecordingBytes
      ) {
        throw new ClipperError(
          "STORAGE_BUDGET_EXCEEDED",
          "Expected recording size exceeds the recording budget",
          {
            expectedTotalBytes: params.expectedTotalBytes,
            maxRecordingBytes: settings.maxRecordingBytes,
          },
        );
      }
    }
    if (params.fileReference && /[\u0000-\u001f\u007f]/u.test(params.fileReference)) {
      throw new ClipperError("VALIDATION_ERROR", "External file reference contains control characters");
    }
    const revision = await bumpRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    const attachment: AttachmentRecord = {
      attachmentId: this.#id("asset"),
      profileId,
      ...(params.captureId ? { captureId: params.captureId } : {}),
      ...(params.jobId ? { jobId: params.jobId } : {}),
      kind: params.kind,
      mimeType: params.mimeType,
      storage: params.storage,
      dataAvailable: params.storage === "chunked",
      status: params.storage === "external" ? "complete" : "writing",
      byteLength:
        params.storage === "external" ? (params.expectedTotalBytes ?? 0) : 0,
      ...(params.expectedTotalBytes !== undefined
        ? { expectedTotalBytes: params.expectedTotalBytes }
        : {}),
      ...(params.fileReference ? { fileReference: params.fileReference } : {}),
      createdAt: now,
      ...(params.storage === "external" ? { completedAt: now } : {}),
      revision,
    };
    await transaction.objectStore("attachments").add(attachment);
    const result: MutationResult<AttachmentRecord> = {
      value: attachment,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "attachment.create",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #appendAttachmentChunkImpl(
    profileId: string,
    params: AttachmentAppendParams,
  ): Promise<MutationResult<AttachmentRecord>> {
    const bytes = base64ToBytes(params.dataBase64);
    if (bytes.byteLength > MAX_ATTACHMENT_CHUNK_BYTES) {
      throw new ClipperError(
        "ATTACHMENT_CHUNK_TOO_LARGE",
        `Attachment chunks are limited to ${MAX_ATTACHMENT_CHUNK_BYTES} raw bytes`,
        { receivedBytes: bytes.byteLength, maxBytes: MAX_ATTACHMENT_CHUNK_BYTES },
      );
    }
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      ["attachments", "attachmentChunks", "settings", "receipts", "meta"],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<MutationResult<AttachmentRecord>>(
      receipts,
      profileId,
      "attachment.appendChunk",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    const attachment = await transaction.objectStore("attachments").get(params.attachmentId);
    invariant(
      attachment?.profileId === profileId,
      "NOT_FOUND",
      `Attachment ${params.attachmentId} was not found`,
    );
    invariant(
      attachment.storage === "chunked",
      "ATTACHMENT_CONFLICT",
      "External file references do not accept data chunks",
    );
    invariant(
      attachment.status === "writing",
      "ATTACHMENT_CONFLICT",
      "A completed or interrupted attachment is immutable",
    );
    const now = this.#timestamp();
    const settings =
      (await transaction.objectStore("settings").get(profileId)) ??
      defaultSettings(profileId, now, 0);
    const existingChunk = await transaction
      .objectStore("attachmentChunks")
      .get([attachment.attachmentId, params.offset]);
    if (params.offset !== attachment.byteLength) {
      if (existingChunk) {
        const existingBytes = new Uint8Array(existingChunk.data);
        const identical =
          existingBytes.byteLength === bytes.byteLength &&
          existingBytes.every((value, index) => value === bytes[index]);
        if (identical) {
          const revision = await currentRevision(
            transaction.objectStore("meta") as unknown as MetaStoreLike,
            profileId,
          );
          const result: MutationResult<AttachmentRecord> = {
            value: attachment,
            ack: { persisted: true, revision },
          };
          await saveReceipt(
            receipts,
            profileId,
            "attachment.appendChunk",
            params.requestId,
            requestFingerprint,
            result,
            now,
          );
          await transaction.done;
          return result;
        }
      }
      throw new ClipperError(
        "ATTACHMENT_CONFLICT",
        "Attachment chunks must be appended at the exact current offset",
        { expectedOffset: attachment.byteLength, receivedOffset: params.offset },
      );
    }
    const nextAttachmentBytes = attachment.byteLength + bytes.byteLength;
    if (
      attachment.expectedTotalBytes !== undefined &&
      nextAttachmentBytes > attachment.expectedTotalBytes
    ) {
      throw new ClipperError(
        "ATTACHMENT_CONFLICT",
        "Appended data exceeds the declared attachment size",
        {
          expectedTotalBytes: attachment.expectedTotalBytes,
          attemptedBytes: nextAttachmentBytes,
        },
      );
    }
    if (
      attachment.kind === "browser_recording" &&
      nextAttachmentBytes > settings.maxRecordingBytes
    ) {
      throw new ClipperError(
        "STORAGE_BUDGET_EXCEEDED",
        "Recording byte budget reached; existing chunks were preserved",
        {
          maxRecordingBytes: settings.maxRecordingBytes,
          currentBytes: attachment.byteLength,
          attemptedBytes: nextAttachmentBytes,
        },
      );
    }
    const profileInternalBytes = (await transaction.objectStore("attachments").getAll())
      .filter((item) => item.profileId === profileId && item.storage === "chunked")
      .reduce((sum, item) => sum + item.byteLength, 0);
    if (profileInternalBytes + bytes.byteLength > settings.maxAttachmentBytes) {
      throw new ClipperError(
        "STORAGE_BUDGET_EXCEEDED",
        "Profile attachment budget reached; existing history was preserved",
        {
          maxAttachmentBytes: settings.maxAttachmentBytes,
          currentBytes: profileInternalBytes,
          attemptedAdditionalBytes: bytes.byteLength,
        },
      );
    }
    const revision = await bumpRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    const chunk: AttachmentChunkRecord = {
      attachmentId: attachment.attachmentId,
      offset: params.offset,
      byteLength: bytes.byteLength,
      data: ownedArrayBuffer(bytes),
    };
    const updated: AttachmentRecord = {
      ...attachment,
      byteLength: nextAttachmentBytes,
      revision,
    };
    await transaction.objectStore("attachmentChunks").add(chunk);
    await transaction.objectStore("attachments").put(updated);
    const result: MutationResult<AttachmentRecord> = {
      value: updated,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "attachment.appendChunk",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #completeAttachmentImpl(
    profileId: string,
    params: AttachmentCompleteParams,
  ): Promise<MutationResult<AttachmentRecord>> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      ["attachments", "receipts", "meta"],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<MutationResult<AttachmentRecord>>(
      receipts,
      profileId,
      "attachment.complete",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return {
        ...replay,
        value: withEffectiveAttachmentAvailability(replay.value),
      };
    }
    const attachment = await transaction.objectStore("attachments").get(params.attachmentId);
    invariant(
      attachment?.profileId === profileId,
      "NOT_FOUND",
      `Attachment ${params.attachmentId} was not found`,
    );
    invariant(
      attachment.storage === "chunked",
      "ATTACHMENT_CONFLICT",
      "External references are already complete",
    );
    if ((params.recordingCoverage || params.recordingFailure) && attachment.kind !== "browser_recording") {
      throw new ClipperError(
        "ATTACHMENT_CONFLICT",
        "Recording facts can only be stored on a browser recording",
      );
    }
    if (attachment.byteLength !== params.totalBytes) {
      throw new ClipperError(
        "ATTACHMENT_CONFLICT",
        "Final attachment size does not match persisted chunks",
        { persistedBytes: attachment.byteLength, reportedBytes: params.totalBytes },
      );
    }
    const desiredStatus = params.interrupted ? "interrupted" : "complete";
    if (attachment.status !== "writing") {
      if (
        attachment.status !== desiredStatus ||
        attachment.sha256 !== params.sha256 ||
        fingerprint(attachment.recordingCoverage ?? null) !== fingerprint(params.recordingCoverage ?? null) ||
        fingerprint(attachment.recordingFailure ?? null) !== fingerprint(params.recordingFailure ?? null)
      ) {
        throw new ClipperError(
          "ATTACHMENT_CONFLICT",
          "A terminal attachment cannot be changed",
        );
      }
      const revision = await currentRevision(
        transaction.objectStore("meta") as unknown as MetaStoreLike,
        profileId,
      );
      const result: MutationResult<AttachmentRecord> = {
        value: withEffectiveAttachmentAvailability(attachment),
        ack: { persisted: true, revision },
      };
      await saveReceipt(
        receipts,
        profileId,
        "attachment.complete",
        params.requestId,
        requestFingerprint,
        result,
        this.#timestamp(),
      );
      await transaction.done;
      return result;
    }
    const now = this.#timestamp();
    const revision = await bumpRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    const updated: AttachmentRecord = withEffectiveAttachmentAvailability({
      ...attachment,
      status: desiredStatus,
      ...(params.sha256 ? { sha256: params.sha256.toLowerCase() } : {}),
      ...(params.recordingCoverage ? { recordingCoverage: params.recordingCoverage } : {}),
      ...(params.recordingFailure ? { recordingFailure: params.recordingFailure } : {}),
      completedAt: now,
      revision,
    });
    await transaction.objectStore("attachments").put(updated);
    const result: MutationResult<AttachmentRecord> = {
      value: updated,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "attachment.complete",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #getAttachmentImpl(
    profileId: string,
    params: AttachmentGetParams,
  ): Promise<AttachmentGetResult> {
    const database = await this.#databasePromise;
    const storedAttachment = await database.get("attachments", params.attachmentId);
    invariant(
      storedAttachment?.profileId === profileId,
      "NOT_FOUND",
      `Attachment ${params.attachmentId} was not found`,
    );
    const attachment = withEffectiveAttachmentAvailability(storedAttachment);
    if (params.offset > attachment.byteLength) {
      throw new ClipperError("VALIDATION_ERROR", "Attachment offset exceeds persisted bytes", {
        offset: params.offset,
        totalBytes: attachment.byteLength,
      });
    }
    if (params.encoding === "metadata") {
      return {
        attachment,
        offset: params.offset,
        returnedBytes: 0,
        totalBytes: attachment.byteLength,
        eof: attachment.status !== "writing" && params.offset >= attachment.byteLength,
      };
    }
    if (attachment.storage === "external") {
      throw new ClipperError(
        "ASSET_UNAVAILABLE",
        "External output is represented by a controlled file reference, not inline bytes",
        { attachmentId: attachment.attachmentId },
      );
    }
    if (!attachment.dataAvailable) {
      const emptyRecording = isEmptyTerminalBrowserRecording(attachment);
      const neverStarted = emptyRecording && attachment.recordingFailure?.started === false;
      throw new ClipperError(
        "ASSET_UNAVAILABLE",
        neverStarted
          ? "Browser recording never started, so no media bytes were persisted; read attachment metadata for the failure facts"
          : emptyRecording
            ? "Browser recording contains no persisted media bytes; metadata remains readable"
            : "Attachment bytes are unavailable; metadata remains readable (for example after a metadata-only backup)",
        {
          attachmentId: attachment.attachmentId,
          reason: neverStarted
            ? "recording_never_started"
            : emptyRecording
              ? "empty_recording"
              : "bytes_unavailable",
          ...(neverStarted && attachment.recordingFailure
            ? { failureCode: attachment.recordingFailure.code }
            : {}),
        },
      );
    }
    const end = Math.min(attachment.byteLength, params.offset + params.maxBytes);
    const output = new Uint8Array(Math.max(0, end - params.offset));
    if (output.byteLength > 0) {
      const transaction = database.transaction("attachmentChunks", "readonly");
      observeTransaction(transaction);
      const store = transaction.objectStore("attachmentChunks");
      const precedingRange = IDBKeyRange.bound(
        [attachment.attachmentId, 0],
        [attachment.attachmentId, params.offset],
      );
      const preceding = await store.openCursor(precedingRange, "prev");
      const firstChunkOffset = preceding?.value.offset ?? params.offset;
      const windowRange = IDBKeyRange.bound(
        [attachment.attachmentId, firstChunkOffset],
        [attachment.attachmentId, end],
        false,
        true,
      );
      let cursor = await store.openCursor(windowRange, "next");
      while (cursor) {
        const chunk = cursor.value;
        const chunkStart = chunk.offset;
        const chunkEnd = chunk.offset + chunk.byteLength;
        const overlapStart = Math.max(params.offset, chunkStart);
        const overlapEnd = Math.min(end, chunkEnd);
        if (overlapStart < overlapEnd) {
          const bytes = new Uint8Array(chunk.data);
          output.set(
            bytes.subarray(overlapStart - chunkStart, overlapEnd - chunkStart),
            overlapStart - params.offset,
          );
        }
        cursor = await cursor.continue();
      }
      await transaction.done;
    }
    return {
      attachment,
      offset: params.offset,
      returnedBytes: output.byteLength,
      totalBytes: attachment.byteLength,
      eof: attachment.status !== "writing" && end >= attachment.byteLength,
      dataBase64: bytesToBase64(output),
    };
  }

  async #updateSettingsImpl(
    profileId: string,
    params: SettingsUpdateParams,
  ): Promise<MutationResult<ClipperSettings>> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(["settings", "receipts", "meta"], "readwrite");
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<MutationResult<ClipperSettings>>(
      receipts,
      profileId,
      "settings.update",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }
    const now = this.#timestamp();
    const currentRevisionValue = await currentRevision(
      transaction.objectStore("meta") as unknown as MetaStoreLike,
      profileId,
    );
    const current =
      (await transaction.objectStore("settings").get(profileId)) ??
      defaultSettings(profileId, now, currentRevisionValue);
    if (params.patch.globalOutputDirectory !== undefined && params.patch.globalOutputDirectory !== null) {
      validateDirectory(params.patch.globalOutputDirectory, "global");
    }
    const maxRecordingBytes = params.patch.maxRecordingBytes ?? current.maxRecordingBytes;
    const maxAttachmentBytes = params.patch.maxAttachmentBytes ?? current.maxAttachmentBytes;
    if (maxRecordingBytes > maxAttachmentBytes) {
      throw new ClipperError(
        "VALIDATION_ERROR",
        "maxRecordingBytes cannot exceed the profile attachment budget",
        { maxRecordingBytes, maxAttachmentBytes },
      );
    }
    const changed = Object.keys(params.patch).length > 0;
    const revision = changed
      ? await bumpRevision(
          transaction.objectStore("meta") as unknown as MetaStoreLike,
          profileId,
        )
      : currentRevisionValue;
    const globalOutputDirectory =
      params.patch.globalOutputDirectory === null
        ? undefined
        : params.patch.globalOutputDirectory ?? current.globalOutputDirectory;
    const updated: ClipperSettings = {
      ...current,
      ...(params.patch.paddingBeforeSeconds !== undefined
        ? { paddingBeforeSeconds: params.patch.paddingBeforeSeconds }
        : {}),
      ...(params.patch.paddingAfterSeconds !== undefined
        ? { paddingAfterSeconds: params.patch.paddingAfterSeconds }
        : {}),
      ...(params.patch.reminderMinutes !== undefined
        ? { reminderMinutes: params.patch.reminderMinutes }
        : {}),
      ...(params.patch.defaultOutputRangePolicy !== undefined
        ? { defaultOutputRangePolicy: params.patch.defaultOutputRangePolicy }
        : {}),
      ...(globalOutputDirectory !== undefined ? { globalOutputDirectory } : {}),
      maxRecordingSeconds:
        params.patch.maxRecordingSeconds ?? current.maxRecordingSeconds,
      maxRecordingBytes,
      maxAttachmentBytes,
      updatedAt: changed ? now : current.updatedAt,
      revision,
    };
    if (globalOutputDirectory === undefined && "globalOutputDirectory" in updated) {
      delete (updated as { globalOutputDirectory?: string }).globalOutputDirectory;
    }
    if (changed) {
      await transaction.objectStore("settings").put(updated);
    }
    const result: MutationResult<ClipperSettings> = {
      value: updated,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "settings.update",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #exportBackupImpl(
    profileId: string,
    includeData: boolean,
  ): Promise<BackupBundle> {
    const database = await this.#databasePromise;
    const [captures, jobs, results, events, attachments, settings] = await Promise.all([
      database.getAll("captures"),
      database.getAll("jobs"),
      database.getAll("results"),
      database.getAll("executionEvents"),
      database.getAll("attachments"),
      this.#settingsForRead(profileId),
    ]);
    const profileCaptures = captures
      .filter((item) => item.profileId === profileId)
      .map(redactCaptureRecordUrls)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const profileJobs = jobs
      .filter((item) => item.profileId === profileId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const profileResults = results
      .filter((item) => item.profileId === profileId)
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt));
    const profileEvents = events
      .filter((item) => item.profileId === profileId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const profileAttachments = attachments
      .filter((item) => item.profileId === profileId)
      .map(withEffectiveAttachmentAvailability)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    let attachmentChunks: BackupBundle["attachmentChunks"];
    if (includeData) {
      const attachmentIds = new Set(profileAttachments.map((item) => item.attachmentId));
      const chunks = (await database.getAll("attachmentChunks"))
        .filter((chunk) => attachmentIds.has(chunk.attachmentId))
        .sort(
          (left, right) =>
            left.attachmentId.localeCompare(right.attachmentId) || left.offset - right.offset,
        );
      attachmentChunks = chunks.map((chunk) => ({
        attachmentId: chunk.attachmentId,
        offset: chunk.offset,
        dataBase64: bytesToBase64(new Uint8Array(chunk.data)),
      }));
    }
    return {
      format: "babel-content-clipper-backup",
      schemaVersion: CORE_SCHEMA_VERSION,
      exportedAt: this.#timestamp(),
      profileId,
      attachmentDataIncluded: includeData,
      captures: profileCaptures,
      jobs: profileJobs,
      results: profileResults,
      events: profileEvents,
      attachments: profileAttachments,
      ...(attachmentChunks ? { attachmentChunks } : {}),
      settings,
    };
  }

  async #importBackupImpl(
    profileId: string,
    params: BackupImportParams,
  ): Promise<BackupImportResult> {
    assertCurrentBackupVersion(params.bundle.schemaVersion);
    validateBackupBundle(params.bundle);
    const database = await this.#databasePromise;
    const transaction = database.transaction(
      [
        "captures",
        "jobs",
        "results",
        "executionEvents",
        "attachments",
        "attachmentChunks",
        "settings",
        "receipts",
        "meta",
      ],
      "readwrite",
    );
    observeTransaction(transaction);
    const receipts = transaction.objectStore("receipts") as unknown as ReceiptStoreLike;
    const requestFingerprint = fingerprint(params);
    const replay = await replayReceipt<BackupImportResult>(
      receipts,
      profileId,
      "backup.import",
      params.requestId,
      requestFingerprint,
    );
    if (replay) {
      await transaction.done;
      return replay;
    }

    const incomingCaptures = (params.bundle.captures as readonly CaptureRecord[]).map(
      (record) => redactCaptureRecordUrls({ ...record, profileId }),
    );
    const incomingJobs = (params.bundle.jobs as readonly JobRecord[]).map((record) => ({
      ...record,
      profileId,
    }));
    const incomingResults = (params.bundle.results as readonly ResultRecord[]).map((record) => ({
      ...record,
      profileId,
    }));
    const incomingEvents = (params.bundle.events as readonly ExecutionEvent[]).map((record) => ({
      ...record,
      profileId,
    }));
    const incomingAttachments = (params.bundle.attachments as readonly AttachmentRecord[]).map(
      (record) => withEffectiveAttachmentAvailability({
        ...record,
        profileId,
        dataAvailable:
          record.storage === "chunked" &&
          record.dataAvailable === true &&
          params.bundle.attachmentDataIncluded === true,
      }),
    );
    const incomingSettings = {
      ...(params.bundle.settings as ClipperSettings),
      profileId,
    };

    const conflicts: { entity: string; id: string }[] = [];
    let skippedIdentical = 0;
    const newCaptures: CaptureRecord[] = [];
    const newJobs: JobRecord[] = [];
    const newResults: ResultRecord[] = [];
    const newEvents: ExecutionEvent[] = [];
    const newAttachments: AttachmentRecord[] = [];
    const newChunks: AttachmentChunkRecord[] = [];

    for (const record of incomingCaptures) {
      const existing = await transaction.objectStore("captures").get(record.captureId);
      if (!existing) newCaptures.push(record);
      else if (existing.profileId === profileId && recordsEqual(existing, record)) skippedIdentical += 1;
      else conflicts.push({ entity: "capture", id: record.captureId });
    }
    for (const record of incomingJobs) {
      const existing = await transaction.objectStore("jobs").get(record.jobId);
      if (!existing) newJobs.push(record);
      else if (existing.profileId === profileId && recordsEqual(existing, record)) skippedIdentical += 1;
      else conflicts.push({ entity: "job", id: record.jobId });
    }
    for (const record of incomingResults) {
      const existing = await transaction.objectStore("results").get(record.resultId);
      const sameJobResult = await transaction.objectStore("results").index("by-job").get(record.jobId);
      if (!existing && !sameJobResult) newResults.push(record);
      else if (
        existing?.profileId === profileId &&
        recordsEqual(existing, record) &&
        (!sameJobResult || sameJobResult.resultId === existing.resultId)
      ) {
        skippedIdentical += 1;
      } else {
        conflicts.push({ entity: "result", id: record.resultId });
      }
    }
    for (const record of incomingEvents) {
      const existing = await transaction.objectStore("executionEvents").get(record.eventId);
      if (!existing) newEvents.push(record);
      else if (existing.profileId === profileId && recordsEqual(existing, record)) skippedIdentical += 1;
      else conflicts.push({ entity: "event", id: record.eventId });
    }
    for (const record of incomingAttachments) {
      const existing = await transaction.objectStore("attachments").get(record.attachmentId);
      if (!existing) newAttachments.push(record);
      else if (existing.profileId === profileId && recordsEqual(existing, record)) skippedIdentical += 1;
      else conflicts.push({ entity: "attachment", id: record.attachmentId });
    }
    for (const chunk of params.bundle.attachmentChunks ?? []) {
      const bytes = base64ToBytes(chunk.dataBase64);
      const record: AttachmentChunkRecord = {
        attachmentId: chunk.attachmentId,
        offset: chunk.offset,
        byteLength: bytes.byteLength,
        data: ownedArrayBuffer(bytes),
      };
      const existing = await transaction
        .objectStore("attachmentChunks")
        .get([record.attachmentId, record.offset]);
      if (!existing) {
        newChunks.push(record);
      } else {
        const existingBytes = new Uint8Array(existing.data);
        const identical =
          existingBytes.byteLength === bytes.byteLength &&
          existingBytes.every((value, index) => value === bytes[index]);
        if (identical) skippedIdentical += 1;
        else conflicts.push({ entity: "attachment_chunk", id: `${record.attachmentId}:${record.offset}` });
      }
    }
    const existingSettings = await transaction.objectStore("settings").get(profileId);
    const shouldImportSettings = !existingSettings;
    if (existingSettings && !recordsEqual(existingSettings, incomingSettings)) {
      conflicts.push({ entity: "settings", id: profileId });
    } else if (existingSettings) {
      skippedIdentical += 1;
    }
    if (conflicts.length > 0) {
      throw new ClipperError(
        "IMPORT_CONFLICT",
        "Backup import would overwrite different existing records",
        { conflicts },
      );
    }

    const hasWrites =
      newCaptures.length +
        newJobs.length +
        newResults.length +
        newEvents.length +
        newAttachments.length +
        newChunks.length >
        0 || shouldImportSettings;
    const revision = hasWrites
      ? await bumpRevision(
          transaction.objectStore("meta") as unknown as MetaStoreLike,
          profileId,
        )
      : await currentRevision(
          transaction.objectStore("meta") as unknown as MetaStoreLike,
          profileId,
        );

    for (const record of newCaptures) {
      await transaction.objectStore("captures").add({ ...record, revision });
    }
    for (const record of newJobs) {
      await transaction.objectStore("jobs").add({ ...record, revision });
    }
    for (const record of newResults) {
      await transaction.objectStore("results").add({ ...record, revision });
    }
    for (const record of newEvents) {
      await transaction.objectStore("executionEvents").add(record);
    }
    for (const record of newAttachments) {
      await transaction.objectStore("attachments").add({ ...record, revision });
    }
    for (const record of newChunks) {
      await transaction.objectStore("attachmentChunks").add(record);
    }
    if (shouldImportSettings) {
      await transaction.objectStore("settings").add({
        ...incomingSettings,
        revision,
      });
    }
    const now = this.#timestamp();
    const result: BackupImportResult = {
      imported: {
        captures: newCaptures.length,
        jobs: newJobs.length,
        results: newResults.length,
        events: newEvents.length,
        attachments: newAttachments.length,
        chunks: newChunks.length,
      },
      skippedIdentical,
      ack: { persisted: true, revision },
    };
    await saveReceipt(
      receipts,
      profileId,
      "backup.import",
      params.requestId,
      requestFingerprint,
      result,
      now,
    );
    await transaction.done;
    return result;
  }

  async #diagnosticsImpl(_profileId: string): Promise<DiagnosticsResult> {
    const profileId = _profileId;
    const database = await this.#databasePromise;
    const [captures, jobs, results, attachments, settings, revision] = await Promise.all([
      database.getAll("captures"),
      database.getAll("jobs"),
      database.getAll("results"),
      database.getAll("attachments"),
      this.#settingsForRead(profileId),
      this.#revision(profileId),
    ]);
    const profileCaptures = captures.filter((item) => item.profileId === profileId);
    const profileJobs = jobs.filter((item) => item.profileId === profileId);
    const profileResults = results.filter((item) => item.profileId === profileId);
    const profileAttachments = attachments.filter((item) => item.profileId === profileId);
    const staleCutoff = this.#now().getTime() - this.#staleProcessingMs;
    const staleProcessing = profileJobs
      .filter(
        (job) =>
          job.status === "processing" &&
          job.claim !== undefined &&
          Date.parse(job.claim.lastHeartbeatAt) < staleCutoff,
      )
      .map((job) => ({
        jobId: job.jobId,
        lastHeartbeatAt: job.claim?.lastHeartbeatAt ?? job.updatedAt,
      }));
    const internalAttachmentBytes = profileAttachments
      .filter((item) => item.storage === "chunked")
      .reduce((sum, item) => sum + item.byteLength, 0);
    return {
      schemaVersion: CORE_SCHEMA_VERSION,
      databaseVersion: 1,
      profileId,
      databaseName: this.#databaseName,
      revision,
      counts: {
        captures: profileCaptures.length,
        openCaptures: profileCaptures.filter((item) => item.state === "open").length,
        jobs: profileJobs.length,
        processingJobs: profileJobs.filter((item) => item.status === "processing").length,
        failedJobs: profileJobs.filter((item) => item.status === "failed").length,
        results: profileResults.length,
        attachments: profileAttachments.length,
        internalAttachmentBytes,
      },
      staleProcessing,
      maxAttachmentChunkBytes: MAX_ATTACHMENT_CHUNK_BYTES,
      budgets: {
        maxRecordingSeconds: settings.maxRecordingSeconds,
        maxRecordingBytes: settings.maxRecordingBytes,
        maxAttachmentBytes: settings.maxAttachmentBytes,
        attachmentBudgetExceeded: internalAttachmentBytes > settings.maxAttachmentBytes,
        defaultsAreUnvalidated: true,
      },
    };
  }
}

export function createClipperService(
  options: CreateClipperServiceOptions = {},
): CoreService {
  return new ClipperServiceImpl(options);
}
