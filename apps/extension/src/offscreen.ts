import { EXTENSION_CHANNEL, type RecorderStatusMessage } from "./messages.js";
import { classifyRecorderSetupError } from "./recording-errors.js";

const MAX_CHUNK_BYTES = 512 * 1024;
const DEFAULT_MAX_RECORDING_SECONDS = 600;

type StopReason = NonNullable<RecorderStatusMessage["stopReason"]>;

interface RecorderSession {
  readonly recordingId: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  audioContext?: AudioContext;
  chunkQueue: Promise<void>;
  chunkIndex: number;
  byteOffset: number;
  stopRequested: boolean;
  stopReason: StopReason;
  hasAudio: boolean;
  hasVideo: boolean;
  audioMonitor: boolean;
  started: boolean;
  errorSent: boolean;
  maxTimer?: ReturnType<typeof globalThis.setTimeout>;
}

let session: RecorderSession | undefined;

async function send(message: Record<string, unknown>): Promise<unknown> {
  const response = await chrome.runtime.sendMessage({ channel: EXTENSION_CHANNEL, ...message });
  if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) {
    const error = response && typeof response === "object" ? (response as { error?: { message?: string } }).error : undefined;
    throw new Error(error?.message ?? "Extension recorder message was not acknowledged.");
  }
  return response;
}

function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, Math.min(offset + 0x8000, data.length)));
  }
  return btoa(binary);
}

async function cleanup(current: RecorderSession): Promise<void> {
  if (current.maxTimer !== undefined) globalThis.clearTimeout(current.maxTimer);
  current.stream?.getTracks().forEach(track => track.stop());
  await current.audioContext?.close().catch(() => undefined);
  if (session === current) session = undefined;
}

async function reportError(current: RecorderSession, code: string, message: string): Promise<void> {
  if (current.errorSent) return;
  current.errorSent = true;
  await send({
    type: "recorder_status",
    recordingId: current.recordingId,
    phase: "error",
    error: { code, message },
    hasAudio: current.hasAudio,
    hasVideo: current.hasVideo,
    audioMonitor: current.audioMonitor,
    ...(current.started ? { startedAt: current.startedAt } : {}),
    ...(current.started ? { elapsedSeconds: Math.max(0, (Date.now() - current.startedAtMs) / 1_000) } : {}),
    stopReason: current.stopReason,
  }).catch(() => undefined);
}

function requestStop(recordingId: string, reason: StopReason): boolean {
  const current = session;
  if (!current || current.recordingId !== recordingId) return false;
  if (!current.stopRequested) {
    current.stopRequested = true;
    current.stopReason = reason;
  } else if (reason === "chunk_failure" || reason === "recorder_error") {
    current.stopReason = reason;
  }
  if (current.recorder && current.recorder.state !== "inactive") current.recorder.stop();
  return true;
}

async function appendBlob(current: RecorderSession, blob: Blob): Promise<void> {
  for (let offset = 0; offset < blob.size; offset += MAX_CHUNK_BYTES) {
    const part = blob.slice(offset, Math.min(offset + MAX_CHUNK_BYTES, blob.size));
    const data = new Uint8Array(await part.arrayBuffer());
    const chunkOffset = current.byteOffset;
    const chunkIndex = current.chunkIndex;
    await send({
      type: "recorder_chunk",
      recordingId: current.recordingId,
      chunkIndex,
      offset: chunkOffset,
      mimeType: current.recorder?.mimeType || blob.type || "video/webm",
      dataBase64: toBase64(data),
    });
    current.chunkIndex += 1;
    current.byteOffset += data.byteLength;
  }
}

