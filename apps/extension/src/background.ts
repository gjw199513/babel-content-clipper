import { handleCore } from "./core-client.js";
import { initializeI18n, onLocaleChange, t } from "./i18n.js";
import {
  EXTENSION_CHANNEL,
  isContentSender,
  isCoreUiMessage,
  isExtensionPageSender,
  isRecorderMessage,
  isSourceStreamMessage,
  type ContentReplyMessage,
  type CoreUiMessage,
  type NativeMethod,
} from "./messages.js";
import { NativeBridge } from "./native-bridge.js";
import { createReminderController } from "./reminders.js";
import { fetchImageBytes } from "./image-bytes.js";
import { ACTION_NOTICE_KEY, type ActionNotice } from "./action-notice.js";
import { redactUrl, truncateText } from "./security.js";
import { serializeClipperError } from "../../../packages/core/src/errors.js";
import type { CaptureCreateResult, CaptureDetailResult, ConnectionStatusResult, MediaEvent, RecordingCoverage, RecordingFailureFact } from "../../../packages/core/src/types.js";
import { describeMediaToggleResult } from "./media-action.js";
import { discardTerminalMediaState, isPendingMediaSealNotice, PENDING_MEDIA_SEAL_NOTICE } from "./media-recovery.js";
import { reconcileMediaSegments } from "./media-observation-policy.js";
import { describeCaptureSaveResult } from "./capture-feedback.js";
import { classifyContentAccessFailure } from "./content-access.js";
import { recordingFailureFact } from "./recording-errors.js";
import {
  MAX_SELECTION_IMAGE_FETCHES,
  MAX_SELECTION_IMAGE_REFERENCES,
  planSelectionImages,
  type SelectionImagePlan,
} from "./selection-images.js";

const PROFILE_KEY = "babel_content_clipper.profile_id.v1";
const MEDIA_STATE_KEY = "babel_content_clipper.media_state.v1";
const NATIVE_ENABLED_KEY = "babel_content_clipper.native_connection_enabled.v1";
const ACTION_BADGE_CLEAR_ALARM = "babel_content_clipper.action_badge_clear.v1";
const OFFSCREEN_PATH = "offscreen.html";
const MAX_RECORDING_BYTES = 256 * 1024 * 1024;
const MAX_RECORDING_CHUNK_BYTES = 512 * 1024;
const MAX_SOURCE_CHUNK_BYTES = 512 * 1024;

interface OpenMedia {
  captureId: string;
  requestId: string;
  tabId: number;
  frameId: number;
  targetId: string;
  source: string;
  documentInstanceId?: string;
  startedAt: string;
  startedMediaSeconds: number;
  paddingBeforeSeconds: number;
  paddingAfterSeconds: number;
  recordLive: boolean;
  recordingId?: string;
  attachmentId?: string;
  interrupted?: boolean;
  recordingStatus?: "starting" | "started" | "failed" | "stopped";
  recordingMaxBytes?: number;
  recordingMaxSeconds?: number;
  recordingOffset?: number;
  recordingTotalBytes?: number;
  recordingStartedAt?: string;
  recordingStoppedAt?: string;
  recordingElapsedSeconds?: number;
  recordingStopReason?: RecordingCoverage["stopReason"];
  recordingHasAudio?: boolean;
  recordingHasVideo?: boolean;
  recordingAudioMonitor?: boolean;
  recordingFailure?: RecordingFailureFact;
  userEndedAt?: string;
  userEndMediaSeconds?: number | null;
  tailStartedAt?: string;
  actualPostRollRecordingSeconds?: number;
  observedPostRollMediaSeconds?: number;
  postRollComplete?: boolean;
  lastObservedMediaSeconds?: number;
  observedSegments?: Array<{ start: number; end: number; source: string }>;
  observedEvents?: MediaEvent[];
}

interface RecordingState {
  recordingId: string;
  captureId: string;
  attachmentId?: string;
  mimeType?: string;
  offset: number;
  totalBytes: number;
  chunkCount: number;
  maxBytes?: number;
  maxSeconds?: number;
  stoppedRequested?: boolean;
  stopped?: boolean;
  started?: boolean;
  audioMonitor?: boolean;
  hasAudio?: boolean;
  hasVideo?: boolean;
  startedAt?: string;
  stoppedAt?: string;
  elapsedSeconds?: number;
  stopReason?: RecordingCoverage["stopReason"];
  requestedPreRollSeconds: number;
  requestedPostRollSeconds: number;
  actualPostRollRecordingSeconds?: number;
  observedPostRollMediaSeconds?: number;
  postRollComplete?: boolean;
  attachmentCompleted?: boolean;
  attachmentCompleting?: Promise<void>;
  failed?: RecordingFailureFact;
}

const contentRequests = new Map<string, { resolve: (reply: ContentReplyMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; tabId: number; frameId: number }>();
const recordings = new Map<string, RecordingState>();

interface SourceStreamState {
  readonly requestId: string;
  readonly captureId: string;
  readonly jobId: string;
  readonly attachmentId: string;
  readonly tabId: number;
  readonly frameId: number;
  mimeType: string;
  offset: number;
  queue: Promise<void>;
  terminal: boolean;
  resolve: (value: SourceAcquisitionResult) => void;
  reject: (error: Error) => void;
  readonly completion: Promise<SourceAcquisitionResult>;
}

interface SourceAcquisitionResult {
  readonly captureId: string;
  readonly jobId: string;
  readonly attachmentId: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly acquisition: "extension_background_fetch" | "extension_page_fetch";
  readonly browserPlugin: "babel_content_clipper";
}

const sourceStreams = new Map<string, SourceStreamState>();
let profileIdPromise: Promise<string> | undefined;
let offscreenCreating: Promise<void> | undefined;
let reminders: ReturnType<typeof createReminderController>;
let mediaStateQueue: Promise<unknown> = Promise.resolve();
let mediaActionQueue: Promise<unknown> = Promise.resolve();
let mediaUpdateQueue: Promise<unknown> = Promise.resolve();
let initializePromise: Promise<void> | undefined;
let reconcilePromise: Promise<void> | undefined;

function withMediaStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = mediaStateQueue.then(operation);
  mediaStateQueue = result.catch(() => undefined);
  return result;
}

function withMediaActionLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = mediaActionQueue.then(operation);
  mediaActionQueue = result.catch(() => undefined);
  return result;
}

function errorResponse(error: unknown): { code: string; message: string; details?: unknown } {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message, ...(candidate.details === undefined ? {} : { details: candidate.details }) };
    }
  }
  return serializeClipperError(error);
}

async function profileId(): Promise<string> {
  profileIdPromise ??= (async () => {
    const stored = await chrome.storage.local.get(PROFILE_KEY);
    if (typeof stored[PROFILE_KEY] === "string" && stored[PROFILE_KEY].length > 10) return stored[PROFILE_KEY] as string;
    const next = crypto.randomUUID();
    await chrome.storage.local.set({ [PROFILE_KEY]: next });
    return next;
  })();
  return profileIdPromise;
}

async function readOpenMediaUnlocked(): Promise<Record<string, OpenMedia>> {
  const stored = await chrome.storage.local.get(MEDIA_STATE_KEY);
  const value = stored[MEDIA_STATE_KEY];
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => isOpenMedia(item))
      .map(([key, item]) => {
        const state = item as OpenMedia;
        return [key, {
          ...state,
          paddingBeforeSeconds: typeof state.paddingBeforeSeconds === "number" ? state.paddingBeforeSeconds : 0,
          paddingAfterSeconds: typeof state.paddingAfterSeconds === "number" ? state.paddingAfterSeconds : 0,
        } satisfies OpenMedia];
      }),
  );
}

async function writeOpenMediaUnlocked(value: Record<string, OpenMedia>): Promise<void> { await chrome.storage.local.set({ [MEDIA_STATE_KEY]: value }); }

async function readOpenMedia(): Promise<Record<string, OpenMedia>> {
  await mediaStateQueue.catch(() => undefined);
  return readOpenMediaUnlocked();
}

async function mutateOpenMedia<T>(operation: (value: Record<string, OpenMedia>) => Promise<T> | T): Promise<T> {
  return withMediaStateLock(async () => {
    const value = await readOpenMediaUnlocked();
    const result = await operation(value);
    await writeOpenMediaUnlocked(value);
    return result;
  });
}

function isOpenMedia(value: unknown): value is OpenMedia {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OpenMedia>;
  return typeof item.captureId === "string" && typeof item.requestId === "string" && typeof item.tabId === "number" && typeof item.frameId === "number" && typeof item.targetId === "string"
    && typeof item.source === "string" && typeof item.startedAt === "string" && typeof item.startedMediaSeconds === "number"
    && (item.paddingBeforeSeconds === undefined || typeof item.paddingBeforeSeconds === "number")
    && (item.paddingAfterSeconds === undefined || typeof item.paddingAfterSeconds === "number");
}

async function runCore<T = unknown>(method: string, params: unknown): Promise<T> {
  const result = await handleCore(method, params, { profileId: await profileId() });
  if (["capture.create", "capture.updateDraft", "capture.finalize", "library.setCollection", "job.claim", "job.heartbeat", "job.complete", "job.reprocess", "library.cleanupCommit", "settings.update", "backup.import", "attachment.create", "attachment.appendChunk", "attachment.complete"].includes(method)) {
    const revision = Date.now();
    await chrome.storage.local.set({ "babel_content_clipper.library_revision.v1": revision });
    native.notify("resource.changed", { revision, method });
  }
  if (method === "capture.create") {
    const response = result && typeof result === "object" ? result as { value?: unknown; ack?: unknown } : {};
    const value = response.value && typeof response.value === "object" ? response.value as { capture?: unknown } : {};
    const capture = value.capture && typeof value.capture === "object" ? value.capture as { captureId?: unknown; createdAt?: unknown } : {};
    const ack = response.ack && typeof response.ack === "object" ? response.ack as { revision?: unknown } : {};
    if (typeof capture.captureId === "string" && typeof capture.createdAt === "string" && typeof ack.revision === "number") {
      void reminders.captureCreated({ captureId: capture.captureId, createdAt: capture.createdAt }, ack.revision).catch(error => console.warn("Babel reminder scheduling failed", errorResponse(error)));
    }
  } else if (method === "settings.update") {
    void reminders.settingsChanged().catch(error => console.warn("Babel reminder reschedule failed", errorResponse(error)));
  }
  return result as T;
}

function requestContent(tabId: number, command: "capture_selection" | "capture_media" | "begin_region" | "acquire_media", context?: Record<string, unknown>): Promise<ContentReplyMessage> {
  const requestId = typeof context?.requestId === "string" && context.requestId.length > 0 ? context.requestId : crypto.randomUUID();
  const frameId = typeof context?.frameId === "number" && Number.isInteger(context.frameId) && context.frameId >= 0 ? context.frameId : 0;
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      contentRequests.delete(requestId);
      reject(failure("BROWSER_UNAVAILABLE", "页面内容脚本未在时限内响应。", { frameId }));
    }, command === "begin_region" ? 120_000 : 12_000);
    contentRequests.set(requestId, { resolve, reject, timer, tabId, frameId });
    void (async () => {
      const payload = { channel: EXTENSION_CHANNEL, type: "content_command", requestId, command, context };
      try {
        await chrome.tabs.sendMessage(tabId, payload, { frameId });
      } catch {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
        await chrome.tabs.sendMessage(tabId, payload, { frameId });
      }
    })().catch(error => {
      globalThis.clearTimeout(timer);
      contentRequests.delete(requestId);
      const classified = classifyContentAccessFailure(error, frameId);
      reject(failure(classified.code, classified.message, classified.details));
    });
  });
}

async function tabFromSender(sender: chrome.runtime.MessageSender): Promise<chrome.tabs.Tab> {
  if (!sender.tab?.id) throw new Error("BROWSER_UNAVAILABLE: 当前消息没有可用标签页。");
  return chrome.tabs.get(sender.tab.id);
}

async function sourceForTab(tabId: number): Promise<{ url: string; acquisitionUrl?: string; title: string }> {
  const tab = await chrome.tabs.get(tabId);
  const acquisitionUrl = typeof tab.url === "string" ? tab.url : undefined;
  return { url: redactUrl(tab.url ?? "about:blank"), ...(acquisitionUrl ? { acquisitionUrl } : {}), title: tab.title?.trim() || new URL(tab.url ?? "about:blank").hostname || "未命名来源" };
}

function normalizedContentContext(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const array = (candidate: unknown, limit: number, maxChars: number): string[] => Array.isArray(candidate)
    ? candidate
        .filter((item): item is string => typeof item === "string")
        .map((item) => truncateText(item.replace(/\s+/gu, " ").trim(), maxChars))
        .filter(Boolean)
        .slice(0, limit)
    : [];
  const descriptions = array(input.descriptions, 4, 8_000);
  const tags = array(input.tags, 100, 120);
  const commentCandidates = array(input.comments, 50, 800);
  const comments: string[] = [];
  let commentChars = 0;
  for (const comment of commentCandidates) {
    if (commentChars + comment.length > 16_000) break;
    comments.push(comment);
    commentChars += comment.length;
  }
  if (descriptions.length === 0 && tags.length === 0 && comments.length === 0) return undefined;
  return {
    descriptions,
    tags,
    comments,
    omittedCommentCount: typeof input.omittedCommentCount === "number" &&
      Number.isFinite(input.omittedCommentCount) && input.omittedCommentCount >= 0
      ? Math.floor(input.omittedCommentCount) + (commentCandidates.length - comments.length)
      : commentCandidates.length - comments.length,
  };
}

