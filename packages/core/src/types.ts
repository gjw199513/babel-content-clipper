export const CORE_SCHEMA_VERSION = "1.0" as const;
export const CORE_DATABASE_VERSION = 2 as const;
export const MAX_ATTACHMENT_CHUNK_BYTES = 512 * 1024;

export const CORE_METHODS = [
  "capture.create",
  "capture.updateDraft",
  "capture.finalize",
  "capture.list",
  "capture.get",
  "capture.getAcquisitionSource",
  "job.get",
  "job.claim",
  "job.heartbeat",
  "job.complete",
  "job.reprocess",
  "library.setCollection",
  "library.cleanupPreview",
  "library.cleanupCommit",
  "attachment.create",
  "attachment.appendChunk",
  "attachment.complete",
  "attachment.get",
  "settings.get",
  "settings.update",
  "backup.export",
  "backup.import",
  "diagnostics.get",
  "connection.status",
] as const;

export type CoreMethod = (typeof CORE_METHODS)[number];

/**
 * Methods advertised by a connected extension. Source-media acquisition is
 * handled by the extension background, not by the IndexedDB core service, so
 * it is a capability but not a CoreMethod accepted by service.handle().
 */
export const EXTENSION_CAPABILITY_METHODS = [
  ...CORE_METHODS,
  "capture.acquireMedia",
] as const;

