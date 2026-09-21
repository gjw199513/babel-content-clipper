export const EXTENSION_CHANNEL = "babel_content_clipper.v1" as const;

export type UiMethod =
  | "capture.create"
  | "capture.list"
  | "capture.get"
  | "capture.updateDraft"
  | "capture.finalize"
  | "library.setCollection"
  | "job.claim"
  | "job.get"
  | "job.heartbeat"
  | "job.complete"
  | "job.reprocess"
  | "library.cleanupPreview"
  | "library.cleanupCommit"
  | "backup.export"
  | "backup.import"
  | "diagnostics.get"
  | "connection.status"
  | "settings.get"
  | "settings.update";

export type NativeMethod = UiMethod | "capture.getAcquisitionSource" | "capture.acquireMedia" | "attachment.get" | "attachment.create" | "attachment.appendChunk" | "attachment.complete" | "bridge.hello";

export interface CoreUiMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "core";
  method: UiMethod;
  params?: unknown;
  requestId?: string;
}

export interface UiOpenLibraryMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "open_library";
}

export interface UiActionMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "action";
  action: "capture-selection" | "toggle-media-capture" | "capture-region" | "connect-native";
  recordLive?: boolean;
  frameId?: number;
  tabId?: number;
}

export interface ContentCommandMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "content_command";
  requestId?: string;
  command: "capture_selection" | "capture_media" | "begin_region" | "acquire_media";
  context?: {
    menuItemId?: string;
    srcUrl?: string;
    mediaType?: "image" | "video" | "audio";
    recordLive?: boolean;
    phase?: "start" | "mark_end" | "status" | "stop";
    captureId?: string;
    documentInstanceId?: string;
    frameId?: number;
    /** A claim-bound, private source URL supplied only by the extension background. */
    sourceUrl?: string;
  };
}

export interface ContentReplyMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "content_reply";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface SourceStreamStartMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "source_stream_start";
  requestId: string;
  mimeType: string;
  totalBytes?: number;
}

export interface SourceStreamChunkMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "source_stream_chunk";
  requestId: string;
  offset: number;
  dataBase64: string;
}

export interface SourceStreamCompleteMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "source_stream_complete";
  requestId: string;
  totalBytes: number;
}

export interface SourceStreamErrorMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "source_stream_error";
  requestId: string;
  error: { code: string; message: string; details?: unknown };
}

export interface RecorderChunkMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "recorder_chunk";
  recordingId: string;
  chunkIndex: number;
  offset: number;
  mimeType: string;
  dataBase64: string;
}

export interface RecorderStatusMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "recorder_status";
  recordingId: string;
  phase: "started" | "stopped" | "error";
  mimeType?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  audioMonitor?: boolean;
  startedAt?: string;
  stoppedAt?: string;
  elapsedSeconds?: number;
  stopReason?: "requested" | "max_duration" | "track_ended" | "chunk_failure" | "service_worker_restart" | "page_closed" | "source_changed" | "recorder_error" | "unavailable";
  error?: { code: string; message: string };
}

export interface RecorderStatusQueryMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "recorder_status_query";
  recordingId?: string;
}

export interface RecorderStopMessage {
  channel: typeof EXTENSION_CHANNEL;
  type: "recorder_stop";
  recordingId: string;
  reason?: RecorderStatusMessage["stopReason"];
}

export type ExtensionMessage = CoreUiMessage | UiOpenLibraryMessage | UiActionMessage | ContentCommandMessage | ContentReplyMessage | SourceStreamStartMessage | SourceStreamChunkMessage | SourceStreamCompleteMessage | SourceStreamErrorMessage | RecorderChunkMessage | RecorderStatusMessage | RecorderStatusQueryMessage | RecorderStopMessage;

export function isUiMethod(value: unknown): value is UiMethod {
  return typeof value === "string" && [
    "capture.create", "capture.list", "capture.get", "capture.updateDraft", "capture.finalize", "library.setCollection",
    "job.claim", "job.get", "job.heartbeat", "job.complete", "job.reprocess", "library.cleanupPreview", "library.cleanupCommit",
    "backup.export", "backup.import", "diagnostics.get", "connection.status", "settings.get", "settings.update",
  ].includes(value);
}

export function isNativeMethod(value: unknown): value is NativeMethod {
  return isUiMethod(value) || ["capture.getAcquisitionSource", "capture.acquireMedia", "attachment.get", "attachment.create", "attachment.appendChunk", "attachment.complete", "bridge.hello"].includes(String(value));
}

export function isCoreUiMessage(value: unknown): value is CoreUiMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<CoreUiMessage>;
  return message.channel === EXTENSION_CHANNEL && message.type === "core" && isUiMethod(message.method);
}

export function isContentCommand(value: unknown): value is ContentCommandMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ContentCommandMessage>;
  return message.channel === EXTENSION_CHANNEL && message.type === "content_command"
    && ["capture_selection", "capture_media", "begin_region", "acquire_media"].includes(String(message.command));
}

export function isSourceStreamMessage(value: unknown): value is SourceStreamStartMessage | SourceStreamChunkMessage | SourceStreamCompleteMessage | SourceStreamErrorMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<SourceStreamStartMessage | SourceStreamChunkMessage | SourceStreamCompleteMessage | SourceStreamErrorMessage>;
  return message.channel === EXTENSION_CHANNEL
    && ["source_stream_start", "source_stream_chunk", "source_stream_complete", "source_stream_error"].includes(String(message.type))
    && typeof message.requestId === "string";
}

export function isRecorderMessage(value: unknown): value is RecorderChunkMessage | RecorderStatusMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<RecorderChunkMessage | RecorderStatusMessage>;
  return message.channel === EXTENSION_CHANNEL && (message.type === "recorder_chunk" || message.type === "recorder_status")
    && typeof message.recordingId === "string";
}

export function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

export function isContentSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.tab && typeof sender.tab.id === "number";
}