function normalizedSource(source: Record<string, unknown>, fallbackUrl = "about:blank", frameId?: number): Record<string, unknown> {
  const pageUrl = typeof source.url === "string" && source.url ? redactUrl(source.url) : fallbackUrl;
  const canonicalUrl = typeof source.canonicalUrl === "string" && source.canonicalUrl
    ? redactUrl(source.canonicalUrl)
    : undefined;
  const acquisitionUrl = typeof source.acquisitionUrl === "string" && source.acquisitionUrl
    ? source.acquisitionUrl
    : undefined;
  const mediaAcquisitionUrl = typeof source.mediaAcquisitionUrl === "string" && source.mediaAcquisitionUrl
    ? source.mediaAcquisitionUrl
    : undefined;
  const incomingMetadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
    ? source.metadata as Record<string, unknown>
    : undefined;
  const contentContext = normalizedContentContext(incomingMetadata?.contentContext);
  let site = "unknown";
  try { site = new URL(pageUrl).hostname || "unknown"; } catch { /* keep unknown */ }
  const frame = typeof source.documentInstanceId === "string" || typeof frameId === "number" ? { ...(typeof frameId === "number" ? { frameId } : {}), ...(typeof source.documentInstanceId === "string" ? { documentId: source.documentInstanceId } : {}), ...(typeof source.frameUrl === "string" ? { frameUrl: redactUrl(source.frameUrl) } : {}) } : undefined;
  return {
    title: typeof source.title === "string" ? truncateText(source.title, 4096) : "未命名来源",
    pageUrl,
    ...(acquisitionUrl ? { acquisitionUrl } : {}),
    ...(mediaAcquisitionUrl ? { mediaAcquisitionUrl } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    site,
    identityConfidence: "page_reported",
    ...(frame ? { frame } : {}),
    ...(contentContext === undefined ? {} : { metadata: { contentContext } }),
  };
}

function selectionImagePlan(selection: Record<string, unknown>): SelectionImagePlan {
  const rawImageRefs = Array.isArray(selection.imageRefs)
    ? selection.imageRefs.filter((item: unknown): item is string => typeof item === "string")
    : [];
  return planSelectionImages({
    imageRefs: rawImageRefs,
    ...(typeof selection.selectedImageCount === "number"
      ? { selectedImageCount: selection.selectedImageCount }
      : {}),
    ...(typeof selection.omittedImageReferenceCount === "number"
      ? { omittedReferenceCount: selection.omittedImageReferenceCount }
      : {}),
  });
}

function textInput(payload: Record<string, unknown>, frameId?: number): Record<string, unknown> {
  const selection = payload.selection && typeof payload.selection === "object" ? payload.selection as Record<string, unknown> : {};
  const source = payload.source && typeof payload.source === "object" ? payload.source as Record<string, unknown> : {};
  const imagePlan = selectionImagePlan(selection);
  const locatorMetadata: Record<string, unknown> = {
    ...(typeof selection.chapter === "string" ? { chapter: selection.chapter } : {}),
    ...(imagePlan.selectedImageCount > 0
      ? {
          imageReferences: imagePlan.references,
          selectedImageCount: imagePlan.selectedImageCount,
          preservedImageReferenceCount: imagePlan.referenceCount,
          imageReferenceLimit: MAX_SELECTION_IMAGE_REFERENCES,
          imageFetchLimit: MAX_SELECTION_IMAGE_FETCHES,
          omittedImageReferenceCount: imagePlan.omittedReferenceCount,
          missingImageReferenceCount: imagePlan.missingReferenceCount,
        }
      : {}),
  };
  return {
    source: normalizedSource(source, "about:blank", frameId),
    selection: { type: "text", exact: typeof selection.text === "string" ? selection.text : "", ...(typeof selection.html === "string" && selection.html ? { sanitizedHtml: selection.html } : {}), prefix: typeof selection.prefix === "string" ? selection.prefix : "", suffix: typeof selection.suffix === "string" ? selection.suffix : "", locator: { type: "text_quote", sourceConfidence: "page_reported", metadata: locatorMetadata } },
    kind: imagePlan.selectedImageCount > 0 || typeof selection.html === "string" && /<(?:img|video|audio|canvas|svg|object|embed|iframe)\b/iu.test(selection.html)
      ? "mixed_selection"
      : "text_selection",
    captureMethod: "selection",
    state: "sealed",
    assetsState: "saved",
    integrity: { status: "complete_selection", missing: [] },
  };
}

function bytesToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
  return btoa(binary);
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function dataUrlToBase64(dataUrl: string): Promise<{ mimeType: string; dataBase64: string } | undefined> {
  try {
    const image = await fetchImageBytes(dataUrl, { maxBytes: 20 * 1024 * 1024 });
    const buffer = ownedBuffer(image.bytes);
    const blob = new Blob([buffer], { type: image.mimeType });
    if (!await isDecodableImage(blob, image.mimeType)) return undefined;
    return { mimeType: image.mimeType, dataBase64: bytesToBase64(buffer) };
  } catch { return undefined; }
}

function hasImageSignature(bytes: Uint8Array): boolean {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 6 && ((bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && bytes[5] === 0x61))) return true;
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return true;
  return false;
}

async function isDecodableImage(blob: Blob, mimeType: string): Promise<boolean> {
  if (!mimeType.toLowerCase().startsWith("image/")) return false;
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
      return true;
    } catch { /* Fall through to a bounded signature check for formats unavailable to this worker. */ }
  }
  const bytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  if (hasImageSignature(bytes)) return true;
  if (mimeType.toLowerCase() === "image/svg+xml") {
    const prefix = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trimStart().toLowerCase();
    return prefix.startsWith("<svg") || prefix.startsWith("<?xml");
  }
  return false;
}

function base64ToArrayBuffer(dataBase64: string): ArrayBuffer {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function persistAttachment(dataBase64: string, mimeType: string, kind: "source_image" | "screen_region" | "browser_recording", captureId?: string): Promise<string> {
  const created = await runCore("attachment.create", { requestId: crypto.randomUUID(), ...(captureId ? { captureId } : {}), kind, mimeType, storage: "chunked", expectedTotalBytes: base64ToArrayBuffer(dataBase64).byteLength }) as { value?: { attachmentId?: unknown }; attachmentId?: unknown };
  const attachmentId = typeof created?.value?.attachmentId === "string" ? created.value.attachmentId : typeof created?.attachmentId === "string" ? created.attachmentId : "";
  if (!attachmentId) throw new Error("ATTACHMENT_UNAVAILABLE: 附件创建未返回 attachmentId。");
  const bytes = new Uint8Array(base64ToArrayBuffer(dataBase64));
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_RECORDING_CHUNK_BYTES) {
    const chunk = bytes.slice(offset, Math.min(offset + MAX_RECORDING_CHUNK_BYTES, bytes.byteLength));
    await runCore("attachment.appendChunk", { requestId: crypto.randomUUID(), attachmentId, offset, dataBase64: bytesToBase64(chunk.buffer) });
  }
  await runCore("attachment.complete", { requestId: crypto.randomUUID(), attachmentId, totalBytes: bytes.byteLength });
  return attachmentId;
}

interface SourceAcquisitionInput {
  readonly requestId: string;
  readonly captureId: string;
  readonly jobId: string;
  readonly claimToken: string;
}

function sourceAcquisitionInput(value: unknown): SourceAcquisitionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("VALIDATION_ERROR", "媒体取源请求必须是对象。");
  const input = value as Record<string, unknown>;
  const fields = ["requestId", "captureId", "jobId", "claimToken"] as const;
  if (fields.some(field => typeof input[field] !== "string" || !(input[field] as string).trim())) {
    throw failure("VALIDATION_ERROR", "媒体取源请求缺少 requestId、captureId、jobId 或 claimToken。");
  }
  return {
    requestId: String(input.requestId),
    captureId: String(input.captureId),
    jobId: String(input.jobId),
    claimToken: String(input.claimToken),
  };
}

function normalizedMimeType(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mimeType && mimeType.length <= 512 && /^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/u.test(mimeType) ? mimeType : fallback;
}

function guessedMediaMimeType(url: string, captureKind: unknown): string {
  const pathname = (() => {
    try { return new URL(url).pathname.toLowerCase(); }
    catch { return url.toLowerCase(); }
  })();
  if (/\.m3u8$/u.test(pathname)) return "application/vnd.apple.mpegurl";
  if (/\.mpd$/u.test(pathname)) return "application/dash+xml";
  if (/\.webm$/u.test(pathname)) return "video/webm";
  if (/\.(?:mp3|mpeg)$/u.test(pathname)) return "audio/mpeg";
  if (/\.(?:m4a|aac|wav|ogg|opus)$/u.test(pathname)) return "audio/mp4";
  if (captureKind === "audio_range") return "audio/mp4";
  return "video/mp4";
}

function sourceAttachmentId(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const result = value as { value?: unknown; attachmentId?: unknown };
  const nested = result.value && typeof result.value === "object" ? result.value as { attachmentId?: unknown } : undefined;
  return typeof nested?.attachmentId === "string" ? nested.attachmentId : typeof result.attachmentId === "string" ? result.attachmentId : "";
}

async function createSourceAttachment(
  input: SourceAcquisitionInput,
  mimeType: string,
  expectedTotalBytes?: number,
): Promise<string> {
  const result = await runCore("attachment.create", {
    requestId: `${input.requestId}:create`,
    captureId: input.captureId,
    jobId: input.jobId,
    kind: "other",
    mimeType,
    storage: "chunked",
    ...(expectedTotalBytes === undefined ? {} : { expectedTotalBytes }),
  });
  const attachmentId = sourceAttachmentId(result);
  if (!attachmentId) throw failure("ATTACHMENT_UNAVAILABLE", "扩展未能为源媒体建立本地附件。");
  return attachmentId;
}

async function appendSourceBytes(attachmentId: string, offset: number, bytes: Uint8Array): Promise<number> {
  let current = offset;
  for (let start = 0; start < bytes.byteLength; start += MAX_SOURCE_CHUNK_BYTES) {
    const chunk = bytes.slice(start, Math.min(start + MAX_SOURCE_CHUNK_BYTES, bytes.byteLength));
    await runCore("attachment.appendChunk", {
      requestId: crypto.randomUUID(),
      attachmentId,
      offset: current,
      dataBase64: bytesToBase64(ownedBuffer(chunk)),
    });
    current += chunk.byteLength;
  }
  return current;
}

async function completeSourceAttachment(attachmentId: string, totalBytes: number, interrupted: boolean): Promise<void> {
  await runCore("attachment.complete", {
    requestId: crypto.randomUUID(),
    attachmentId,
    totalBytes,
    interrupted,
  });
}

async function streamResponseIntoAttachment(
  response: Response,
  attachmentId: string,
): Promise<number> {
  let offset = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value?.byteLength) offset = await appendSourceBytes(attachmentId, offset, next.value);
      }
    } else {
      offset = await appendSourceBytes(attachmentId, 0, new Uint8Array(await response.arrayBuffer()));
    }
    await completeSourceAttachment(attachmentId, offset, false);
    return offset;
  } catch (error) {
    await completeSourceAttachment(attachmentId, offset, true).catch(() => undefined);
    throw error;
  }
}

function comparableUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

async function findSourceTab(pageUrl: unknown, publicPageUrl: unknown, frameId: number): Promise<{ tabId: number; frameId: number } | undefined> {
  const privateUrl = comparableUrl(pageUrl);
  const publicUrl = comparableUrl(publicPageUrl);
  if (!privateUrl && !publicUrl) return undefined;
  const tabs = await chrome.tabs.query({});
  const exact = tabs.find(tab => {
    const tabUrl = comparableUrl(tab.url);
    return tab.id !== undefined && tabUrl !== undefined && (tabUrl === privateUrl || tabUrl === publicUrl);
  });
  if (exact?.id !== undefined) return { tabId: exact.id, frameId };
  const candidates = tabs.filter(tab => {
    if (tab.id === undefined) return false;
    const tabUrl = comparableUrl(tab.url);
    if (!tabUrl) return false;
    try {
      const current = new URL(tabUrl);
      const target = new URL(privateUrl ?? publicUrl!);
      return current.origin === target.origin && current.pathname === target.pathname;
    } catch {
      return false;
    }
  });
  return candidates.length === 1 && candidates[0]?.id !== undefined
    ? { tabId: candidates[0].id, frameId }
    : undefined;
}

function mediaResponseType(response: Response, fallbackUrl: string, captureKind: unknown): string {
  return normalizedMimeType(response.headers.get("content-type"), guessedMediaMimeType(fallbackUrl, captureKind));
}

function isClearlyNotMedia(response: Response, sourceUrl: string, pageUrl: unknown): boolean {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "text/html" || contentType === "application/xhtml+xml" || contentType === "application/json") return true;
  const normalizedSource = comparableUrl(sourceUrl);
  const normalizedPage = comparableUrl(pageUrl);
  return normalizedSource !== undefined && normalizedPage !== undefined && normalizedSource === normalizedPage;
}