async function start(request: { recordingId: string; streamId: string; maxDurationSeconds?: number }): Promise<void> {
  if (session) {
    throw Object.assign(new Error("RECORDER_BUSY: 已有现场录制正在运行。"), { code: "RECORDER_BUSY" });
  }
  const current: RecorderSession = {
    recordingId: request.recordingId,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    chunkQueue: Promise.resolve(),
    chunkIndex: 0,
    byteOffset: 0,
    stopRequested: false,
    stopReason: "requested",
    hasAudio: false,
    hasVideo: false,
    audioMonitor: false,
    started: false,
    errorSent: false,
  };
  session = current;
  let setupStage: "get_user_media" | "media_recorder" | "recorder_start" | "start_ack" = "get_user_media";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: request.streamId } },
      video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: request.streamId } },
    } as MediaStreamConstraints);
    if (session !== current) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    current.stream = stream;
    current.hasAudio = stream.getAudioTracks().length > 0;
    current.hasVideo = stream.getVideoTracks().length > 0;
    if (!current.hasAudio || !current.hasVideo) {
      const missing = !current.hasAudio ? "音频" : "视频";
      current.stopReason = "recorder_error";
      await reportError(current, "PARTIAL_COVERAGE", `tabCapture 未取得${missing}轨道，未将不完整流标为完整录制。`);
      await cleanup(current);
      return;
    }

    try {
      const audioContext = new AudioContext();
      const monitor = audioContext.createMediaStreamSource(stream);
      monitor.connect(audioContext.destination);
      await audioContext.resume();
      current.audioContext = audioContext;
      current.audioMonitor = audioContext.state === "running";
    } catch (error) {
      current.stopReason = "recorder_error";
      await reportError(current, "AUDIO_MONITOR_UNAVAILABLE", error instanceof Error ? error.message : "无法恢复标签页原音频播放。");
      await cleanup(current);
      return;
    }

    setupStage = "media_recorder";
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      .find(candidate => MediaRecorder.isTypeSupported(candidate)) ?? "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    current.recorder = recorder;

    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (session === current) requestStop(current.recordingId, "track_ended");
      }, { once: true });
    }
    recorder.addEventListener("dataavailable", event => {
      if (event.data.size === 0) return;
      current.chunkQueue = current.chunkQueue.then(() => appendBlob(current, event.data)).catch(async error => {
        current.stopReason = "chunk_failure";
        await reportError(current, "RECORDER_CHUNK_FAILED", error instanceof Error ? error.message : "现场录制分块未获得持久化确认。");
        requestStop(current.recordingId, "chunk_failure");
        throw error;
      });
    });
    recorder.addEventListener("error", () => {
      current.stopReason = "recorder_error";
      void reportError(current, "RECORDER_FAILED", "MediaRecorder 返回错误。");
      requestStop(current.recordingId, "recorder_error");
    });
    recorder.addEventListener("stop", () => {
      const stoppedAt = new Date().toISOString();
      const elapsedSeconds = Math.max(0, (Date.now() - current.startedAtMs) / 1_000);
      void current.chunkQueue.catch(() => undefined).then(() => send({
        type: "recorder_status",
        recordingId: current.recordingId,
        phase: "stopped",
        mimeType: recorder.mimeType || mimeType || "video/webm",
        hasAudio: current.hasAudio,
        hasVideo: current.hasVideo,
        audioMonitor: current.audioMonitor,
        startedAt: current.startedAt,
        stoppedAt,
        elapsedSeconds,
        stopReason: current.stopReason,
      })).catch(() => undefined).finally(() => cleanup(current));
    }, { once: true });

    setupStage = "recorder_start";
    recorder.start(4_000);
    current.started = true;
    setupStage = "start_ack";
    await send({
      type: "recorder_status",
      recordingId: current.recordingId,
      phase: "started",
      mimeType: recorder.mimeType || mimeType || "video/webm",
      hasAudio: current.hasAudio,
      hasVideo: current.hasVideo,
      audioMonitor: current.audioMonitor,
      startedAt: current.startedAt,
      elapsedSeconds: 0,
    });
    const maxDurationMs = Math.max(1, request.maxDurationSeconds ?? DEFAULT_MAX_RECORDING_SECONDS) * 1_000;
    current.maxTimer = globalThis.setTimeout(() => {
      if (session === current) requestStop(current.recordingId, "max_duration");
    }, maxDurationMs);
    if (current.stopRequested) requestStop(current.recordingId, current.stopReason);
  } catch (error) {
    current.stopReason = "recorder_error";
    const classified = classifyRecorderSetupError(error, setupStage);
    await reportError(current, classified.code, classified.message);
    await cleanup(current);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || (message as { channel?: unknown }).channel !== EXTENSION_CHANNEL) return false;
  const value = message as Record<string, unknown>;
  if (value.type === "recorder_status_query") {
    const requestedId = typeof value.recordingId === "string" ? value.recordingId : undefined;
    const current = session;
    sendResponse({
      ok: true,
      active: Boolean(current && (!requestedId || requestedId === current.recordingId)),
      ...(current ? {
        recordingId: current.recordingId,
        started: current.started,
        ...(current.started ? { startedAt: current.startedAt } : {}),
        ...(current.started ? { elapsedSeconds: Math.max(0, (Date.now() - current.startedAtMs) / 1_000) } : {}),
        hasAudio: current.hasAudio,
        hasVideo: current.hasVideo,
        audioMonitor: current.audioMonitor,
        stopRequested: current.stopRequested,
        stopReason: current.stopReason,
      } : {}),
    });
    return false;
  }
  if (value.type === "recorder_start") {
    if (session) {
      sendResponse({ ok: false, error: { code: "RECORDER_BUSY", message: "已有现场录制正在运行。" } });
      return false;
    }
    if (typeof value.recordingId !== "string" || typeof value.streamId !== "string") {
      sendResponse({ ok: false, error: { code: "VALIDATION_ERROR", message: "录制启动参数无效。" } });
      return false;
    }
    sendResponse({ ok: true });
    void start({
      recordingId: value.recordingId,
      streamId: value.streamId,
      ...(typeof value.maxDurationSeconds === "number" ? { maxDurationSeconds: value.maxDurationSeconds } : {}),
    });
    return false;
  }
  if (value.type === "recorder_stop") {
    const recordingId = typeof value.recordingId === "string" ? value.recordingId : "";
    const rawReason = typeof value.reason === "string" ? value.reason : "requested";
    const reason: StopReason = ["requested", "max_duration", "track_ended", "chunk_failure", "service_worker_restart", "page_closed", "source_changed", "recorder_error", "unavailable"].includes(rawReason)
      ? rawReason as StopReason
      : "requested";
    const accepted = requestStop(recordingId, reason);
    sendResponse(accepted
      ? { ok: true }
      : { ok: false, error: { code: "RECORDER_STATE_LOST", message: "未找到匹配的现场录制，未返回停止确认。" } });
    return false;
  }
  return false;
});
