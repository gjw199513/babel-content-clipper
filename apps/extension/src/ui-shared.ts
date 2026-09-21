import type {
  AttachmentRecord,
  BackupBundle,
  BackupImportResult,
  CaptureDetailResult,
  CaptureListItem,
  CaptureListResult,
  CleanupCommitResult,
  CleanupPreviewResult,
  ClipperSettings,
  ConnectionStatusResult,
  DiagnosticsResult,
  ReprocessJobResult,
  SerializableClipperError,
  SetCollectionResult,
  SettingsUpdateResult,
} from "../../../packages/core/src/types.js";

import { EXTENSION_CHANNEL } from "./messages.js";
import { getLocale, t } from "./i18n.js";

export const VIEW_STATE_KEY = "babel_content_clipper.view_state.v1";
export const LIBRARY_REVISION_KEY = "babel_content_clipper.library_revision.v1";

export type LibraryView = "all" | "pending" | "history" | "saved";
export type LibraryDateFilter = "" | "today" | "week";

export interface LibraryViewState {
  readonly version: 1;
  readonly view: LibraryView;
  readonly search: string;
  readonly sourceKey: string;
  readonly date: LibraryDateFilter;
  readonly selectedCaptureId: string;
}

export interface UiConnectionStatus extends ConnectionStatusResult {
  readonly nativeEnabled: boolean;
  readonly native: {
    readonly connected: boolean;
    readonly host: string;
    readonly profileId: string;
    readonly error?: { readonly code: string; readonly message: string };
  };
}

interface CoreResultMap {
  readonly "capture.list": CaptureListResult;
  readonly "capture.get": CaptureDetailResult;
  readonly "library.setCollection": SetCollectionResult;
  readonly "job.reprocess": ReprocessJobResult;
  readonly "library.cleanupPreview": CleanupPreviewResult;
  readonly "library.cleanupCommit": CleanupCommitResult;
  readonly "backup.export": BackupBundle;
  readonly "backup.import": BackupImportResult;
  readonly "diagnostics.get": DiagnosticsResult;
  readonly "connection.status": UiConnectionStatus;
  readonly "settings.get": ClipperSettings;
  readonly "settings.update": SettingsUpdateResult;
}

interface RuntimeResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: SerializableClipperError;
}

export class UiCoreError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(error: SerializableClipperError | undefined) {
    super(error?.message ?? t("本地记录服务请求失败。"));
    this.name = "UiCoreError";
    this.code = error?.code ?? "INTERNAL_ERROR";
    this.details = error?.details;
  }
}

export function sendRuntime<T = unknown>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: unknown) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response as T);
    });
  });
}

export async function callCore<M extends keyof CoreResultMap>(
  method: M,
  params: unknown = {},
): Promise<CoreResultMap[M]> {
  const response = await sendRuntime<RuntimeResponse<CoreResultMap[M]>>({
    channel: EXTENSION_CHANNEL,
    type: "core",
    method,
    params,
  });
  if (!response?.ok || response.result === undefined) {
    throw new UiCoreError(response?.error);
  }
  return response.result;
}

export const DEFAULT_VIEW_STATE: LibraryViewState = {
  version: 1,
  view: "all",
  search: "",
  sourceKey: "",
  date: "",
  selectedCaptureId: "",
};

export function parseViewState(value: unknown): LibraryViewState {
  if (!value || typeof value !== "object") return DEFAULT_VIEW_STATE;
  const state = value as Partial<LibraryViewState>;
  const view = (["all", "pending", "history", "saved"] as const).includes(
    state.view as LibraryView,
  )
    ? (state.view as LibraryView)
    : "all";
  const date = (["", "today", "week"] as const).includes(
    state.date as LibraryDateFilter,
  )
    ? (state.date as LibraryDateFilter)
    : "";
  return {
    version: 1,
    view,
    search: typeof state.search === "string" ? state.search.slice(0, 2_000) : "",
    sourceKey:
      typeof state.sourceKey === "string" ? state.sourceKey.slice(0, 8_192) : "",
    date,
    selectedCaptureId:
      typeof state.selectedCaptureId === "string"
        ? state.selectedCaptureId.slice(0, 256)
        : "",
  };
}

export async function readViewState(): Promise<LibraryViewState> {
  const stored = await chrome.storage.local.get(VIEW_STATE_KEY);
  return parseViewState(stored[VIEW_STATE_KEY]);
}

export async function writeViewState(state: LibraryViewState): Promise<void> {
  await chrome.storage.local.set({ [VIEW_STATE_KEY]: state });
}

export function kindLabel(kind: CaptureListItem["kind"] | string): string {
  const labels: Readonly<Record<string, string>> = {
    media_range: "视频",
    audio_range: "音频",
    image: "图片",
    region_capture: "截图",
    text_selection: "文字",
    mixed_selection: "图文",
    clipboard_import: "剪贴板",
  };
  return labels[kind] ?? "素材";
}

export function statusCode(item: CaptureListItem): string {
  if (item.state === "open" || item.state === "interrupted") return item.state;
  return item.latestJobStatus ?? item.state;
}

export function statusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    pending: "待处理",
    processing: "处理中",
    completed: "已处理",
    failed: "处理失败",
    open: "记录中",
    interrupted: "已中断",
    sealed: "已保存",
  };
  return labels[status] ?? status;
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return t("时间待补");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return t("时间格式不可用");
  return new Date(timestamp).toLocaleString(getLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_024 * 1_024 * 1_024) {
    return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(2)} GiB`;
}

function isEmptyTerminalBrowserRecording(attachment: AttachmentRecord): boolean {
  return (
    attachment.kind === "browser_recording" &&
    attachment.status !== "writing" &&
    attachment.byteLength === 0
  );
}

/** Treats legacy empty recording rows conservatively, including rows without diagnostics. */
export function attachmentHasAvailableBytes(attachment: AttachmentRecord): boolean {
  if (!attachment.dataAvailable) return false;
  return !isEmptyTerminalBrowserRecording(attachment);
}

export function attachmentAvailabilityLabel(attachment: AttachmentRecord): string {
  if (
    isEmptyTerminalBrowserRecording(attachment) &&
    attachment.recordingFailure?.started === false
  ) {
    return "无录制字节，失败事实可用";
  }
  if (isEmptyTerminalBrowserRecording(attachment)) return "暂无可用录制数据";
  return attachmentHasAvailableBytes(attachment)
    ? "数据可用"
    : "仅元数据，附件字节不可用";
}

export function safeWebUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function createdFromFor(date: LibraryDateFilter, now = Date.now()): string | undefined {
  if (!date) return undefined;
  if (date === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  return new Date(now - 7 * 24 * 60 * 60_000).toISOString();
}