async function handleSourceStreamMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (!isSourceStreamMessage(message) || !isContentSender(sender)) return undefined;
  const value = message as unknown as Record<string, unknown>;
  const requestId = String(value.requestId);
  const stream = sourceStreams.get(requestId);
  if (!stream || sender.tab?.id !== stream.tabId || (sender.frameId ?? 0) !== stream.frameId) return { ok: false, error: errorResponse(failure("FORBIDDEN", "媒体流不属于当前取源请求。")) };

  if (value.type === "source_stream_start") {
    const mimeType = normalizedMimeType(value.mimeType, stream.mimeType);
    stream.mimeType = mimeType;
    return { ok: true };
  }

  if (value.type === "source_stream_chunk") {
    if (stream.terminal || typeof value.dataBase64 !== "string" || typeof value.offset !== "number" || value.offset !== stream.offset) {
      throw failure("SOURCE_STREAM_INVALID", "媒体分块的顺序或请求状态无效。");
    }
    const bytes = new Uint8Array(base64ToArrayBuffer(value.dataBase64));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_CHUNK_BYTES) throw failure("SOURCE_STREAM_INVALID", "媒体分块大小无效。");
    stream.queue = stream.queue.then(async () => {
      stream.offset = await appendSourceBytes(stream.attachmentId, stream.offset, bytes);
    });
    await stream.queue;
    return { ok: true };
  }

  if (value.type === "source_stream_complete") {
    if (stream.terminal || typeof value.totalBytes !== "number" || value.totalBytes !== stream.offset) throw failure("SOURCE_STREAM_INVALID", "媒体流结束信息无效。");
    await stream.queue;
    stream.terminal = true;
    await completeSourceAttachment(stream.attachmentId, stream.offset, false);
    const result: SourceAcquisitionResult = {
      captureId: stream.captureId,
      jobId: stream.jobId,
      attachmentId: stream.attachmentId,
      mimeType: stream.mimeType,
      byteLength: stream.offset,
      acquisition: "extension_page_fetch",
      browserPlugin: "babel_content_clipper",
    };
    stream.resolve(result);
    return { ok: true };
  }

  const errorValue = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
  const streamError = sanitizeSourceAcquisitionError(errorValue);
  if (!stream.terminal) {
    stream.terminal = true;
    await stream.queue.catch(() => undefined);
    await completeSourceAttachment(stream.attachmentId, stream.offset, true).catch(() => undefined);
    stream.reject(streamError);
  }
  return { ok: true };
}

async function acquireSourceMedia(value: unknown): Promise<SourceAcquisitionResult> {
  const input = sourceAcquisitionInput(value);
  const source = await runCore<Record<string, unknown>>("capture.getAcquisitionSource", {
    captureId: input.captureId,
    jobId: input.jobId,
    claimToken: input.claimToken,
  });
  const detail = await runCore<CaptureDetailResult>("capture.get", { captureId: input.captureId });
  const captureKind = detail.capture.kind;
  const mediaUrl = typeof source.mediaUrl === "string" ? source.mediaUrl : undefined;
  const pageUrl = typeof source.pageUrl === "string" ? source.pageUrl : source.publicPageUrl;
  let directError: unknown;

  if (mediaUrl && /^https?:/iu.test(mediaUrl)) {
    try {
      const response = await fetch(mediaUrl, { credentials: "include", redirect: "follow", ...(typeof pageUrl === "string" ? { referrer: pageUrl } : {}) });
      if (!response.ok) throw failure("SOURCE_FETCH_FAILED", `扩展后台取源返回 HTTP ${response.status}。`, { status: response.status });
      if (isClearlyNotMedia(response, mediaUrl, pageUrl)) throw failure("SOURCE_NOT_MEDIA", "扩展后台取得的是页面文档，不是媒体文件。");
      const mimeType = mediaResponseType(response, mediaUrl, captureKind);
      const lengthHeader = Number(response.headers.get("content-length"));
      const expectedTotalBytes = Number.isSafeInteger(lengthHeader) && lengthHeader >= 0 ? lengthHeader : undefined;
      const attachmentId = await createSourceAttachment(input, mimeType, expectedTotalBytes);
      const byteLength = await streamResponseIntoAttachment(response, attachmentId);
      return { captureId: input.captureId, jobId: input.jobId, attachmentId, mimeType, byteLength, acquisition: "extension_background_fetch", browserPlugin: "babel_content_clipper" };
    } catch (error) {
      directError = sanitizeSourceAcquisitionError(error);
    }
  }

  const frameId = detail.capture.source.frame?.frameId ?? 0;
  const tab = await findSourceTab(pageUrl, source.publicPageUrl, frameId);
  if (!tab) {
    if (directError) throw directError;
    throw failure("BROWSER_TAB_UNAVAILABLE", "找不到保存这条记录时对应的网页标签页；请重新打开来源页面后再让 Agent 调用扩展取源。", { pageUrl: typeof pageUrl === "string" ? redactUrl(pageUrl) : undefined });
  }
  const fallbackUrl = mediaUrl && !/^https?:/iu.test(mediaUrl) ? mediaUrl : undefined;
  const mimeType = guessedMediaMimeType(fallbackUrl ?? "", captureKind);
  const attachmentId = await createSourceAttachment(input, mimeType);
  let resolveCompletion!: (result: SourceAcquisitionResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<SourceAcquisitionResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const stream: SourceStreamState = {
    requestId: crypto.randomUUID(),
    captureId: input.captureId,
    jobId: input.jobId,
    attachmentId,
    tabId: tab.tabId,
    frameId: tab.frameId,
    mimeType,
    offset: 0,
    queue: Promise.resolve(),
    terminal: false,
    resolve: resolveCompletion,
    reject: rejectCompletion,
    completion,
  };
  sourceStreams.set(stream.requestId, stream);
  try {
    const response = await requestContent(tab.tabId, "acquire_media", {
      frameId: tab.frameId,
      requestId: stream.requestId,
      ...(fallbackUrl ? { sourceUrl: fallbackUrl } : {}),
    });
    if (!response.ok) throw failure(response.error?.code ?? "SOURCE_FETCH_FAILED", response.error?.message ?? "页面上下文无法获取媒体。", response.error?.details);
    return await completion;
  } catch (error) {
    if (!stream.terminal) {
      stream.terminal = true;
      await stream.queue.catch(() => undefined);
      await completeSourceAttachment(stream.attachmentId, stream.offset, true).catch(() => undefined);
    }
    throw error;
  } finally {
    sourceStreams.delete(stream.requestId);
  }
}

async function cropScreenshot(dataUrl: string, rect: { x: number; y: number; width: number; height: number; devicePixelRatio?: number }): Promise<{ dataUrl: string; cropped: boolean }> {
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return { dataUrl, cropped: false };
    const response = await fetch(dataUrl);
    const bitmap = await createImageBitmap(await response.blob());
    const scale = Math.max(1, rect.devicePixelRatio ?? 1);
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return { dataUrl, cropped: false };
    context.drawImage(bitmap, Math.round(rect.x * scale), Math.round(rect.y * scale), width, height, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { dataUrl: `data:image/png;base64,${bytesToBase64(await blob.arrayBuffer())}`, cropped: true };
  } catch { return { dataUrl, cropped: false }; }
}

async function captureSelection(tabId: number, context?: Record<string, unknown>): Promise<unknown> {
  const result = await requestContent(tabId, "capture_selection", context);
  if (!result.ok) {
    const failure = new Error(result.error?.message ?? "未取得有效选区。");
    if (result.error?.code) Object.assign(failure, result.error);
    throw failure;
  }
  if (!result.payload || typeof result.payload !== "object") throw new Error("CONTENT_CAPTURE_FAILED: 未取得有效选区。");
  const payload = result.payload as Record<string, unknown>;
  const input = textInput(payload, typeof context?.frameId === "number" ? context.frameId : undefined);
  const selection = input.selection as Record<string, unknown>;
  if (!selection.exact) throw new Error("SELECTION_EMPTY: 未取得有效文字。");
  const rawSelection = payload.selection && typeof payload.selection === "object"
    ? payload.selection as Record<string, unknown>
    : {};
  const imagePlan = selectionImagePlan(rawSelection);
  if (imagePlan.selectedImageCount > 0) {
    const attachmentIds: string[] = [];
    for (const imageRef of imagePlan.fetchReferences) {
      try {
        const image = await dataUrlToBase64(imageRef);
        if (!image) continue;
        attachmentIds.push(await persistAttachment(image.dataBase64, image.mimeType, "source_image"));
      } catch { /* Preserve the source HTML and mark the missing image bytes below. */ }
    }
    if (attachmentIds.length > 0) input.attachmentIds = attachmentIds;
    const failedFetchCount = imagePlan.fetchReferences.length - attachmentIds.length;
    const unsavedImageCount = failedFetchCount + imagePlan.skippedFetchCount;
    const locator = selection.locator && typeof selection.locator === "object"
      ? selection.locator as Record<string, unknown>
      : {};
    const metadata = locator.metadata && typeof locator.metadata === "object"
      ? locator.metadata as Record<string, unknown>
      : {};
    input.selection = {
      ...selection,
      locator: {
        ...locator,
        metadata: {
          ...metadata,
          savedImageByteCount: attachmentIds.length,
          failedImageFetchCount: failedFetchCount,
          skippedImageFetchCount: imagePlan.skippedFetchCount,
          unsavedImageByteCount: unsavedImageCount,
        },
      },
    };
    if (unsavedImageCount > 0) {
      input.assetsState = attachmentIds.length > 0 ? "partial_saved" : "location_only";
      input.integrity = {
        status: "partial",
        missing: [
          "image_bytes",
          ...(imagePlan.skippedFetchCount > 0 ? ["image_fetch_limit"] : []),
          ...(imagePlan.omittedReferenceCount > 0 || imagePlan.missingReferenceCount > 0
            ? ["image_references"]
            : []),
        ],
      };
    }
  }
  return runCore("capture.create", { requestId: crypto.randomUUID(), input });
}

async function captureImage(tabId: number, context?: Record<string, unknown>): Promise<unknown> {
  const source = await sourceForTab(tabId);
  const url = typeof context?.srcUrl === "string" ? redactUrl(context.srcUrl) : source.url;
  const pageSource = { ...source, ...(typeof context?.frameUrl === "string" ? { url: redactUrl(context.frameUrl) } : {}) };
  let attachmentId: string | undefined;
  let assetsState: "location_only" | "saved" = "location_only";
  try {
    const image = await fetchImageBytes(url, { maxBytes: 20 * 1024 * 1024 });
    const buffer = ownedBuffer(image.bytes);
    const blob = new Blob([buffer], { type: image.mimeType });
    if (await isDecodableImage(blob, image.mimeType)) {
      attachmentId = await persistAttachment(bytesToBase64(buffer), image.mimeType, "source_image");
      assetsState = "saved";
    }
  } catch { /* Keep reference-only fact. */ }
  return runCore("capture.create", { requestId: crypto.randomUUID(), input: { kind: "image", state: "sealed", source: normalizedSource(pageSource, "about:blank", typeof context?.frameId === "number" ? context.frameId : undefined), selection: { type: "image", resourceUrl: url }, captureMethod: "context-menu-image", assetsState, ...(attachmentId ? { attachmentIds: [attachmentId] } : {}), integrity: { status: assetsState === "saved" ? "complete_selection" : "partial", missing: assetsState === "saved" ? [] : ["image_bytes"] } } });
}

async function captureRegion(tabId: number, context?: Record<string, unknown>): Promise<unknown> {
  const result = await requestContent(tabId, "begin_region", context);
  if (!result.ok) {
    const failure = new Error(result.error?.message ?? "框选未完成。");
    if (result.error?.code) Object.assign(failure, result.error);
    throw failure;
  }
  if (!result.payload || typeof result.payload !== "object") throw new Error("CONTENT_CAPTURE_FAILED: 框选未完成。");
  const payload = result.payload as { rect?: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number; scrollX?: number; scrollY?: number; devicePixelRatio?: number }; source?: { url?: string; title?: string; documentInstanceId?: string } };
  const rect = payload.rect;
  if (!rect) throw new Error("REGION_EMPTY: 未取得框选范围。");
  const dataUrl = await chrome.tabs.captureVisibleTab((await chrome.tabs.get(tabId)).windowId, { format: "png" });
  const cropped = await cropScreenshot(dataUrl, rect);
  if (!cropped.cropped) throw new Error("REGION_CROP_UNAVAILABLE: 当前环境无法安全裁剪截图，未将整页截图冒充框选结果。");
  const image = await dataUrlToBase64(cropped.dataUrl);
  if (!image) throw new Error("ASSET_UNAVAILABLE: 无法保存框选截图。");
  const attachmentId = await persistAttachment(image.dataBase64, image.mimeType, "screen_region");
  return runCore("capture.create", { requestId: crypto.randomUUID(), input: { kind: "region_capture", state: "sealed", source: normalizedSource(payload.source ?? {}, "about:blank", typeof context?.frameId === "number" ? context.frameId : undefined), selection: { type: "region", x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: rect.viewportWidth, viewportHeight: rect.viewportHeight, devicePixelRatio: rect.devicePixelRatio ?? 1 }, captureMethod: "screen-region", assetsState: "saved", attachmentIds: [attachmentId], integrity: { status: "complete_selection", missing: [] } } });
}