export type ExtensionCapabilityMethod = (typeof EXTENSION_CAPABILITY_METHODS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type CaptureKind =
  | "text_selection"
  | "mixed_selection"
  | "image"
  | "media_range"
  | "audio_range"
  | "region_capture"
  | "clipboard_import";

export type CaptureState = "open" | "sealed" | "interrupted";
export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type ResultStatus = "completed" | "failed";
export type CollectionState = "inbox" | "saved";
export type AssetsState = "location_only" | "partial_saved" | "saved";
export type CaptureIntegrityStatus =
  | "complete_selection"
  | "partial"
  | "needs_completion";

export interface TimeRange {
  readonly start: number;
  readonly end: number;
}

export interface SourceFrameSnapshot {
  readonly frameId?: number;
  readonly documentId?: string;
  readonly frameUrl?: string;
}

export interface SourceSnapshot {
  readonly title: string;
  readonly pageUrl: string;
  readonly canonicalUrl?: string;
  readonly site: string;
  readonly contentId?: string;
  readonly bookTitle?: string;
  readonly chapterTitle?: string;
  readonly chapterHref?: string;
  readonly mediaDurationSeconds?: number;
  readonly identityConfidence?:
    | "exact"
    | "adapter_reported"
    | "page_reported"
    | "best_effort"
    | "unknown";
  readonly frame?: SourceFrameSnapshot;
  readonly metadata?: JsonObject;
}

/**
 * Capture-time source context used only by the local source acquisition tool.
 * These fields never belong to the public CaptureRecord returned to Agents.
 */
export interface SourceSnapshotInput extends SourceSnapshot {
  readonly acquisitionUrl?: string;
  readonly mediaAcquisitionUrl?: string;
}

export interface TextLocator {
  readonly type: "text_quote" | "text_position" | "epub_cfi" | "pdf_page" | "unknown";
  readonly start?: number;
  readonly end?: number;
  readonly epubCfi?: string;
  readonly pageIndex?: number;
  readonly sourceConfidence?: string;
  readonly metadata?: JsonObject;
}

export interface TextSelection {
  readonly type: "text";
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly sanitizedHtml?: string;
  readonly locator?: TextLocator;
}

export interface MediaPoint {
  readonly mediaSeconds: number | null;
  readonly wallTime: string;
  readonly unavailableReason?: string;
}

export interface MediaEvent {
  readonly type:
    | "start"
    | "end"
    | "pause"
    | "resume"
    | "seek"
    | "rate_change"
    | "observation"
    | "interrupted";
  readonly mediaSeconds: number | null;
  readonly wallTime: string;
  readonly playbackRate?: number;
  readonly metadata?: JsonObject;
}

export interface MediaSelectionInput {
  readonly type: "media";
  readonly target: "media_object" | "page_scene";
  readonly timeBasis: "source_media" | "recording_elapsed" | "unknown";
  readonly startClick: MediaPoint;
  readonly endClick?: MediaPoint;
  /** Raw observation-order ranges. They are never replaced by normalized output ranges. */
  readonly segments?: readonly TimeRange[];
  readonly events?: readonly MediaEvent[];
  readonly continuity?: "continuous" | "discontinuous" | "unknown";
  readonly lastObservedMediaSeconds?: number | null;
}

export interface MediaSelection extends MediaSelectionInput {
  readonly segments: readonly TimeRange[];
  /** Union of overlapping source-time segments within this capture only. */
  readonly normalizedSegments: readonly TimeRange[];
  readonly events: readonly MediaEvent[];
}

export interface ImageSelection {
  readonly type: "image";
  readonly resourceUrl?: string;
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
  readonly altText?: string;
  readonly locator?: JsonObject;
}

export interface RegionSelection {
  readonly type: "region";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly devicePixelRatio: number;
}

export interface ClipboardSelection {
  readonly type: "clipboard";
  readonly text: string;
  readonly sourceKnown: boolean;
}

export type CaptureSelectionInput =
  | TextSelection
  | MediaSelectionInput
  | ImageSelection
  | RegionSelection
  | ClipboardSelection;

export type CaptureSelection =
  | TextSelection
  | MediaSelection
  | ImageSelection
  | RegionSelection
  | ClipboardSelection;

export interface PaddingSnapshot {
  readonly beforeSeconds: number;
  readonly afterSeconds: number;
}

export interface CaptureIntegrity {
  readonly status: CaptureIntegrityStatus;
  readonly missing: readonly string[];
}

export interface CaptureCreateInput {
  readonly kind: CaptureKind;
  readonly state: "open" | "sealed";
  readonly source: SourceSnapshotInput;
  readonly selection: CaptureSelectionInput;
  readonly padding?: PaddingSnapshot;
  readonly captureMethod: string;
  readonly assetsState: AssetsState;
  readonly attachmentIds?: readonly string[];
  readonly integrity: CaptureIntegrity;
  readonly capturedAt?: string;
  readonly supersedesCaptureId?: string;
}

export interface CaptureRecord {
  readonly schemaVersion: typeof CORE_SCHEMA_VERSION;
  readonly captureId: string;
  readonly profileId: string;
  readonly kind: CaptureKind;
  readonly state: CaptureState;
  readonly collection: CollectionState;
  readonly createdAt: string;
  readonly sealedAt?: string;
  readonly interruptedAt?: string;
  readonly source: SourceSnapshot;
  readonly sourceKey: string;
  readonly selection: CaptureSelection;
  readonly padding: PaddingSnapshot;
  readonly plannedAcquisitionRanges: readonly TimeRange[];
  readonly captureMethod: string;
  readonly assetsState: AssetsState;
  readonly attachmentIds: readonly string[];
  readonly integrity: CaptureIntegrity;
  readonly supersedesCaptureId?: string;
  readonly initialJobId?: string;
  /** Changes for collection/draft/finalization; immutable facts are still guarded by service rules. */
  readonly revision: number;
}

export interface CaptureDraftObservations {
  readonly segments?: readonly TimeRange[];
  readonly events?: readonly MediaEvent[];
  readonly lastObservedMediaSeconds?: number | null;
  readonly attachmentIds?: readonly string[];
}

export interface CaptureFinalizeInput {
  readonly state: "sealed" | "interrupted";
  readonly endedAt: string;
  readonly endClick?: MediaPoint;
  readonly observations?: CaptureDraftObservations;
  readonly assetsState?: AssetsState;
  readonly integrity: CaptureIntegrity;
}

export interface OutputRequest {
  readonly videoWithAudio?: boolean;
  readonly separateAudio?: boolean;
  readonly frames?: {
    readonly enabled: boolean;
    readonly mode?: "specified_times" | "interval";
    readonly sourceSeconds?: readonly number[];
    readonly intervalSeconds?: number;
  };
  readonly text?: boolean;
  readonly images?: boolean;
}

export interface ExecutionOptions {
  readonly acquisitionStrategy?: "source_first" | "saved_asset_only" | "custom";
  readonly allowTemporaryFullDownload?: boolean;
  readonly requestedAcquisitionRanges?: readonly TimeRange[];
  readonly outputRangePolicy?: "original" | "padded" | "custom";
  readonly requestedOutputRanges?: readonly TimeRange[];
  readonly outputs?: OutputRequest;
  /** One automatic retry after the first attempt is the product default. */
  readonly retryLimit?: number;
  readonly metadata?: JsonObject;
}

export interface DirectoryResolution {
  readonly path?: string;
  readonly source: "task" | "connection" | "global" | "none";
}

export interface JobClaim {
  readonly workerId: string;
  readonly claimToken: string;
  readonly requestId: string;
  readonly claimedAt: string;
  readonly lastHeartbeatAt: string;
}

export interface FailureInfo {
  readonly code: string;
  readonly message: string;
  readonly stage: string;
  readonly retryCount: number;
  readonly retryable?: boolean;
  readonly details?: JsonObject;
}

export interface JobRecord {
  readonly jobId: string;
  readonly profileId: string;
  readonly captureId: string;
  readonly reason: "initial_processing" | "reprocess";
  readonly parentJobId?: string;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly executionOptions: ExecutionOptions;
  readonly directory: DirectoryResolution;
  readonly claim?: JobClaim;
  readonly executionState?: "active" | "uncertain";
  readonly resultId?: string;
  readonly failure?: FailureInfo;
  readonly revision: number;
}

export interface ResultArtifact {
  readonly assetId: string;
  readonly kind: "video" | "audio" | "image" | "frame" | "text" | "manifest" | "other";
  readonly mimeType: string;
  readonly fileReference?: string;
  readonly attachmentId?: string;
  readonly byteLength?: number;
  readonly durationSeconds?: number;
  readonly sourceMediaSeconds?: number;
  readonly hasVideo?: boolean;
  readonly hasAudio?: boolean;
  readonly metadata?: JsonObject;
}

export interface VerificationReport {
  readonly level: "agent_reported" | "bridge_verified";
  readonly fileExists?: boolean;
  readonly requiredTracksPresent?: boolean;
  readonly timeCoverageChecked?: boolean;
  readonly warnings: readonly string[];
  readonly metadata?: JsonObject;
}

export interface ResultRecord {
  readonly resultId: string;
  readonly profileId: string;
  readonly jobId: string;
  readonly captureId: string;
  readonly status: ResultStatus;
  readonly completedAt: string;
  readonly acquisitionMethod?: "source_media" | "browser_recording" | "normalized_recording" | "saved_text" | "other";
  readonly requestedRanges: readonly TimeRange[];
  readonly acquiredRanges: readonly TimeRange[];
  readonly outputRanges: readonly TimeRange[];
  readonly paddingInFinalOutput?: boolean;
  readonly artifacts: readonly ResultArtifact[];
  readonly verification: VerificationReport;
  readonly failure?: FailureInfo;
  readonly completionFingerprint: string;
  readonly revision: number;
}

export interface ExecutionEvent {
  readonly eventId: string;
  readonly profileId: string;
  readonly jobId: string;
  readonly captureId: string;
  readonly type: "created" | "claimed" | "heartbeat" | "retry" | "uncertain" | "completed" | "failed";
  readonly createdAt: string;
  readonly workerId?: string;
  readonly stage?: string;
  readonly retryCount?: number;
  readonly message?: string;
  readonly metadata?: JsonObject;
}

export interface RecordingCoverage {
  readonly timeBasis: "recording_elapsed";
  readonly recordingStartedAt: string;
  readonly recordingStoppedAt: string;
  readonly elapsedSeconds: number;
  readonly requestedPreRollSeconds: number;
  readonly actualPreRollSeconds: number;
  readonly requestedPostRollSeconds: number;
  readonly actualPostRollRecordingSeconds: number;
  readonly observedPostRollMediaSeconds?: number;
  readonly postRollComplete: boolean;
  readonly stopReason:
    | "requested"
    | "max_duration"
    | "track_ended"
    | "chunk_failure"
    | "service_worker_restart"
    | "page_closed"
    | "source_changed"
    | "recorder_error"
    | "unavailable";
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly audioMonitor: boolean;
}

/** Persisted diagnostic fact for a browser recording that did not complete. */
export interface RecordingFailureFact {
  readonly code: string;
  readonly message: string;
  readonly stage: "start" | "stream" | "chunk" | "stop";
  /** False means no real MediaRecorder start was ever confirmed. */
  readonly started: boolean;
}

export interface AttachmentRecord {
  readonly attachmentId: string;
  readonly profileId: string;
  readonly captureId?: string;
  readonly jobId?: string;
  readonly kind: "source_image" | "screen_region" | "browser_recording" | "text" | "thumbnail" | "other";
  readonly mimeType: string;
  readonly storage: "chunked" | "external";
  readonly dataAvailable: boolean;
  readonly status: "writing" | "complete" | "interrupted";
  readonly byteLength: number;
  readonly expectedTotalBytes?: number;
  readonly fileReference?: string;
  readonly sha256?: string;
  /** Measured browser-recording coverage; absent for non-recording attachments. */
  readonly recordingCoverage?: RecordingCoverage;
  /** Failure fact is kept even when recording never started and coverage is absent. */
  readonly recordingFailure?: RecordingFailureFact;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly revision: number;
}

export interface AttachmentChunkRecord {
  readonly attachmentId: string;
  readonly offset: number;
  readonly byteLength: number;
  readonly data: ArrayBuffer;
}

export interface ClipperSettings {
  readonly profileId: string;
  readonly paddingBeforeSeconds: number;
  readonly paddingAfterSeconds: number;
  readonly reminderMinutes: number | null;
  readonly defaultOutputRangePolicy: "original" | "padded";
  readonly globalOutputDirectory?: string;
  /** Candidate engineering defaults; long-duration validation is still required. */
  readonly maxRecordingSeconds: number;
  readonly maxRecordingBytes: number;
  /** Profile-wide budget for internally stored attachment chunks. */
  readonly maxAttachmentBytes: number;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface PersistedAck {
  readonly persisted: true;
  readonly revision: number;
}

export interface MutationResult<T> {
  readonly value: T;
  readonly ack: PersistedAck;
}

export type CaptureCreateResult = MutationResult<{
  readonly capture: CaptureRecord;
  readonly job?: JobRecord;
}>;
export type CaptureFinalizeResult = CaptureCreateResult;
export type CaptureDraftUpdateResult = MutationResult<CaptureRecord>;
export type SetCollectionResult = MutationResult<CaptureRecord>;
export type ReprocessJobResult = MutationResult<JobRecord>;
export type HeartbeatJobResult = MutationResult<JobRecord>;
export type AttachmentMutationResult = MutationResult<AttachmentRecord>;
export type SettingsUpdateResult = MutationResult<ClipperSettings>;

export interface CaptureListItem {
  readonly captureId: string;
  readonly sourceKey: string;
  readonly kind: CaptureKind;
  readonly title: string;
  readonly site: string;
  readonly preview: string;
  readonly state: CaptureState;
  readonly collection: CollectionState;
  readonly assetsState: AssetsState;
  readonly createdAt: string;
  readonly latestJobId?: string;
  readonly latestJobStatus?: JobStatus;
}

export interface CaptureListResult {
  readonly schemaVersion: typeof CORE_SCHEMA_VERSION;
  readonly profileId: string;
  readonly records: readonly CaptureListItem[];
  readonly nextCursor: string | null;
  readonly revision: number;
}

export interface CaptureDetailResult {
  readonly capture: CaptureRecord;
  readonly jobs: readonly JobRecord[];
  readonly results: readonly ResultRecord[];
  readonly events: readonly ExecutionEvent[];
  readonly attachments: readonly AttachmentRecord[];
}

/**
 * A private, claim-bound source context. URL fields are intentionally not
 * included in CaptureDetailResult or BackupBundle.
 */
export interface CaptureAcquisitionSource {
  readonly captureId: string;
  readonly jobId: string;
  readonly title: string;
  readonly site: string;
  readonly publicPageUrl: string;
  readonly pageUrl?: string;
  readonly mediaUrl?: string;
}

export interface ClaimItemResult {
  readonly jobId: string;
  readonly disposition: "accepted" | "already_claimed" | "not_eligible" | "not_found";
  readonly claimToken?: string;
  readonly job?: JobRecord;
  readonly reason?: string;
}

export interface ClaimBatchResult {
  readonly items: readonly ClaimItemResult[];
  readonly ack: PersistedAck;
}

export interface CompleteJobResult {
  readonly job: JobRecord;
  readonly result: ResultRecord;
  readonly ack: PersistedAck;
}

export interface CleanupCandidate {
  readonly captureId: string;
  readonly jobCount: number;
  readonly resultCount: number;
  readonly attachmentCount: number;
  readonly captureRevision: number;
}

export interface CleanupSkipped {
  readonly captureId: string;
  readonly reason: "not_found" | "active_job" | "not_processed" | "profile_mismatch";
}

export interface CleanupPreviewResult {
  readonly cleanupToken: string;
  readonly expiresAt: string;
  readonly candidates: readonly CleanupCandidate[];
  readonly skipped: readonly CleanupSkipped[];
  readonly externalFilesPreserved: true;
  readonly ack: PersistedAck;
}

export interface CleanupCommitResult {
  readonly deletedCaptureIds: readonly string[];
  readonly deletedJobCount: number;
  readonly deletedResultCount: number;
  readonly deletedEventCount: number;
  readonly deletedAttachmentRecords: number;
  readonly externalFilesPreserved: true;
  readonly ack: PersistedAck;
}

export interface AttachmentGetResult {
  readonly attachment: AttachmentRecord;
  readonly offset: number;
  readonly returnedBytes: number;
  readonly totalBytes: number;
  readonly eof: boolean;
  readonly dataBase64?: string;
}

export interface BackupBundle {
  readonly format: "babel-content-clipper-backup";
  readonly schemaVersion: typeof CORE_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly profileId: string;
  readonly attachmentDataIncluded: boolean;
  readonly captures: readonly CaptureRecord[];
  readonly jobs: readonly JobRecord[];
  readonly results: readonly ResultRecord[];
  readonly events: readonly ExecutionEvent[];
  readonly attachments: readonly AttachmentRecord[];
  readonly attachmentChunks?: readonly {
    readonly attachmentId: string;
    readonly offset: number;
    readonly dataBase64: string;
  }[];
  readonly settings: ClipperSettings;
}

export interface BackupImportResult {
  readonly imported: {
    readonly captures: number;
    readonly jobs: number;
    readonly results: number;
    readonly events: number;
    readonly attachments: number;
    readonly chunks: number;
  };
  readonly skippedIdentical: number;
  readonly ack: PersistedAck;
}

export interface DiagnosticsResult {
  readonly schemaVersion: typeof CORE_SCHEMA_VERSION;
  readonly databaseVersion: typeof CORE_DATABASE_VERSION;
  readonly extensionVersion?: string;
  readonly coreVersion?: string;
  readonly profileId: string;
  readonly databaseName: string;
  readonly revision: number;
  readonly counts: {
    readonly captures: number;
    readonly openCaptures: number;
    readonly jobs: number;
    readonly processingJobs: number;
    readonly failedJobs: number;
    readonly results: number;
    readonly attachments: number;
    readonly internalAttachmentBytes: number;
  };
  readonly staleProcessing: readonly {
    readonly jobId: string;
    readonly lastHeartbeatAt: string;
  }[];
  readonly maxAttachmentChunkBytes: number;
  readonly budgets: {
    readonly maxRecordingSeconds: number;
    readonly maxRecordingBytes: number;
    readonly maxAttachmentBytes: number;
    readonly attachmentBudgetExceeded: boolean;
    readonly defaultsAreUnvalidated: true;
  };
}

export interface ConnectionStatusResult {
  readonly browserAvailable: boolean;
  readonly databaseAvailable: boolean;
  readonly extensionVersion?: string;
  readonly coreVersion?: string;
  readonly profileId: string;
  readonly revision: number;
  readonly capabilities: {
    readonly methods: readonly ExtensionCapabilityMethod[];
    readonly maxAttachmentChunkBytes: number;
    readonly fourJobStates: true;
  };
}

export interface DispatchContext {
  /** Trusted extension/broker routing data. Page content must never choose this value. */
  readonly profileId?: string;
  /** Trusted MCP connection configuration, below a task-specific override in priority. */
  readonly connectionOutputDirectory?: string;
}

export interface SerializableClipperError {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
}

export interface CreateClipperServiceOptions {
  readonly databaseName?: string;
  readonly defaultProfileId?: string;
  /** Version reported by the bundled browser extension/Core. */
  readonly extensionVersion?: string;
  readonly coreVersion?: string;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
  readonly browserAvailable?: () => boolean;
  readonly staleProcessingMs?: number;
}

export interface CoreService {
  handle(method: string, params: unknown, context?: DispatchContext): Promise<unknown>;
  close(): Promise<void>;
}