async function ensureOffscreen(): Promise<void> {
  if (!chrome.offscreen?.createDocument) throw Object.assign(new Error("当前 Chrome 没有 offscreen API。"), { code: "RECORDER_UNAVAILABLE" });
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = (async () => {
    const contexts = "getContexts" in chrome.runtime
      ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)] })
      : [];
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({ url: OFFSCREEN_PATH, reasons: ["USER_MEDIA", "BLOBS"], justification: "用户明确开启本次现场音画保存。" });
    }
  })().finally(() => { offscreenCreating = undefined; });
  return offscreenCreating;
}

function failure(code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

function sanitizeSourceAcquisitionError(error: unknown): Error {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; details?: unknown }
    : {};
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const details = candidate.details && typeof candidate.details === "object"
    ? candidate.details as Record<string, unknown>
    : {};
  const status = typeof details.status === "number" && Number.isInteger(details.status) && details.status >= 100 && details.status <= 599
    ? details.status
    : undefined;
  if (code === "SOURCE_NOT_MEDIA") return failure(code, "扩展取得的响应不是媒体文件。");
  if (code === "SOURCE_MEDIA_URL_UNAVAILABLE") return failure(code, "当前页面没有可获取的媒体地址。");
  if (code === "BROWSER_TAB_UNAVAILABLE") return failure(code, "找不到保存这条记录时对应的网页标签页；请重新打开来源页面后再让 Agent 调用扩展取源。");
  if (code === "SOURCE_FETCH_FAILED") {
    return failure(code, status === undefined ? "扩展无法获取源媒体。" : `扩展取源返回 HTTP ${status}。`, status === undefined ? undefined : { status });
  }
  return failure("SOURCE_FETCH_FAILED", "扩展无法获取源媒体。");
}

interface RecorderRuntimeStatus {
  readonly ok?: boolean;
  readonly active?: boolean;
  readonly recordingId?: string;
  readonly started?: boolean;
  readonly startedAt?: string;
  readonly elapsedSeconds?: number;
  readonly hasAudio?: boolean;
  readonly hasVideo?: boolean;
  readonly audioMonitor?: boolean;
  readonly stopRequested?: boolean;
  readonly stopReason?: RecordingCoverage["stopReason"];
  readonly error?: { code?: string; message?: string };
}

async function queryRecorder(recordingId?: string): Promise<RecorderRuntimeStatus> {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "recorder_status_query", ...(recordingId ? { recordingId } : {}) }) as RecorderRuntimeStatus | undefined;
  if (!response?.ok) throw failure(response?.error?.code ?? "RECORDER_UNAVAILABLE", response?.error?.message ?? "录制上下文没有返回状态。");
  return response;
}

function makeRecordingFailure(
  error: unknown,
  stage: RecordingFailureFact["stage"],
  started: boolean,
): RecordingFailureFact {
  const serialized = errorResponse(error);
  return recordingFailureFact(serialized, stage, started);
}

async function createRecordingAttachment(state: OpenMedia, recordingId: string): Promise<string> {
  const result = await runCore("attachment.create", {
    requestId: `recording:${recordingId}:attachment`,
    captureId: state.captureId,
    kind: "browser_recording",
    mimeType: "video/webm",
    storage: "chunked",
  }) as { value?: { attachmentId?: unknown }; attachmentId?: unknown };
  const attachmentId = typeof result.value?.attachmentId === "string"
    ? result.value.attachmentId
    : typeof result.attachmentId === "string" ? result.attachmentId : "";
  if (!attachmentId) throw failure("ATTACHMENT_UNAVAILABLE", "无法为现场录制建立附件。");
  return attachmentId;
}

async function recoverRecording(recordingId: string): Promise<RecordingState | undefined> {
  const open = await readOpenMedia();
  const state = Object.values(open).find(item => item.recordingId === recordingId && item.attachmentId);
  if (!state?.attachmentId) return undefined;
  try {
    const metadata = await runCore("attachment.get", { attachmentId: state.attachmentId, encoding: "metadata", maxBytes: 1 }) as { attachment?: { byteLength?: unknown; status?: unknown }; totalBytes?: unknown };
    const persistedBytes = typeof state.recordingTotalBytes === "number" && state.recordingTotalBytes >= 0 ? state.recordingTotalBytes : 0;
    const storedBytes = typeof metadata.totalBytes === "number" && metadata.totalBytes >= 0
      ? metadata.totalBytes
      : typeof metadata.attachment?.byteLength === "number" && metadata.attachment.byteLength >= 0 ? metadata.attachment.byteLength : 0;
    const recording: RecordingState = {
      recordingId,
      captureId: state.captureId,
      attachmentId: state.attachmentId,
      offset: Math.max(persistedBytes, storedBytes),
      totalBytes: Math.max(persistedBytes, storedBytes),
      chunkCount: 0,
      maxBytes: state.recordingMaxBytes,
      maxSeconds: state.recordingMaxSeconds,
      started: state.recordingStatus === "started" || state.recordingStatus === "stopped",
      stopped: state.recordingStatus === "stopped" || metadata.attachment?.status === "complete" || metadata.attachment?.status === "interrupted",
      audioMonitor: state.recordingAudioMonitor,
      hasAudio: state.recordingHasAudio,
      hasVideo: state.recordingHasVideo,
      startedAt: state.recordingStartedAt,
      stoppedAt: state.recordingStoppedAt,
      elapsedSeconds: state.recordingElapsedSeconds,
      stopReason: state.recordingStopReason,
      requestedPreRollSeconds: state.paddingBeforeSeconds,
      requestedPostRollSeconds: state.paddingAfterSeconds,
      actualPostRollRecordingSeconds: state.actualPostRollRecordingSeconds,
      observedPostRollMediaSeconds: state.observedPostRollMediaSeconds,
      postRollComplete: state.postRollComplete,
      attachmentCompleted: metadata.attachment?.status === "complete" || metadata.attachment?.status === "interrupted",
      failed: state.recordingFailure ?? (state.recordingStatus === "failed" ? {
        code: "RECORDER_STATE_LOST",
        message: "录制上下文已丢失；保留已经落库的分块。",
        stage: state.recordingStartedAt ? "stream" : "start",
        started: Boolean(state.recordingStartedAt),
      } : undefined),
    };
    recordings.set(recordingId, recording);
    return recording;
  } catch {
    return undefined;
  }
}

function recordingCoverage(recording: RecordingState): RecordingCoverage | undefined {
  if (recording.started !== true || !recording.startedAt || !recording.stoppedAt || recording.elapsedSeconds === undefined) return undefined;
  return {
    timeBasis: "recording_elapsed",
    recordingStartedAt: recording.startedAt,
    recordingStoppedAt: recording.stoppedAt,
    elapsedSeconds: Math.max(0, recording.elapsedSeconds),
    requestedPreRollSeconds: Math.max(0, recording.requestedPreRollSeconds),
    actualPreRollSeconds: 0,
    requestedPostRollSeconds: Math.max(0, recording.requestedPostRollSeconds),
    actualPostRollRecordingSeconds: Math.max(0, Math.min(recording.elapsedSeconds, recording.actualPostRollRecordingSeconds ?? 0)),
    ...(recording.observedPostRollMediaSeconds === undefined ? {} : { observedPostRollMediaSeconds: Math.max(0, recording.observedPostRollMediaSeconds) }),
    postRollComplete: recording.postRollComplete === true,
    stopReason: recording.stopReason ?? (recording.failed ? "recorder_error" : "unavailable"),
    hasAudio: recording.hasAudio === true,
    hasVideo: recording.hasVideo === true,
    audioMonitor: recording.audioMonitor === true,
  };
}

async function completeRecordingAttachment(recording: RecordingState, interrupted: boolean): Promise<void> {
  if (!recording.attachmentId || recording.attachmentCompleted) return;
  if (recording.attachmentCompleting) return recording.attachmentCompleting;
  recording.attachmentCompleting = (async () => {
    const coverage = recordingCoverage(recording);
    try {
      await runCore("attachment.complete", {
        requestId: `recording:${recording.recordingId}:complete`,
        attachmentId: recording.attachmentId,
        totalBytes: recording.totalBytes,
        interrupted,
        ...(coverage ? { recordingCoverage: coverage } : {}),
        ...(recording.failed ? { recordingFailure: recording.failed } : {}),
      });
      recording.attachmentCompleted = true;
    } catch (error) {
      recording.failed ??= makeRecordingFailure(error, "stop", recording.started === true);
      throw error;
    } finally {
      recording.attachmentCompleting = undefined;
    }
  })();
  return recording.attachmentCompleting;
}

async function waitRecordingStarted(recordingId: string, timeoutMs = 5_000): Promise<RecordingState | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recording = recordings.get(recordingId);
    if (!recording || recording.started || recording.failed) return recording;
    await new Promise<void>(resolve => globalThis.setTimeout(resolve, 50));
  }
  return recordings.get(recordingId);
}

async function waitRecordingStopped(recordingId: string, timeoutMs = 8_000): Promise<RecordingState | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recording = recordings.get(recordingId) ?? await recoverRecording(recordingId);
    if (!recording || recording.stopped) return recording;
    await new Promise<void>(resolve => globalThis.setTimeout(resolve, 50));
  }
  return recordings.get(recordingId);
}

async function persistRecordingState(recording: RecordingState, status: OpenMedia["recordingStatus"]): Promise<void> {
  await mutateOpenMedia(open => {
    const key = Object.keys(open).find(item => open[item]?.recordingId === recording.recordingId);
    const state = key ? open[key] : undefined;
    if (!key || !state) return;
    const updated: OpenMedia = {
      ...state,
      recordingStatus: status,
      recordingOffset: recording.offset,
      recordingTotalBytes: recording.totalBytes,
      ...(recording.startedAt ? { recordingStartedAt: recording.startedAt } : {}),
      ...(recording.stoppedAt ? { recordingStoppedAt: recording.stoppedAt } : {}),
      ...(recording.elapsedSeconds === undefined ? {} : { recordingElapsedSeconds: recording.elapsedSeconds }),
      ...(recording.stopReason ? { recordingStopReason: recording.stopReason } : {}),
      ...(recording.hasAudio === undefined ? {} : { recordingHasAudio: recording.hasAudio }),
      ...(recording.hasVideo === undefined ? {} : { recordingHasVideo: recording.hasVideo }),
      ...(recording.audioMonitor === undefined ? {} : { recordingAudioMonitor: recording.audioMonitor }),
      ...(recording.failed ? { recordingFailure: recording.failed } : {}),
      ...(recording.actualPostRollRecordingSeconds === undefined ? {} : { actualPostRollRecordingSeconds: recording.actualPostRollRecordingSeconds }),
      ...(recording.observedPostRollMediaSeconds === undefined ? {} : { observedPostRollMediaSeconds: recording.observedPostRollMediaSeconds }),
      ...(recording.postRollComplete === undefined ? {} : { postRollComplete: recording.postRollComplete }),
    };
    if (!recording.startedAt) delete updated.recordingStartedAt;
    if (recording.elapsedSeconds === undefined) delete updated.recordingElapsedSeconds;
    open[key] = updated;
  });
}

async function startRecording(state: OpenMedia): Promise<void> {
  const openBefore = await readOpenMedia();
  const busy = Object.values(openBefore).find(item => item.recordLive && item.recordingId && item.recordingStatus !== "failed" && item.recordingStatus !== "stopped" && item.captureId !== state.captureId);
  if (busy) {
    state.recordingStatus = "failed";
    throw failure("RECORDER_BUSY", "另一个标签页正在进行现场录制；请先结束它。");
  }
  const recordingId = crypto.randomUUID();
  const recording: RecordingState = {
    recordingId,
    captureId: state.captureId,
    offset: 0,
    totalBytes: 0,
    chunkCount: 0,
    requestedPreRollSeconds: state.paddingBeforeSeconds,
    requestedPostRollSeconds: state.paddingAfterSeconds,
  };
  recordings.set(recordingId, recording);
  state.recordingId = recordingId;
  state.recordingStatus = "starting";
  await mutateOpenMedia(open => { open[String(state.tabId)] = { ...state }; });
  try {
    const settings = await runCore<Record<string, unknown>>("settings.get", {});
    recording.maxBytes = typeof settings.maxRecordingBytes === "number" && settings.maxRecordingBytes > 0 ? settings.maxRecordingBytes : MAX_RECORDING_BYTES;
    recording.maxSeconds = typeof settings.maxRecordingSeconds === "number" && settings.maxRecordingSeconds > 0 ? settings.maxRecordingSeconds : 600;
    recording.attachmentId = await createRecordingAttachment(state, recordingId);
    state.attachmentId = recording.attachmentId;
    state.recordingMaxBytes = recording.maxBytes;
    state.recordingMaxSeconds = recording.maxSeconds;
    state.recordingOffset = 0;
    state.recordingTotalBytes = 0;
    await mutateOpenMedia(open => { open[String(state.tabId)] = { ...state }; });
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.tabId });
    const response = await chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "recorder_start", recordingId, streamId, maxDurationSeconds: recording.maxSeconds }) as { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
    if (!response?.ok) throw failure(response?.error?.code ?? "RECORDER_UNAVAILABLE", response?.error?.message ?? "offscreen 录制上下文未确认启动。");
    const started = await waitRecordingStarted(recordingId);
    if (!started?.started || started.failed) throw failure(started?.failed?.code ?? "RECORDER_UNAVAILABLE", started?.failed?.message ?? "现场录制未确认真实音画轨道和原音频回放。");
    state.recordingStatus = "started";
    await persistRecordingState(started, "started");
  } catch (error) {
    recording.failed = makeRecordingFailure(error, "start", recording.started === true);
    if (!recording.stopped && !recording.stoppedRequested) {
      recording.stoppedRequested = true;
      await chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "recorder_stop", recordingId, reason: "recorder_error" }).catch(() => undefined);
      if (recording.started) await waitRecordingStopped(recordingId, 8_000);
    }
    if (!recording.attachmentCompleted) {
      recording.stoppedAt ??= new Date().toISOString();
      recording.elapsedSeconds ??= recording.startedAt ? Math.max(0, (Date.now() - Date.parse(recording.startedAt)) / 1_000) : 0;
      recording.stopReason ??= "recorder_error";
      await completeRecordingAttachment(recording, true).catch(() => undefined);
    }
    recording.stopped = true;
    state.recordingStatus = "failed";
    await persistRecordingState(recording, "failed");
  }
}

async function markRecordingFailed(recording: RecordingState, code: string, message: string, stopReason: RecordingCoverage["stopReason"]): Promise<never> {
  recording.failed = { code, message: truncateText(message, 4_096), stage: "chunk", started: recording.started === true };
  recording.stopReason = stopReason;
  await persistRecordingState(recording, "failed");
  if (!recording.stoppedRequested) {
    recording.stoppedRequested = true;
    void chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "recorder_stop", recordingId: recording.recordingId, reason: stopReason }).catch(() => undefined);
  }
  throw failure(code, message);
}

async function handleRecorderChunk(message: { recordingId: string; chunkIndex: number; offset: number; mimeType: string; dataBase64: string }): Promise<void> {
  const recording = recordings.get(message.recordingId) ?? await recoverRecording(message.recordingId);
  if (!recording || recording.failed || recording.attachmentCompleted) throw failure("RECORDER_STATE_LOST", "后台没有可写的现场录制状态，未确认分块落库。");
  let data: ArrayBuffer;
  try { data = base64ToArrayBuffer(message.dataBase64); }
  catch { return markRecordingFailed(recording, "ATTACHMENT_WRITE_FAILED", "现场录制分块不是有效 Base64。", "chunk_failure"); }
  if (!Number.isInteger(message.offset) || message.offset < 0) return markRecordingFailed(recording, "ATTACHMENT_WRITE_FAILED", "现场录制分块偏移无效。", "chunk_failure");
  if (data.byteLength > MAX_RECORDING_CHUNK_BYTES || message.offset + data.byteLength > (recording.maxBytes ?? MAX_RECORDING_BYTES)) {
    return markRecordingFailed(recording, "OUTPUT_BUDGET_EXCEEDED", "现场录制达到本次容量上限，已保留此前分块并停止新增数据。", "chunk_failure");
  }
  if (!recording.attachmentId) return markRecordingFailed(recording, "ATTACHMENT_UNAVAILABLE", "现场录制附件未建立。", "chunk_failure");
  try {
    await runCore("attachment.appendChunk", {
      requestId: `recording:${message.recordingId}:chunk:${message.chunkIndex}`,
      attachmentId: recording.attachmentId,
      offset: message.offset,
      dataBase64: message.dataBase64,
    });
    recording.offset = Math.max(recording.offset, message.offset + data.byteLength);
    recording.totalBytes = Math.max(recording.totalBytes, message.offset + data.byteLength);
    recording.chunkCount = Math.max(recording.chunkCount, message.chunkIndex + 1);
    recording.mimeType = message.mimeType;
    await persistRecordingState(recording, "started");
  } catch (error) {
    const serialized = errorResponse(error);
    return markRecordingFailed(recording, serialized.code === "STORAGE_BUDGET_EXCEEDED" ? "OUTPUT_BUDGET_EXCEEDED" : "ATTACHMENT_WRITE_FAILED", serialized.message, "chunk_failure");
  }
}

async function handleRecorderStatus(message: {
  recordingId: string;
  phase: "started" | "stopped" | "error";
  mimeType?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  audioMonitor?: boolean;
  startedAt?: string;
  stoppedAt?: string;
  elapsedSeconds?: number;
  stopReason?: RecordingCoverage["stopReason"];
  error?: { code: string; message: string };
}): Promise<void> {
  const recording = recordings.get(message.recordingId) ?? await recoverRecording(message.recordingId);
  if (!recording) throw failure("RECORDER_STATE_LOST", "后台没有可恢复的现场录制状态。");
  recording.mimeType = message.mimeType ?? recording.mimeType;
  recording.hasAudio = message.hasAudio ?? recording.hasAudio;
  recording.hasVideo = message.hasVideo ?? recording.hasVideo;
  recording.audioMonitor = message.audioMonitor ?? recording.audioMonitor;
  recording.startedAt = message.startedAt ?? recording.startedAt;
  recording.stoppedAt = message.stoppedAt ?? recording.stoppedAt;
  recording.elapsedSeconds = message.elapsedSeconds ?? recording.elapsedSeconds;
  recording.stopReason = message.stopReason ?? recording.stopReason;

  if (message.phase === "error") {
    recording.failed = makeRecordingFailure(
      message.error ?? { code: "RECORDER_FAILED", message: "现场录制失败。" },
      message.error?.code === "RECORDER_CHUNK_FAILED" ? "chunk" : recording.started ? "stream" : "start",
      recording.started === true,
    );
    recording.stopReason ??= message.error?.code === "RECORDER_CHUNK_FAILED" ? "chunk_failure" : "recorder_error";
    await persistRecordingState(recording, "failed");
    if (!recording.stoppedRequested) {
      recording.stoppedRequested = true;
      void chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "recorder_stop", recordingId: recording.recordingId, reason: recording.stopReason }).catch(() => undefined);
    }
    return;
  }
  if (message.phase === "started") {
    recording.started = true;
    if (recording.audioMonitor !== true || recording.hasAudio !== true || recording.hasVideo !== true) {
      return markRecordingFailed(recording, "PARTIAL_COVERAGE", "现场录制未确认真实音轨、画面轨道和原音频回放链路。", "recorder_error");
    }
    await persistRecordingState(recording, "started");
    return;
  }

  const open = await readOpenMedia();
  const state = Object.values(open).find(item => item.recordingId === recording.recordingId);
  if (state) {
    recording.requestedPreRollSeconds = state.paddingBeforeSeconds;
    recording.requestedPostRollSeconds = state.paddingAfterSeconds;
    const stoppedAtMs = Date.parse(recording.stoppedAt ?? new Date().toISOString());
    const tailStartedAtMs = state.tailStartedAt ? Date.parse(state.tailStartedAt) : Number.NaN;
    const measuredPostRoll = Number.isFinite(tailStartedAtMs) ? Math.max(0, (stoppedAtMs - tailStartedAtMs) / 1_000) : 0;
    const observedPostRoll = state.userEndMediaSeconds === null || state.userEndMediaSeconds === undefined
      ? 0
      : Math.max(0, (state.lastObservedMediaSeconds ?? state.userEndMediaSeconds) - state.userEndMediaSeconds);
    recording.actualPostRollRecordingSeconds = state.actualPostRollRecordingSeconds ?? measuredPostRoll;
    recording.observedPostRollMediaSeconds = state.observedPostRollMediaSeconds ?? observedPostRoll;
    recording.postRollComplete = state.postRollComplete
      ?? recording.observedPostRollMediaSeconds + 0.15 >= state.paddingAfterSeconds;
  }
  recording.stopped = true;
  const interrupted = Boolean(recording.failed) || recording.stopReason !== "requested" || recording.postRollComplete !== true;
  await completeRecordingAttachment(recording, interrupted);
  await persistRecordingState(recording, interrupted ? "failed" : "stopped");
}

function normalizeMediaEvents(value: unknown): MediaEvent[] {
  if (!Array.isArray(value)) return [];
  const typeMap: Record<string, MediaEvent["type"]> = {
    capture_started: "start",
    start: "start",
    end_click: "end",
    ended: "end",
    end: "end",
    play: "resume",
    resume: "resume",
    pause: "pause",
    seeking: "seek",
    seek: "seek",
    ratechange: "rate_change",
    rate_change: "rate_change",
    interrupted: "interrupted",
    source_changed: "observation",
    loadedmetadata: "observation",
    observation: "observation",
  };
  return value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const event = item as Record<string, unknown>;
    const mediaSeconds = typeof event.mediaSeconds === "number" && Number.isFinite(event.mediaSeconds) && event.mediaSeconds >= 0 ? event.mediaSeconds : null;
    const wallTime = typeof event.wallTime === "string" && Number.isFinite(Date.parse(event.wallTime)) ? event.wallTime : new Date().toISOString();
    const detail = typeof event.detail === "string" ? truncateText(event.detail, 2_048) : undefined;
    return [{
      type: typeMap[String(event.type)] ?? "observation",
      mediaSeconds,
      wallTime,
      ...(typeof event.playbackRate === "number" && Number.isFinite(event.playbackRate) && event.playbackRate > 0 ? { playbackRate: event.playbackRate } : {}),
      ...(detail ? { metadata: { detail } } : {}),
    } satisfies MediaEvent];
  });
}

function normalizeMediaSegments(value: unknown, source: string): Array<{ start: number; end: number; source: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const range = item as Record<string, unknown>;
    if (typeof range.start !== "number" || typeof range.end !== "number" || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end < range.start) return [];
    return [{ start: range.start, end: range.end, source: typeof range.source === "string" ? range.source : source }];
  }).slice(-1_000);
}

function eventKey(event: MediaEvent): string {
  return `${event.type}\u0000${event.wallTime}\u0000${event.mediaSeconds ?? "null"}\u0000${event.playbackRate ?? ""}`;
}

function unseenEvents(previous: readonly MediaEvent[], candidates: readonly MediaEvent[]): MediaEvent[] {
  const seen = new Set(previous.map(eventKey));
  return candidates.filter(event => !seen.has(eventKey(event)));
}

async function updateMediaObservations(captureId: string, observations: Record<string, unknown>, eventsAreSnapshot = false): Promise<void> {
  const operation = mediaUpdateQueue.then(async () => {
    const open = await readOpenMedia();
    const state = Object.values(open).find(item => item.captureId === captureId);
    if (!state) return;
    const previousSegments = state.observedSegments ?? [];
    const candidateSegments = Array.isArray(observations.segments)
      ? normalizeMediaSegments(observations.segments, state.source)
      : previousSegments;
    const reconciledSegments = reconcileMediaSegments(
      previousSegments,
      candidateSegments,
      state.userEndedAt !== undefined,
    );
    const currentSegments = reconciledSegments.segments;
    const candidateEvents = normalizeMediaEvents(eventsAreSnapshot ? (observations.eventSnapshot ?? observations.events) : observations.events);
    const nextEvents = unseenEvents(state.observedEvents ?? [], candidateEvents);
    const nextSegments = reconciledSegments.delta;
    const lastObserved = typeof observations.lastObservedMediaSeconds === "number" && Number.isFinite(observations.lastObservedMediaSeconds) && observations.lastObservedMediaSeconds >= 0
      ? observations.lastObservedMediaSeconds
      : state.lastObservedMediaSeconds;
    const lastChanged = lastObserved !== undefined && lastObserved !== state.lastObservedMediaSeconds;
    if (nextSegments.length > 0 || nextEvents.length > 0 || lastChanged) {
      await runCore("capture.updateDraft", {
        requestId: crypto.randomUUID(),
        captureId,
        observations: {
          ...(nextSegments.length > 0 ? { segments: nextSegments } : {}),
          ...(nextEvents.length > 0 ? { events: nextEvents } : {}),
          ...(lastObserved === undefined ? {} : { lastObservedMediaSeconds: lastObserved }),
        },
      });
    }
    await mutateOpenMedia(value => {
      const key = Object.keys(value).find(item => value[item]?.captureId === captureId);
      const latest = key ? value[key] : undefined;
      if (!key || !latest) return;
      value[key] = {
        ...latest,
        observedSegments: currentSegments,
        observedEvents: [...(latest.observedEvents ?? []), ...unseenEvents(latest.observedEvents ?? [], nextEvents)].slice(-2_000),
        ...(lastObserved === undefined ? {} : { lastObservedMediaSeconds: lastObserved }),
      };
    });
  });
  mediaUpdateQueue = operation.catch(() => undefined);
  return operation;
}

async function startMedia(tabId: number, context?: Record<string, unknown>): Promise<unknown> {
  const open = await readOpenMedia();
  if (open[String(tabId)]) throw failure("MEDIA_ALREADY_OPEN", "当前标签页已有正在记录的片段。");
  if (context?.recordLive === true) {
    const live = Object.values(open).find(item => item.recordLive && item.recordingStatus !== "failed" && item.recordingStatus !== "stopped");
    if (live) throw failure("RECORDER_BUSY", "已有另一个现场录制；请先结束后再开始。");
  }
  const response = await requestContent(tabId, "capture_media", { ...(context ?? {}), phase: "start" });
  if (!response.ok) throw failure(response.error?.code ?? "CONTENT_CAPTURE_FAILED", response.error?.message ?? "未取得媒体起点。", response.error?.details);
  if (!response.payload || typeof response.payload !== "object") throw failure("CONTENT_CAPTURE_FAILED", "未取得媒体起点。");
  const payload = response.payload as Record<string, unknown>;
  const source = payload.source && typeof payload.source === "object" ? payload.source as Record<string, unknown> : {};
  const target = payload.target && typeof payload.target === "object" ? payload.target as Record<string, unknown> : {};
  const started = payload.completion && typeof payload.completion === "object" ? payload.completion as Record<string, unknown> : {};
  const startedAt = typeof started.startedAt === "string" ? started.startedAt : new Date().toISOString();
  const startedMediaSeconds = typeof started.originalStart === "number" && Number.isFinite(started.originalStart) && started.originalStart >= 0 ? started.originalStart : 0;
  const targetId = String(target.targetId ?? "unknown");
  const publicSourceUrl = String(target.source ?? source.url ?? "about:blank");
  const acquisitionSourceUrl = String(target.acquisitionSource ?? target.source ?? source.url ?? "about:blank");
  const documentId = typeof source.documentInstanceId === "string" ? source.documentInstanceId : undefined;
  const initialEvent: MediaEvent = {
    type: "start",
    mediaSeconds: startedMediaSeconds,
    wallTime: startedAt,
    ...(typeof started.playbackRate === "number" && started.playbackRate > 0 ? { playbackRate: started.playbackRate } : {}),
  };
  const normalized = normalizedSource(source, "about:blank", typeof context?.frameId === "number" ? context.frameId : 0);
  const normalizedMetadata = normalized.metadata && typeof normalized.metadata === "object" && !Array.isArray(normalized.metadata)
    ? normalized.metadata as Record<string, unknown>
    : {};
  const created = await runCore<CaptureCreateResult>("capture.create", {
    requestId: crypto.randomUUID(),
    input: {
      kind: targetId.startsWith("audio") ? "audio_range" : "media_range",
      state: "open",
      source: {
        ...normalized,
        mediaAcquisitionUrl: acquisitionSourceUrl,
        metadata: { ...normalizedMetadata, mediaUrl: redactUrl(acquisitionSourceUrl), targetId, mediaType: targetId.startsWith("audio") ? "audio" : "video", startedAt, sourceConfidence: "best_effort" },
        ...(typeof target.duration === "number" && Number.isFinite(target.duration) ? { mediaDurationSeconds: target.duration } : {}),
      },
      selection: {
        type: "media",
        target: "media_object",
        timeBasis: "source_media",
        startClick: { mediaSeconds: startedMediaSeconds, wallTime: startedAt },
        segments: [{ start: startedMediaSeconds, end: startedMediaSeconds }],
        events: [initialEvent],
        lastObservedMediaSeconds: startedMediaSeconds,
        continuity: "continuous",
      },
      captureMethod: "media-timeline",
      assetsState: "location_only",
      integrity: { status: "needs_completion", missing: ["end_click"] },
    },
  });
  const capture = created.value.capture;
  const state: OpenMedia = {
    captureId: capture.captureId,
    requestId: crypto.randomUUID(),
    tabId,
    frameId: typeof context?.frameId === "number" ? context.frameId : 0,
    targetId,
    source: publicSourceUrl,
    ...(documentId ? { documentInstanceId: documentId } : {}),
    startedAt,
    startedMediaSeconds,
    paddingBeforeSeconds: capture.padding.beforeSeconds,
    paddingAfterSeconds: capture.padding.afterSeconds,
    recordLive: context?.recordLive === true,
    lastObservedMediaSeconds: startedMediaSeconds,
    observedSegments: [{ start: startedMediaSeconds, end: startedMediaSeconds, source: publicSourceUrl }],
    observedEvents: [initialEvent],
  };
  await mutateOpenMedia(value => { value[String(tabId)] = state; });
  const bound = await chrome.tabs.sendMessage(tabId, { channel: EXTENSION_CHANNEL, type: "media_bind", captureId: state.captureId, ...(documentId ? { documentInstanceId: documentId } : {}) }, { frameId: state.frameId }).catch(() => undefined) as { ok?: boolean } | undefined;
  if (!bound?.ok) {
    await finalizeCapture(state, { endedAt: new Date().toISOString(), originalEnd: null, segments: [], events: [] }, true, "unavailable");
    await mutateOpenMedia(value => { delete value[String(tabId)]; });
    throw failure("CONTENT_CAPTURE_FAILED", "页面记录上下文在绑定前已变化，已将草稿标为中断。");
  }
  if (state.recordLive) await startRecording(state);
  const recording = state.recordingId ? recordings.get(state.recordingId) : undefined;
  return {
    captureId: state.captureId,
    status: "open",
    startedAt,
    originalStart: startedMediaSeconds,
    recordLive: state.recordLive,
    recording: state.recordingStatus === "started" ? "started" : "unavailable",
    ...(recording?.failed ? { recordingFailure: recording.failed } : {}),
  };
}

interface TailResult {
  readonly actualPostRollRecordingSeconds: number;
  readonly observedPostRollMediaSeconds: number;
  readonly postRollComplete: boolean;
  readonly recordingStopReason?: RecordingCoverage["stopReason"];
}

async function waitForTailPadding(state: OpenMedia): Promise<TailResult> {
  const requested = Math.max(0, state.paddingAfterSeconds);
  if (!state.recordLive || !state.recordingId || requested === 0 || state.userEndMediaSeconds === null || state.userEndMediaSeconds === undefined) {
    return { actualPostRollRecordingSeconds: 0, observedPostRollMediaSeconds: 0, postRollComplete: requested === 0 };
  }
  const tailStartedMs = state.tailStartedAt ? Date.parse(state.tailStartedAt) : Date.now();
  const maxRecordingMs = Math.max(0, (state.recordingMaxSeconds ?? 600) * 1_000 - Math.max(0, Date.now() - Date.parse(state.recordingStartedAt ?? state.startedAt)));
  const requestedMs = requested * 1_000;
  const deadline = Date.now() + maxRecordingMs;
  let observed = Math.max(0, (state.lastObservedMediaSeconds ?? state.userEndMediaSeconds) - state.userEndMediaSeconds);
  let pausedSince: number | undefined;
  let lastProgressAt = Date.now();
  let stopReason: RecordingCoverage["stopReason"] | undefined;
  while (Date.now() < deadline) {
    const response = await requestContent(state.tabId, "capture_media", {
      phase: "status",
      frameId: state.frameId,
      captureId: state.captureId,
      ...(state.documentInstanceId ? { documentInstanceId: state.documentInstanceId } : {}),
    }).catch(() => undefined);
    if (!response?.ok || !response.payload || typeof response.payload !== "object") { stopReason = "unavailable"; break; }
    const status = response.payload as Record<string, unknown>;
    if (status.active !== true || status.sameDocument === false || status.sameCapture === false) { stopReason = "unavailable"; break; }
    if (status.sourceMatches === false) { stopReason = "source_changed"; break; }
    const current = typeof status.currentMediaSeconds === "number" && Number.isFinite(status.currentMediaSeconds) ? status.currentMediaSeconds : state.userEndMediaSeconds;
    const nextObserved = Math.max(observed, current - state.userEndMediaSeconds);
    if (nextObserved > observed + 0.01) lastProgressAt = Date.now();
    observed = nextObserved;
    const elapsed = Math.max(0, (Date.now() - tailStartedMs) / 1_000);
    if (observed + 0.15 >= requested) return { actualPostRollRecordingSeconds: elapsed, observedPostRollMediaSeconds: observed, postRollComplete: true };
    if (status.ended === true) { stopReason = "track_ended"; break; }
    if (status.paused === true) {
      pausedSince ??= Date.now();
      if (Date.now() - pausedSince > Math.min(3_000, Math.max(1_000, requestedMs))) { stopReason = "unavailable"; break; }
    } else {
      pausedSince = undefined;
    }
    if (Date.now() - lastProgressAt > 5_000) { stopReason = "unavailable"; break; }
    const persisted = await readOpenMedia();
    const latest = persisted[String(state.tabId)];
    if (!latest || latest.recordingStatus === "failed" || latest.recordingStatus === "stopped") {
      stopReason = latest?.recordingStopReason ?? "unavailable";
      break;
    }
    await new Promise<void>(resolve => globalThis.setTimeout(resolve, 250));
  }
  return {
    actualPostRollRecordingSeconds: Math.max(0, (Date.now() - tailStartedMs) / 1_000),
    observedPostRollMediaSeconds: observed,
    postRollComplete: false,
    ...(stopReason ? { recordingStopReason: stopReason } : {}),
  };
}

async function stopRecordingForCapture(state: OpenMedia, reason: RecordingCoverage["stopReason"]): Promise<RecordingState | undefined> {
  if (!state.recordingId) return undefined;
  const recording = recordings.get(state.recordingId) ?? await recoverRecording(state.recordingId);
  if (!recording) return undefined;
  recording.actualPostRollRecordingSeconds = state.actualPostRollRecordingSeconds;
  recording.observedPostRollMediaSeconds = state.observedPostRollMediaSeconds;
  recording.postRollComplete = state.postRollComplete;
  recording.stopReason = state.recordingStopReason ?? reason;
  if (!recording.stopped && !recording.stoppedRequested) {
    recording.stoppedRequested = true;
    const response = await chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "recorder_stop", recordingId: state.recordingId, reason: recording.stopReason }).catch(() => undefined) as { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
    if (!response?.ok) {
      recording.failed ??= {
        code: response?.error?.code ?? "RECORDER_STATE_LOST",
        message: truncateText(response?.error?.message ?? "录制上下文未确认停止。", 4_096),
        stage: "stop",
        started: recording.started === true,
      };
      recording.stopReason ??= "service_worker_restart";
    }
  }
  await waitRecordingStopped(state.recordingId);
  if (!recording.stopped) {
    recording.failed ??= { code: "RECORDER_STOP_TIMEOUT", message: "现场录制未在时限内确认停止；保留已落库分块。", stage: "stop", started: recording.started === true };
    recording.stoppedAt ??= new Date().toISOString();
    recording.elapsedSeconds ??= recording.startedAt ? Math.max(0, (Date.now() - Date.parse(recording.startedAt)) / 1_000) : 0;
    recording.stopReason ??= "service_worker_restart";
    await completeRecordingAttachment(recording, true).catch(() => undefined);
    recording.stopped = true;
    await persistRecordingState(recording, "failed");
  }
  return recording;
}

async function finalizeCapture(state: OpenMedia, completion: Record<string, unknown>, interrupted: boolean, stopReason: RecordingCoverage["stopReason"] = interrupted ? "page_closed" : "requested"): Promise<unknown> {
  await mediaUpdateQueue.catch(() => undefined);
  const latestOpen = await readOpenMedia();
  const latest = latestOpen[String(state.tabId)] ?? state;
  const completionSegments = normalizeMediaSegments(completion.segments, latest.source);
  const completionEvents = normalizeMediaEvents(completion.events);
  const previousSegments = latest.observedSegments ?? [];
  const remainingSegments = reconcileMediaSegments(
    previousSegments,
    completionSegments.length > 0 ? completionSegments : previousSegments,
    latest.userEndedAt !== undefined,
  ).delta;
  const remainingEvents = unseenEvents(latest.observedEvents ?? [], completionEvents);
  const lastObserved = typeof completion.lastObservedMediaSeconds === "number" && Number.isFinite(completion.lastObservedMediaSeconds)
    ? completion.lastObservedMediaSeconds
    : latest.lastObservedMediaSeconds;
  const recording = await stopRecordingForCapture(latest, stopReason);
  const attachmentId = recording?.attachmentId ?? latest.attachmentId;
  const recordingFailed = Boolean(recording?.failed) || latest.recordingStatus === "failed" || Boolean(latest.recordingId && !recording?.stopped);
  const assetsState = recordingFailed ? (attachmentId ? "partial_saved" : "location_only") : attachmentId ? "saved" : "location_only";
  const sealed = !interrupted && typeof completion.originalEnd === "number";
  const missing = sealed ? (recordingFailed ? ["complete_recording_coverage"] : []) : ["end_click"];
  const result = await runCore("capture.finalize", {
    requestId: crypto.randomUUID(),
    captureId: latest.captureId,
    completion: {
      state: sealed ? "sealed" : "interrupted",
      endedAt: typeof completion.endedAt === "string" ? completion.endedAt : new Date().toISOString(),
      ...(sealed ? { endClick: { mediaSeconds: completion.originalEnd, wallTime: typeof completion.endedAt === "string" ? completion.endedAt : new Date().toISOString() } } : {}),
      observations: {
        ...(remainingSegments.length > 0 ? { segments: remainingSegments } : {}),
        ...(remainingEvents.length > 0 ? { events: remainingEvents } : {}),
        ...(lastObserved === undefined ? {} : { lastObservedMediaSeconds: lastObserved }),
        ...(attachmentId ? { attachmentIds: [attachmentId] } : {}),
      },
      assetsState,
      integrity: { status: sealed && missing.length === 0 ? "complete_selection" : sealed ? "partial" : "needs_completion", missing },
    },
  });
  if (latest.recordingId) recordings.delete(latest.recordingId);
  return result;
}

async function finishMedia(tabId: number, interrupted: boolean): Promise<unknown> {
  const open = await readOpenMedia();
  const initial = open[String(tabId)];
  if (!initial) throw failure("MEDIA_NOT_OPEN", "当前标签页没有正在记录的片段。");
  let completion: Record<string, unknown> = {
    endedAt: initial.userEndedAt ?? new Date().toISOString(),
    originalEnd: initial.userEndMediaSeconds ?? null,
    segments: initial.observedSegments ?? [],
    events: initial.observedEvents ?? [],
    lastObservedMediaSeconds: initial.lastObservedMediaSeconds,
  };
  let shouldInterrupt = interrupted && !initial.userEndedAt;

  if (!interrupted) {
    const response = await requestContent(tabId, "capture_media", {
      phase: "mark_end",
      mediaType: initial.targetId.startsWith("audio") ? "audio" : "video",
      frameId: initial.frameId,
      captureId: initial.captureId,
      ...(initial.documentInstanceId ? { documentInstanceId: initial.documentInstanceId } : {}),
    });
    if (!response.ok || !response.payload || typeof response.payload !== "object") {
      throw failure(response.error?.code ?? "CONTENT_CAPTURE_FAILED", response.error?.message ?? "未取得媒体终点。", response.error?.details);
    }
    const payload = response.payload as Record<string, unknown>;
    const marked = payload.completion && typeof payload.completion === "object" ? payload.completion as Record<string, unknown> : {};
    if (typeof marked.originalEnd !== "number" || typeof marked.endedAt !== "string") throw failure("CONTENT_CAPTURE_FAILED", "页面没有返回可核验的用户结束点击。");
    await updateMediaObservations(initial.captureId, { ...marked, eventSnapshot: marked.events }, true);
    await mutateOpenMedia(value => {
      const current = value[String(tabId)];
      if (!current || current.captureId !== initial.captureId) return;
      value[String(tabId)] = { ...current, userEndedAt: marked.endedAt as string, userEndMediaSeconds: marked.originalEnd as number, tailStartedAt: current.tailStartedAt ?? new Date().toISOString() };
    });
    const tailState = (await readOpenMedia())[String(tabId)] ?? initial;
    if (tailState.recordLive && tailState.paddingAfterSeconds > 0) await publishActionNotice("info", "正在保存结束点后的预留片段…", "…", false);
    const tail = await waitForTailPadding(tailState);
    await mutateOpenMedia(value => {
      const current = value[String(tabId)];
      if (!current || current.captureId !== initial.captureId) return;
      value[String(tabId)] = { ...current, ...tail };
    });
    const stopResponse = await requestContent(tabId, "capture_media", {
      phase: "stop",
      mediaType: initial.targetId.startsWith("audio") ? "audio" : "video",
      frameId: initial.frameId,
      captureId: initial.captureId,
      ...(initial.documentInstanceId ? { documentInstanceId: initial.documentInstanceId } : {}),
    }).catch(() => undefined);
    if (stopResponse?.ok && stopResponse.payload && typeof stopResponse.payload === "object") {
      const payload = stopResponse.payload as Record<string, unknown>;
      if (payload.completion && typeof payload.completion === "object") completion = payload.completion as Record<string, unknown>;
    } else {
      completion = { ...marked, lastObservedMediaSeconds: tailState.lastObservedMediaSeconds };
    }
  }

  const latest = (await readOpenMedia())[String(tabId)] ?? initial;
  if (latest.userEndedAt) {
    shouldInterrupt = false;
    completion = { ...completion, endedAt: latest.userEndedAt, originalEnd: latest.userEndMediaSeconds };
  }
  const result = await finalizeCapture(latest, completion, shouldInterrupt);
  await mutateOpenMedia(value => { if (value[String(tabId)]?.captureId === latest.captureId) delete value[String(tabId)]; });
  return result;
}

async function publishActionNotice(
  tone: ActionNotice["tone"],
  message: string,
  badgeText: string,
  autoClear = true,
): Promise<void> {
  const notice: ActionNotice = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), tone, message: truncateText(message, 500) };
  await chrome.storage.local.set({ [ACTION_NOTICE_KEY]: notice });
  await chrome.action.setBadgeBackgroundColor({ color: tone === "error" ? "#9f2f25" : tone === "success" ? "#256b45" : "#2f5f87" }).catch(() => undefined);
  await chrome.action.setBadgeText({ text: badgeText.slice(0, 4) }).catch(() => undefined);
  if (autoClear) {
    await chrome.alarms.create(ACTION_BADGE_CLEAR_ALARM, { when: Date.now() + 7_000 });
    globalThis.setTimeout(() => { void chrome.action.setBadgeText({ text: "" }).catch(() => undefined); }, 7_000);
  }
}

function actionFailureMessage(error: unknown): string {
  const code = errorResponse(error).code;
  const messages: Readonly<Record<string, string>> = {
    SELECTION_EMPTY: "没有取得有效选区，请重新选择后再试。",
    MEDIA_TARGET_MISSING: "当前页面没有可识别的音视频。",
    MEDIA_NOT_OPEN: "当前页面没有正在记录的片段。",
    MEDIA_ALREADY_OPEN: "当前页面已有正在记录的片段。",
    RECORDER_BUSY: "已有现场录制，请先结束后再开始。",
    BROWSER_UNAVAILABLE: "页面暂时无法响应，请刷新后重试。",
    PAGE_ACCESS_RESTRICTED: "当前页面受浏览器保护，扩展无法读取内容；请在普通网页中重试。",
    FRAME_ACCESS_RESTRICTED: "所选框架受浏览器或站点权限限制，扩展无法读取内容。",
    FRAME_UNAVAILABLE: "所选框架已刷新或关闭，请重新打开菜单后再试。",
    REGION_CANCELLED: "已取消框选。",
    OUTPUT_BUDGET_EXCEEDED: "录制已达到容量上限，已保存此前数据。",
  };
  return messages[code] ?? `操作未完成（${code}）。`;
}

async function publishCaptureActionResult(
  result: unknown,
  completeMessage: string,
): Promise<void> {
  const feedback = describeCaptureSaveResult(result, completeMessage);
  await publishActionNotice(feedback.tone, feedback.message, feedback.badge, true);
}

async function publishMediaActionResult(result: unknown): Promise<void> {
  const feedback = describeMediaToggleResult(result, false);
  await publishActionNotice(feedback.tone, feedback.message, feedback.badge, !feedback.keepBadge);
}

async function stopResidualRecording(state: OpenMedia): Promise<void> {
  if (!state.recordingId) return;
  const recording = recordings.get(state.recordingId) ?? await recoverRecording(state.recordingId);
  if (state.attachmentId && !recording) {
    throw failure("RECORDER_STATE_LOST", "无法读取残留录制附件状态，保留临时记录等待重试。");
  }
  if (recording && !recording.stopped) {
    await stopRecordingForCapture(state, "service_worker_restart");
  } else {
    // A terminal attachment can outlive an offscreen recorder after a worker
    // restart. Ask that exact recorder to stop; a negative ACK means it is gone.
    await chrome.runtime.sendMessage({
      channel: EXTENSION_CHANNEL,
      type: "recorder_stop",
      recordingId: state.recordingId,
      reason: "service_worker_restart",
    }).catch(() => undefined);
  }
  if (state.attachmentId) {
    const metadata = await runCore<{ attachment?: { status?: unknown } }>("attachment.get", {
      attachmentId: state.attachmentId,
      encoding: "metadata",
      maxBytes: 1,
    });
    if (metadata.attachment?.status === "writing") {
      throw failure("ATTACHMENT_NOT_COMPLETE", "残留录制附件仍在写入状态，保留临时记录等待下次封存。");
    }
  }
}

async function clearResolvedPendingSealNotice(): Promise<void> {
  if (Object.keys(await readOpenMedia()).length > 0) return;
  const stored = await chrome.storage.local.get(ACTION_NOTICE_KEY);
  if (!isPendingMediaSealNotice(stored[ACTION_NOTICE_KEY])) return;
  await chrome.storage.local.remove(ACTION_NOTICE_KEY);
  await chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
}

async function reconcileOpenMedia(): Promise<void> {
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = (async () => {
    const open = await readOpenMedia();
    try {
      const runtime = await queryRecorder();
      const knownRecordingIds = new Set(Object.values(open).flatMap(state => state.recordingId ? [state.recordingId] : []));
      if (runtime.active && runtime.recordingId && !knownRecordingIds.has(runtime.recordingId)) {
        await chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "recorder_stop", recordingId: runtime.recordingId, reason: "recorder_error" }).catch(() => undefined);
        await publishActionNotice("error", "发现无法关联到素材记录的录制，已停止并保留已有本地事实。", "!", true);
      }
    } catch { /* Recording is optional; core capture recovery continues. */ }
    for (const state of Object.values(open)) {
      let persisted: CaptureDetailResult | undefined;
      try {
        persisted = await runCore<CaptureDetailResult>("capture.get", { captureId: state.captureId });
      } catch { /* The normal recovery path below retains state on a transient core failure. */ }
      if (persisted && persisted.capture.state !== "open") {
        try {
          await discardTerminalMediaState(
            persisted.capture.state,
            () => stopResidualRecording(state),
            () => mutateOpenMedia(value => {
              if (value[String(state.tabId)]?.captureId === state.captureId) delete value[String(state.tabId)];
            }),
          );
        } catch {
          await publishActionNotice("error", PENDING_MEDIA_SEAL_NOTICE, "!", true);
        }
        continue;
      }
      let contentStatus: Record<string, unknown> | undefined;
      try {
        const response = await requestContent(state.tabId, "capture_media", {
          phase: "status",
          frameId: state.frameId,
          captureId: state.captureId,
          ...(state.documentInstanceId ? { documentInstanceId: state.documentInstanceId } : {}),
        });
        if (response.ok && response.payload && typeof response.payload === "object") contentStatus = response.payload as Record<string, unknown>;
      } catch { /* A closed or replaced page is reconciled from persisted facts below. */ }

      const reportedCaptureId = typeof contentStatus?.captureId === "string" ? contentStatus.captureId : undefined;
      const contentContinues = contentStatus?.active === true
        && contentStatus.sameDocument !== false
        && (!reportedCaptureId || reportedCaptureId === state.captureId);
      if (contentContinues) {
        await chrome.tabs.sendMessage(state.tabId, {
          channel: EXTENSION_CHANNEL,
          type: "media_bind",
          captureId: state.captureId,
          ...(state.documentInstanceId ? { documentInstanceId: state.documentInstanceId } : {}),
        }, { frameId: state.frameId }).catch(() => undefined);
        const observations = contentStatus?.observations;
        if (observations && typeof observations === "object") {
          const snapshot = observations as Record<string, unknown>;
          await updateMediaObservations(state.captureId, { ...snapshot, eventSnapshot: snapshot.events }, true).catch(() => undefined);
        }

        if (state.recordLive && state.recordingId && state.recordingStatus !== "stopped" && state.recordingStatus !== "failed") {
          let runtime: RecorderRuntimeStatus | undefined;
          try { runtime = await queryRecorder(state.recordingId); } catch { runtime = undefined; }
          if (runtime?.active && runtime.recordingId === state.recordingId) {
            const recording = await recoverRecording(state.recordingId);
            if (recording) {
              recording.started = runtime.started === true;
              recording.startedAt = runtime.started === true ? runtime.startedAt ?? recording.startedAt : undefined;
              recording.elapsedSeconds = runtime.started === true ? runtime.elapsedSeconds ?? recording.elapsedSeconds : undefined;
              recording.hasAudio = runtime.hasAudio ?? recording.hasAudio;
              recording.hasVideo = runtime.hasVideo ?? recording.hasVideo;
              recording.audioMonitor = runtime.audioMonitor ?? recording.audioMonitor;
              recording.stopReason = runtime.stopReason ?? recording.stopReason;
              await persistRecordingState(recording, runtime.started === true ? "started" : "starting");
            }
          } else {
            const recording = await recoverRecording(state.recordingId);
            if (recording && !recording.attachmentCompleted) {
              recording.failed = {
                code: "RECORDER_STATE_LOST",
                message: "浏览器恢复后未找到原录制上下文；已保留落库分块。",
                stage: recording.started ? "stream" : "start",
                started: recording.started === true,
              };
              recording.stopped = true;
              recording.stoppedAt = new Date().toISOString();
              recording.elapsedSeconds = recording.startedAt ? Math.max(0, (Date.now() - Date.parse(recording.startedAt)) / 1_000) : 0;
              recording.stopReason = "service_worker_restart";
              await completeRecordingAttachment(recording, true).catch(() => undefined);
              await persistRecordingState(recording, "failed");
            }
          }
        }
        if (state.userEndedAt) await finishMedia(state.tabId, false).catch(() => undefined);
        continue;
      }

      if (state.recordingId) {
        try {
          const runtime = await queryRecorder(state.recordingId);
          if (runtime.active && runtime.recordingId === state.recordingId) {
            await chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, type: "recorder_stop", recordingId: state.recordingId, reason: "service_worker_restart" }).catch(() => undefined);
            await waitRecordingStopped(state.recordingId);
          }
        } catch { /* Finalization below preserves the last persisted chunks. */ }
      }
      const completion: Record<string, unknown> = {
        endedAt: state.userEndedAt ?? new Date().toISOString(),
        originalEnd: state.userEndedAt ? state.userEndMediaSeconds : null,
        segments: state.observedSegments ?? [],
        events: state.observedEvents ?? [],
        lastObservedMediaSeconds: state.lastObservedMediaSeconds,
      };
      try {
        await finalizeCapture(state, completion, !state.userEndedAt, "service_worker_restart");
        await mutateOpenMedia(value => { if (value[String(state.tabId)]?.captureId === state.captureId) delete value[String(state.tabId)]; });
      } catch {
        await publishActionNotice("error", PENDING_MEDIA_SEAL_NOTICE, "!", true);
      }
    }
    await clearResolvedPendingSealNotice();
  })().finally(() => { reconcilePromise = undefined; });
  return reconcilePromise;
}


async function handleContentReply(message: ContentReplyMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  if (!isContentSender(sender)) return;
  const pending = contentRequests.get(message.requestId);
  if (!pending) return;
  if (sender.tab?.id !== pending.tabId) return;
  if ((sender.frameId ?? 0) !== pending.frameId) return;
  contentRequests.delete(message.requestId); globalThis.clearTimeout(pending.timer); pending.resolve(message);
}

async function handleMediaUpdate(message: { captureId: string; observations: unknown }, sender: chrome.runtime.MessageSender): Promise<void> {
  const open = await readOpenMedia();
  const state = Object.values(open).find(item => item.captureId === message.captureId);
  if (!state || sender.tab?.id !== state.tabId || (sender.frameId ?? 0) !== state.frameId) return;
  const observations = message.observations && typeof message.observations === "object" ? message.observations as Record<string, unknown> : {};
  await updateMediaObservations(message.captureId, observations, Array.isArray(observations.eventSnapshot));
}

async function toggleMedia(tabId: number, context?: Record<string, unknown>): Promise<unknown> {
  await initializeBackground();
  return withMediaActionLock(async () => {
    await reconcileOpenMedia();
    const open = await readOpenMedia();
    return open[String(tabId)] ? finishMedia(tabId, false) : startMedia(tabId, context);
  });
}

async function onMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (!message || typeof message !== "object") return undefined;
  if (isSourceStreamMessage(message)) return handleSourceStreamMessage(message, sender);
  if ((message as { type?: unknown }).type === "content_reply") return handleContentReply(message as ContentReplyMessage, sender);
  if ((message as { type?: unknown }).type === "media_update" && isContentSender(sender)) return handleMediaUpdate(message as { captureId: string; observations: unknown }, sender);
  if ((message as { type?: unknown }).type === "media_interrupted" && isContentSender(sender)) {
    const value = message as { captureId?: unknown; completion?: unknown };
    if (typeof value.captureId === "string" && sender.tab?.id !== undefined) {
      const tabId = sender.tab.id;
      await withMediaActionLock(async () => {
        const open = await readOpenMedia();
        const state = open[String(tabId)];
        if (!state || state.captureId !== value.captureId || (sender.frameId ?? 0) !== state.frameId) return;
        const completion = value.completion && typeof value.completion === "object"
          ? value.completion as Record<string, unknown>
          : { endedAt: new Date().toISOString(), originalEnd: null, events: [], segments: [] };
        if (state.userEndedAt) {
          completion.endedAt = state.userEndedAt;
          completion.originalEnd = state.userEndMediaSeconds;
        }
        await finalizeCapture(state, completion, !state.userEndedAt, "page_closed");
        await mutateOpenMedia(current => { if (current[String(tabId)]?.captureId === state.captureId) delete current[String(tabId)]; });
      });
    }
    return { ok: true };
  }
  if (isRecorderMessage(message) && sender.id === chrome.runtime.id) {
    if (message.type === "recorder_chunk") await handleRecorderChunk(message);
    else await handleRecorderStatus(message);
    return { ok: true };
  }
  if (isCoreUiMessage(message)) {
    if (!isExtensionPageSender(sender)) return { ok: false, error: { code: "FORBIDDEN", message: "网页内容不能直接调用内部业务方法。" } };
    try {
      if (message.method === "connection.status") return { ok: true, result: await connectionStatus() };
      return { ok: true, result: await runCore(message.method, message.params) };
    } catch (error) {
      return { ok: false, error: errorResponse(error) };
    }
  }
  if (message && typeof message === "object" && (message as { type?: unknown }).type === "open_library" && isExtensionPageSender(sender)) { await openLibrary(); return { ok: true }; }
  if (message && typeof message === "object" && (message as { type?: unknown }).type === "action" && isExtensionPageSender(sender)) {
    const value = message as { action?: unknown; recordLive?: unknown; frameId?: unknown; tabId?: unknown };
    const frameId = typeof value.frameId === "number" && Number.isInteger(value.frameId) && value.frameId >= 0 ? value.frameId : 0;
    if (value.action === "connect-native") {
      try { return { ok: true, result: await connectNativeBridge() }; }
      catch (error) { await publishActionNotice("error", "本地桥连接失败；本地记录仍可使用。", "!", true); return { ok: false, error: errorResponse(error) }; }
    }
    if (value.action === "capture-selection" || value.action === "capture-region" || value.action === "toggle-media-capture") {
      try {
        const requestedTabId = typeof value.tabId === "number" && Number.isInteger(value.tabId) && value.tabId > 0 ? value.tabId : undefined;
        const tab = requestedTabId === undefined ? await currentTab() : await chrome.tabs.get(requestedTabId);
        if (!tab.id) throw new Error("BROWSER_UNAVAILABLE: 没有当前标签页。");
        if (value.action === "capture-selection") {
          const result = await captureSelection(tab.id, { frameId });
          await publishCaptureActionResult(result, "选中内容已保存。");
          return { ok: true, result };
        }
        if (value.action === "capture-region") {
          const result = await captureRegion(tab.id, { frameId });
          await publishActionNotice("success", "框选截图已保存。", "✓", true);
          return { ok: true, result };
        }
        const result = await toggleMedia(tab.id, { recordLive: value.recordLive === true, frameId });
        await publishMediaActionResult(result);
        return { ok: true, result };
      } catch (error) {
        await publishActionNotice("error", actionFailureMessage(error), "!", true);
        return { ok: false, error: errorResponse(error) };
      }
    }
  }
  return undefined;
}

async function dispatchNative(method: NativeMethod, params: unknown): Promise<unknown> {
  if (method === "bridge.hello") return { accepted: true, profileId: await profileId() };
  if (method === "capture.acquireMedia") return acquireSourceMedia(params);
  if (method === "connection.status") return connectionStatus();
  return runCore(method, params);
}

async function connectionStatus(): Promise<ConnectionStatusResult & { native: ReturnType<NativeBridge["status"]>; nativeEnabled: boolean }> {
  if (!nativeProfileId) nativeProfileId = await profileId();
  const core = await runCore<ConnectionStatusResult>("connection.status", {});
  const stored = await chrome.storage.local.get(NATIVE_ENABLED_KEY);
  return { ...core, native: native.status(), nativeEnabled: stored[NATIVE_ENABLED_KEY] === true };
}

let nativeProfileId = "";
const native = new NativeBridge(() => nativeProfileId || "profile-loading", dispatchNative);

reminders = createReminderController({
  storage: chrome.storage.local,
  alarms: chrome.alarms,
  getSettings: () => runCore("settings.get", {}) as Promise<{ reminderMinutes: number | null }>,
  listPending: () => runCore("capture.list", { view: "pending", limit: 1 }) as Promise<{ records: readonly unknown[] }>,
  notify: notice => native.notify("inbox.reminder", notice),
});

async function reconnectNativeIfEnabled(): Promise<void> {
  const stored = await chrome.storage.local.get(NATIVE_ENABLED_KEY);
  if (stored[NATIVE_ENABLED_KEY] !== true) return;
  try {
    await native.connect();
  } catch {
    await publishActionNotice("error", "本地桥自动重连失败；本地记录仍可使用。", "!", true);
  }
}

async function initializeBackground(): Promise<void> {
  if (initializePromise) return initializePromise;
  const attempt = (async () => {
    await initializeI18n();
    nativeProfileId = await profileId();
    await reminders.initialize().catch(() => undefined);
    await reconnectNativeIfEnabled();
    await withMediaActionLock(() => reconcileOpenMedia());
  })();
  initializePromise = attempt;
  try {
    await attempt;
  } catch (error) {
    if (initializePromise === attempt) initializePromise = undefined;
    throw error;
  }
}

function initializeBackgroundSafely(): void {
  void initializeBackground().catch(() => publishActionNotice("error", "扩展初始化未完成，将在下次操作时重试。", "!", true).catch(() => undefined));
}

async function openLibrary(): Promise<void> { await chrome.tabs.create({ url: chrome.runtime.getURL("library.html") }); }

async function currentTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error("BROWSER_UNAVAILABLE: 没有当前可用标签页。");
  return tab;
}

async function runCommand(command: string, tabId?: number): Promise<unknown> {
  const tab = tabId ? await chrome.tabs.get(tabId) : await currentTab();
  if (!tab.id) throw new Error("BROWSER_UNAVAILABLE: 没有可用标签页。");
  if (command === "capture-selection") return captureSelection(tab.id);
  if (command === "toggle-media-capture") return toggleMedia(tab.id, { recordLive: false });
  if (command === "capture-region") return captureRegion(tab.id);
  if (command === "open-library") return openLibrary();
  throw new Error("UNSUPPORTED_COMMAND: 未知扩展命令。");
}

async function setupMenus(): Promise<void> {
  await initializeI18n();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: "capture-selection", title: t("收集选中文字"), contexts: ["selection"] });
  chrome.contextMenus.create({ id: "capture-image", title: t("收集图片"), contexts: ["image"] });
  chrome.contextMenus.create({ id: "toggle-media-capture", title: t("开始/结束记录片段"), contexts: ["video", "audio"] });
  chrome.contextMenus.create({ id: "capture-region", title: t("框选截图"), contexts: ["page"] });
  chrome.contextMenus.create({ id: "open-library", title: t("打开 Babel 素材库"), contexts: ["page", "selection", "image", "video", "audio"] });
  await chrome.action.setTitle({ title: t("打开 Babel 素材夹") });
}

// Language is presentation-only: changing it never claims a job or rewrites a
// stored capture/notice. Serialize menu replacement across rapid switches.
let menuUpdates: Promise<void> = Promise.resolve();
function refreshMenus(): Promise<void> {
  menuUpdates = menuUpdates.then(setupMenus).catch(() => undefined);
  return menuUpdates;
}
onLocaleChange(() => { void refreshMenus(); });

chrome.runtime.onInstalled.addListener(() => {
  void refreshMenus();
  initializeBackgroundSafely();
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
});
chrome.runtime.onStartup.addListener(initializeBackgroundSafely);
chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm.name === ACTION_BADGE_CLEAR_ALARM) {
    void chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
    return;
  }
  void reminders.onAlarm(alarm.name).catch(() => undefined);
});
void refreshMenus();
initializeBackgroundSafely();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  void (async () => {
    try {
      let captureResult: unknown;
      let captureMessage = "内容已保存到当前浏览器。";
      if (info.menuItemId === "capture-selection") {
        captureResult = await captureSelection(tabId, { menuItemId: "capture-selection", frameId: info.frameId ?? 0 });
        captureMessage = "选中内容已保存。";
      }
      else if (info.menuItemId === "capture-image") {
        captureResult = await captureImage(tabId, { menuItemId: "capture-image", srcUrl: info.srcUrl, frameUrl: info.frameUrl, mediaType: "image", frameId: info.frameId ?? 0 });
        captureMessage = "图片已保存。";
      }
      else if (info.menuItemId === "toggle-media-capture") {
        const result = await toggleMedia(tabId, { menuItemId: "toggle-media-capture", mediaType: info.mediaType === "audio" ? "audio" : "video", recordLive: false, frameId: info.frameId ?? 0 });
        await publishMediaActionResult(result);
        return;
      }
      else if (info.menuItemId === "capture-region") {
        captureResult = await captureRegion(tabId, { menuItemId: "capture-region", frameId: info.frameId ?? 0 });
        captureMessage = "框选截图已保存。";
      }
      else if (info.menuItemId === "open-library") { await openLibrary(); return; }
      if (captureResult !== undefined) await publishCaptureActionResult(captureResult, captureMessage);
    } catch (error) { await publishActionNotice("error", actionFailureMessage(error), "!", true); }
  })();
});

chrome.commands.onCommand.addListener(command => {
  void runCommand(command).then(result => command === "toggle-media-capture"
    ? publishMediaActionResult(result)
    : command === "capture-selection"
      ? publishCaptureActionResult(result, "选中内容已保存。")
      : command === "capture-region"
        ? publishCaptureActionResult(result, "框选截图已保存。")
        : publishActionNotice("success", "快捷操作已完成。", "✓", true))
    .catch(error => publishActionNotice("error", actionFailureMessage(error), "!", true));
});

chrome.tabs.onRemoved.addListener(tabId => {
  void withMediaActionLock(async () => {
    const open = await readOpenMedia();
    if (open[String(tabId)]) await finishMedia(tabId, true).catch(() => undefined);
  });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  void withMediaActionLock(async () => {
    const open = await readOpenMedia();
    if (open[String(tabId)]) await finishMedia(tabId, true).catch(() => undefined);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void onMessage(message, sender).then(result => sendResponse(result)).catch(error => sendResponse({ ok: false, error: errorResponse(error) }));
  return true;
});

// Explicit connection is available from the settings view. It never starts a
// browser action or claims a job by itself.
export async function connectNativeBridge(): Promise<unknown> {
  nativeProfileId = await profileId();
  await native.connect();
  await chrome.storage.local.set({ [NATIVE_ENABLED_KEY]: true });
  await publishActionNotice("success", "本地桥已连接；不会自动开始处理任务。", "✓", true);
  return native.status();
}
export function nativeBridgeStatus(): unknown { return native.status(); }
