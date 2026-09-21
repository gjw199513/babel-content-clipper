import type {
  AttachmentRecord,
  BackupBundle,
  CaptureDetailResult,
  CaptureListItem,
  CaptureListResult,
  CleanupPreviewResult,
  FailureInfo,
  JobRecord,
  ResultArtifact,
  ResultRecord,
  TimeRange,
} from "../../../packages/core/src/types.js";

import { sanitizeHtml } from "./dom-safety.js";
import {
  getLocale,
  initializeI18n,
  installLanguageControl,
  localizeMessage,
  onLocaleChange,
  t,
  translateDocument,
} from "./i18n.js";
import { redactUrl } from "./security.js";
import { EXTENSION_CHANNEL } from "./messages.js";
import { installClipboardImport } from "./clipboard-import.js";
import { collectPendingBatch, type PendingBatchItem } from "./pending-batch.js";
import {
  DEFAULT_VIEW_STATE,
  LIBRARY_REVISION_KEY,
  VIEW_STATE_KEY,
  attachmentAvailabilityLabel,
  attachmentHasAvailableBytes,
  callCore,
  createdFromFor,
  kindLabel,
  parseViewState,
  readViewState,
  safeWebUrl,
  sendRuntime,
  statusCode,
  statusLabel,
  type LibraryViewState,
  type UiConnectionStatus,
  UiCoreError,
  writeViewState,
} from "./ui-shared.js";

const PAGE_SIZE = 50;
const MEBIBYTE = 1_024 * 1_024;

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

const list = $("#library-list") as HTMLElement;
const detail = $("#detail") as HTMLElement;
const toast = $("#toast") as HTMLElement;
const searchInput = $("#search") as HTMLInputElement;
const sourceFilter = $("#source-filter") as HTMLSelectElement;
const dateFilter = $("#date-filter") as HTMLSelectElement;
const includeFailedCleanup = $("#include-failed-cleanup") as HTMLInputElement;
const includeAttachments = $("#include-attachments") as HTMLInputElement;
const importFile = $("#import-file") as HTMLInputElement;
const copyPendingBatchButton = $("#copy-pending-batch") as HTMLButtonElement;
const connectionBanner = $("#connection-banner") as HTMLElement;

let state: LibraryViewState = DEFAULT_VIEW_STATE;
let records: CaptureListItem[] = [];
let nextCursor: string | null = null;
let loadGeneration = 0;
let searchTimer: number | undefined;
let activeDetail: "capture" | "settings" | "empty" = "empty";
let currentDetailData: CaptureDetailResult | undefined;
let settingsBudgetBytes: { used: number; maximum: number } | undefined;
const sourceLabels = new Map<string, string>();
const syntheticSourceLabels = new Map<string, "unnamed" | "saved-filter">();

type TranslationValues = Record<string, string | number>;

function clear(node: Element): void {
  node.replaceChildren();
}

function paragraph(className: string, text: string): HTMLParagraphElement {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

function bindTranslation<T extends HTMLElement>(
  node: T,
  source: string,
  values?: TranslationValues,
): T {
  node.dataset.i18n = source;
  if (values) node.dataset.i18nValues = JSON.stringify(values);
  else delete node.dataset.i18nValues;
  node.textContent = t(source, values);
  return node;
}

function translatedParagraph(
  className: string,
  source: string,
  values?: TranslationValues,
): HTMLParagraphElement {
  return bindTranslation(paragraph(className, ""), source, values);
}

function localizedMessageParagraph(className: string, message: string): HTMLParagraphElement {
  const node = paragraph(className, localizeMessage(message));
  node.dataset.localizeMessage = "true";
  return node;
}

function bindTranslatedAttribute(
  node: HTMLElement,
  attribute: "placeholder" | "title" | "aria-label",
  source: string,
): void {
  if (attribute === "placeholder") node.dataset.i18nPlaceholder = source;
  else if (attribute === "title") node.dataset.i18nTitle = source;
  else node.dataset.i18nAriaLabel = source;
  node.setAttribute(attribute, t(source));
}

function numberText(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}

function formatDateTimeLocalized(value: string | undefined): string {
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

function formatBytesLocalized(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1_024) return `${numberText(bytes)} B`;
  if (bytes < 1_024 * 1_024) {
    return `${numberText(bytes / 1_024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KiB`;
  }
  if (bytes < 1_024 * 1_024 * 1_024) {
    return `${numberText(bytes / (1_024 * 1_024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MiB`;
  }
  return `${numberText(bytes / (1_024 * 1_024 * 1_024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GiB`;
}

function localizedKindLabel(kind: CaptureListItem["kind"] | string): string {
  return t(kindLabel(kind));
}

function localizedStatusLabel(status: string): string {
  return t(statusLabel(status));
}

function localizedAttachmentAvailability(attachment: AttachmentRecord): string {
  return t(attachmentAvailabilityLabel(attachment));
}

const SYSTEM_CODE_LABELS: Readonly<Record<string, string>> = {
  media_object: "媒体对象",
  page_scene: "页面画面",
  source_media: "源媒体",
  recording_elapsed: "录制经过时间",
  location_only: "仅保存位置",
  partial_saved: "部分已保存",
  saved: "已保存",
  complete_selection: "选择内容完整",
  partial: "内容不完整",
  needs_completion: "需要补全",
  initial_processing: "首次处理",
  reprocess: "重新处理",
  task: "任务提供",
  connection: "连接提供",
  global: "全局设置",
  none: "未配置",
  active: "执行中",
  uncertain: "状态待确认",
  source_image: "源图片",
  screen_region: "区域截图",
  browser_recording: "浏览器录制",
  text: "文字",
  thumbnail: "缩略图",
  other: "其他",
  writing: "写入中",
  complete: "完整",
  interrupted: "已中断",
  normalized_recording: "规范化录制",
  saved_text: "已保存文字",
  padded: "保留前后预留",
  original: "仅原始选择范围",
  custom: "自定义范围",
  agent_reported: "Agent 报告",
  bridge_verified: "本地桥已验证",
  video: "视频",
  audio: "音频",
  image: "图片",
  frame: "帧图片",
  manifest: "清单",
  created: "已创建",
  claimed: "已领取",
  heartbeat: "心跳",
  retry: "重试",
  completed: "已完成",
  failed: "已失败",
  "context-menu-image": "图片右键菜单",
  "explicit-paste": "显式粘贴",
  html_media_position: "网页媒体位置",
  "media-timeline": "媒体时间线",
  "screen-region": "屏幕区域",
  selection: "页面选择",
  "tab-recording": "标签页录制",
  end_click: "终点点击",
  image_bytes: "图片数据",
  image_fetch_limit: "图片获取上限",
};

function localizedSystemCode(value: string | undefined): string {
  if (!value) return "—";
  const source = SYSTEM_CODE_LABELS[value];
  return source ? t(source) : localizeMessage(value);
}

function makeButton(
  label: string,
  listener: () => void,
  tone?: "accent" | "danger" | "quiet",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  bindTranslation(button, label);
  if (tone) button.dataset.tone = tone;
  button.addEventListener("click", listener);
  return button;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? localizeMessage(error.message)
    : t(fallback);
}

function notify(message: string): void {
  toast.textContent = message;
  toast.dataset.open = "true";
  window.setTimeout(() => {
    toast.dataset.open = "false";
  }, 3_500);
}

function setBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function renderState(
  parent: HTMLElement,
  title: string,
  message: string,
  retry?: () => void,
  translateMessage = true,
): void {
  clear(parent);
  const wrapper = document.createElement("div");
  wrapper.className = retry ? "error-state" : "empty-list";
  const mark = document.createElement("span");
  mark.className = "empty-mark";
  mark.textContent = retry ? "!" : "⌁";
  const heading = bindTranslation(document.createElement("h2"), title);
  wrapper.append(
    mark,
    heading,
    translateMessage ? translatedParagraph("", message) : localizedMessageParagraph("", message),
  );
  if (retry) wrapper.append(makeButton("重试", retry));
  parent.append(wrapper);
}

function setSettingsView(enabled: boolean): void {
  document.body.classList.toggle("settings-view", enabled);
}

function openSettingsView(): void {
  history.replaceState(null, "", `${location.pathname}#settings`);
  void renderSettings();
}

function renderConnectionBanner(connection: UiConnectionStatus | undefined, error?: unknown): void {
  clear(connectionBanner);
  const disconnected = !connection?.native.connected;
  connectionBanner.hidden = !disconnected;
  if (!disconnected) return;

  const heading = document.createElement("strong");
  bindTranslation(heading, "Agent 暂时无法读取或回写记录");
  const message = translatedParagraph(
    "",
    error
      ? "连接状态暂时不可用；请点击“打开连接设置”，在连接设置页点击“重连本地服务”，看到“本地桥已连接”后，再让 Agent 刷新 MCP。"
      : "请按这个顺序操作：先点击“打开连接设置”，进入页面后点击“重连本地服务”；看到“本地桥已连接”后，再让 Agent 刷新 MCP。",
  );
  const actions = document.createElement("div");
  actions.className = "connection-banner-actions";
  actions.append(
    makeButton("打开连接设置", openSettingsView, "accent"),
    makeButton("重新检查连接", () => void refreshConnectionBanner(), "quiet"),
  );
  connectionBanner.className = "connection-banner";
  connectionBanner.append(
    translatedParagraph("eyebrow", "MCP 连接未完成"),
    heading,
    message,
    ...(error ? [localizedMessageParagraph("failure-card", errorMessage(error, "连接状态不可用。"))] : []),
    actions,
  );
}

async function refreshConnectionBanner(): Promise<void> {
  try {
    renderConnectionBanner(await callCore("connection.status"));
  } catch (error) {
    renderConnectionBanner(undefined, error);
  }
}

function renderEmptyDetail(message = "详情会显示完整原文、来源定位、范围快照、处理历史与附件事实。"): void {
  setSettingsView(false);
  activeDetail = "empty";
  currentDetailData = undefined;
  clear(detail);
  const wrapper = document.createElement("div");
  wrapper.className = "empty-detail";
  const mark = document.createElement("span");
  mark.className = "empty-mark";
  mark.textContent = "⌁";
  const heading = bindTranslation(document.createElement("h2"), "选择一条记录");
  wrapper.append(mark, heading, translatedParagraph("", message));
  detail.append(wrapper);
}

function visibleRecords(): CaptureListItem[] {
  const query = state.search.trim().toLocaleLowerCase(getLocale());
  if (!query) return records;
  return records.filter((record) =>
    `${record.title} ${record.site} ${record.preview}`.toLocaleLowerCase(getLocale()).includes(query),
  );
}

function listParams(cursor?: string): Record<string, unknown> {
  const createdFrom = createdFromFor(state.date);
  return {
    view: state.view === "saved" ? "all" : state.view,
    ...(state.view === "saved" ? { collection: "saved" } : {}),
    ...(state.sourceKey ? { sourceKey: state.sourceKey } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(cursor ? { cursor } : {}),
    limit: PAGE_SIZE,
  };
}

function pendingBatchListParams(snapshot: LibraryViewState, cursor?: string): Record<string, unknown> {
  const createdFrom = createdFromFor(snapshot.date);
  return {
    view: "pending",
    ...(snapshot.sourceKey ? { sourceKey: snapshot.sourceKey } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 200,
  };
}

function updateSourceOptions(): void {
  for (const record of records) {
    const sourceTitle = record.title.trim() || record.site.trim();
    const label = sourceTitle || t("未命名来源");
    if (!sourceLabels.has(record.sourceKey) || syntheticSourceLabels.has(record.sourceKey)) {
      sourceLabels.set(record.sourceKey, record.site ? `${label} · ${record.site}` : label);
      if (sourceTitle) syntheticSourceLabels.delete(record.sourceKey);
      else syntheticSourceLabels.set(record.sourceKey, "unnamed");
    }
  }
  const selected = state.sourceKey;
  clear(sourceFilter);
  const all = document.createElement("option");
  all.value = "";
  bindTranslation(all, "全部来源");
  sourceFilter.append(all);
  if (selected && !sourceLabels.has(selected)) syntheticSourceLabels.set(selected, "saved-filter");
  for (const [sourceKey, kind] of syntheticSourceLabels) {
    sourceLabels.set(sourceKey, t(kind === "unnamed" ? "未命名来源" : "已保存的来源筛选"));
  }
  for (const [sourceKey, label] of [...sourceLabels].sort((left, right) =>
    left[1].localeCompare(right[1], getLocale()),
  )) {
    const option = document.createElement("option");
    option.value = sourceKey;
    option.textContent = label;
    sourceFilter.append(option);
  }
  sourceFilter.value = selected;
}

function appendSourceHeading(section: HTMLElement, record: CaptureListItem, count: number): void {
  const heading = document.createElement("div");
  heading.className = "source-heading";
  const copy = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = record.title || record.site || t("未命名来源");
  const site = record.site
    ? paragraph("source-line", record.site)
    : translatedParagraph("source-line", "来源站点未知");
  copy.append(title, site);
  const total = document.createElement("span");
  bindTranslation(total, "{count} 条已载入", { count: numberText(count) });
  heading.append(copy, total);
  section.append(heading);
}

function renderRow(record: CaptureListItem): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `library-row${record.captureId === state.selectedCaptureId ? " is-selected" : ""}`;
  const badge = document.createElement("span");
  badge.className = "type-badge";
  bindTranslation(badge, kindLabel(record.kind));
  const body = document.createElement("span");
  body.className = "library-row-body";
  const copy = document.createElement("strong");
  copy.textContent = record.preview || record.title || t("未命名记录");
  const metadata = document.createElement("small");
  bindTranslation(metadata, "{kind} · {date}", {
    kind: localizedKindLabel(record.kind),
    date: formatDateTimeLocalized(record.createdAt),
  });
  body.append(copy, metadata);
  const status = document.createElement("span");
  const code = statusCode(record);
  status.className = `row-status status-${code}`;
  if (record.collection === "saved") {
    bindTranslation(status, "仅收藏 · {status}", { status: localizedStatusLabel(code) });
  } else {
    bindTranslation(status, statusLabel(code));
  }
  button.append(badge, body, status);
  button.addEventListener("click", () => {
    void selectCapture(record.captureId);
  });
  return button;
}

function appendPagination(): void {
  const footer = document.createElement("div");
  footer.className = "pagination";
  const count = document.createElement("span");
  bindTranslation(
    count,
    nextCursor ? "已载入 {count} 条，仍有更多记录" : "已载入全部 {count} 条记录",
    { count: numberText(records.length) },
  );
  footer.append(count);
  if (nextCursor) {
    const more = makeButton("加载更多", () => {
      setBusy(more, true);
      void loadPage(false).finally(() => setBusy(more, false));
    });
    footer.append(more);
  }
  list.append(footer);
}

function renderList(): void {
  clear(list);
  const visible = visibleRecords();
  if (visible.length === 0) {
    const message = nextCursor && state.search.trim()
      ? "当前已载入范围没有匹配项，搜索仍在继续读取后续页面。"
      : "尝试切换视图或清空筛选；新的采集会在这里出现。";
    renderState(list, "没有符合条件的记录", message);
    appendPagination();
    return;
  }
  const groups = new Map<string, CaptureListItem[]>();
  for (const record of visible) {
    const group = groups.get(record.sourceKey) ?? [];
    group.push(record);
    groups.set(record.sourceKey, group);
  }
  for (const group of groups.values()) {
    const section = document.createElement("section");
    section.className = "source-group";
    const first = group[0];
    if (!first) continue;
    appendSourceHeading(section, first, group.length);
    for (const record of group) section.append(renderRow(record));
    list.append(section);
  }
  appendPagination();
}

async function loadPage(reset: boolean): Promise<void> {
  const generation = reset ? ++loadGeneration : loadGeneration;
  if (reset) {
    records = [];
    nextCursor = null;
    clear(list);
    const loading = document.createElement("div");
    loading.className = "loading-state";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    loading.append(spinner, translatedParagraph("", "正在读取本地记录…"));
    list.append(loading);
  }
  try {
    let cursor = reset ? undefined : (nextCursor ?? undefined);
    do {
      const page: CaptureListResult = await callCore("capture.list", listParams(cursor));
      if (generation !== loadGeneration) return;
      const known = new Set(records.map((record) => record.captureId));
      records.push(...page.records.filter((record) => !known.has(record.captureId)));
      nextCursor = page.nextCursor;
      cursor = page.nextCursor ?? undefined;
      updateSourceOptions();
      renderList();
      // The core API has no free-text query. Continue through every page while
      // a search is active so a sparse match is not hidden behind page one.
    } while (state.search.trim() && cursor && generation === loadGeneration);
    if (state.selectedCaptureId && activeDetail !== "settings") {
      await loadDetail(state.selectedCaptureId, generation);
    }
  } catch (error) {
    if (generation !== loadGeneration) return;
    if (records.length > 0) {
      notify(errorMessage(error, "后续记录读取失败。"));
      renderList();
      return;
    }
    renderState(
      list,
      "记录暂时不可用",
      errorMessage(error, "数据库或后台服务未响应。"),
      () => void loadPage(true),
      false,
    );
  }
}

async function persistState(reload: boolean): Promise<void> {
  await writeViewState(state);
  if (reload) await loadPage(true);
}

async function selectCapture(captureId: string): Promise<void> {
  setSettingsView(false);
  state = { ...state, selectedCaptureId: captureId };
  activeDetail = "capture";
  currentDetailData = undefined;
  renderList();
  await writeViewState(state);
  await loadDetail(captureId, loadGeneration);
}

function appendKeyValue(parent: HTMLElement, label: string, value: unknown): void {
  const row = document.createElement("div");
  row.className = "detail-kv";
  const term = document.createElement("dt");
  bindTranslation(term, label);
  const description = document.createElement("dd");
  if (typeof value === "string") description.textContent = value || "—";
  else if (value === undefined) description.textContent = "—";
  else description.textContent = JSON.stringify(value, null, 2) ?? "—";
  row.append(term, description);
  parent.append(row);
}

function appendSectionHeading(
  parent: HTMLElement,
  title: string,
  subtitle?: string,
  subtitleValues?: TranslationValues,
): void {
  const heading = document.createElement("div");
  heading.className = "section-title";
  const titleNode = document.createElement("h3");
  bindTranslation(titleNode, title);
  heading.append(titleNode);
  if (subtitle) heading.append(translatedParagraph("muted", subtitle, subtitleValues));
  parent.append(heading);
}

function formatRanges(ranges: readonly TimeRange[]): string {
  if (ranges.length === 0) return t("无");
  return ranges.map((range) => t("{start} 秒 – {end} 秒", {
    start: numberText(range.start, { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
    end: numberText(range.end, { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
  })).join("\n");
}

function renderFailure(parent: HTMLElement, failure: FailureInfo | undefined): void {
  if (!failure) return;
  const box = document.createElement("div");
  box.className = "failure-card";
  const title = document.createElement("strong");
  title.textContent = `${failure.code} · ${failure.stage}`;
  box.append(title, paragraph("", localizeMessage(failure.message)));
  appendKeyValue(box, "重试次数", failure.retryCount);
  if (failure.details) appendKeyValue(box, "脱敏上下文", failure.details);
  parent.append(box);
}

function artifactDescription(artifact: ResultArtifact): string {
  const parts = [localizedSystemCode(artifact.kind), artifact.mimeType];
  if (artifact.byteLength !== undefined) parts.push(formatBytesLocalized(artifact.byteLength));
  if (artifact.durationSeconds !== undefined) {
    parts.push(t("{seconds} 秒", {
      seconds: numberText(artifact.durationSeconds, { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
    }));
  }
  return parts.join(" · ");
}

function renderArtifact(artifact: ResultArtifact): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "artifact-card";
  const title = document.createElement("strong");
  title.textContent = artifactDescription(artifact);
  item.append(title);
  if (artifact.fileReference) {
    const reference = document.createElement("code");
    reference.textContent = artifact.fileReference;
    item.append(reference);
  }
  if (artifact.attachmentId) {
    item.append(translatedParagraph("muted", "附件 {id}", { id: artifact.attachmentId }));
  }
  if (artifact.sourceMediaSeconds !== undefined) {
    item.append(translatedParagraph("muted", "源时间 {seconds} 秒", {
      seconds: numberText(artifact.sourceMediaSeconds, { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
    }));
  }
  return item;
}

function renderResult(result: ResultRecord, index: number): HTMLElement {
  const card = document.createElement("article");
  card.className = "history-card";
  const heading = document.createElement("div");
  heading.className = "history-heading";
  const title = document.createElement("strong");
  bindTranslation(title, "结果 {index} · {status}", {
    index: numberText(index + 1),
    status: localizedStatusLabel(result.status),
  });
  const time = document.createElement("time");
  time.textContent = formatDateTimeLocalized(result.completedAt);
  heading.append(title, time);
  card.append(heading);
  const facts = document.createElement("dl");
  facts.className = "detail-facts compact-facts";
  appendKeyValue(facts, "结果 ID", result.resultId);
  appendKeyValue(facts, "工作项", result.jobId);
  appendKeyValue(facts, "获取方式", localizedSystemCode(result.acquisitionMethod));
  appendKeyValue(facts, "请求范围", formatRanges(result.requestedRanges));
  appendKeyValue(facts, "实际获取", formatRanges(result.acquiredRanges));
  appendKeyValue(facts, "最终输出", formatRanges(result.outputRanges));
  appendKeyValue(facts, "验证等级", localizedSystemCode(result.verification.level));
  appendKeyValue(
    facts,
    "验证警告",
    result.verification.warnings.map((warning) => localizeMessage(warning)),
  );
  card.append(facts);
  if (result.artifacts.length > 0) {
    const listNode = document.createElement("ul");
    listNode.className = "artifact-list";
    for (const artifact of result.artifacts) listNode.append(renderArtifact(artifact));
    card.append(listNode);
  } else {
    card.append(translatedParagraph("muted", "这次结果没有登记产物。"));
  }
  renderFailure(card, result.failure);
  return card;
}

function renderJob(job: JobRecord, index: number): HTMLElement {
  const card = document.createElement("article");
  card.className = "history-card";
  const heading = document.createElement("div");
  heading.className = "history-heading";
  const title = document.createElement("strong");
  bindTranslation(title, "执行 {index} · {status}", {
    index: numberText(index + 1),
    status: localizedStatusLabel(job.status),
  });
  const time = document.createElement("time");
  time.textContent = formatDateTimeLocalized(job.updatedAt);
  heading.append(title, time);
  card.append(heading);
  const facts = document.createElement("dl");
  facts.className = "detail-facts compact-facts";
  appendKeyValue(facts, "工作项 ID", job.jobId);
  appendKeyValue(facts, "发起原因", t(job.reason === "reprocess" ? "重新处理" : "首次处理"));
  appendKeyValue(facts, "父工作项", job.parentJobId);
  appendKeyValue(facts, "输出目录", job.directory.path ?? t("未配置"));
  appendKeyValue(facts, "目录来源", localizedSystemCode(job.directory.source));
  appendKeyValue(facts, "领取 Agent", job.claim?.workerId);
  appendKeyValue(facts, "执行状态", localizedSystemCode(job.executionState));
  card.append(facts);
  renderFailure(card, job.failure);
  return card;
}

function renderAttachment(attachment: AttachmentRecord): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "attachment-card";
  const title = document.createElement("strong");
  title.textContent = `${localizedSystemCode(attachment.kind)} · ${localizedSystemCode(attachment.status)}`;
  const details = paragraph(
    "muted",
    `${attachment.mimeType} · ${formatBytesLocalized(attachment.byteLength)} · ${localizedAttachmentAvailability(attachment)}`,
  );
  const id = document.createElement("code");
  id.textContent = attachment.attachmentId;
  item.append(title, details, id);
  if (attachment.recordingCoverage) {
    const coverage = attachment.recordingCoverage;
    item.append(translatedParagraph("muted", "录制 {elapsed} 秒 · 后置预留 {actual}/{requested} 秒 · {coverage} · {video}/{audio}/{monitor}", {
      elapsed: numberText(coverage.elapsedSeconds, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      actual: numberText(coverage.actualPostRollRecordingSeconds, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      requested: numberText(coverage.requestedPostRollSeconds, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      coverage: t(coverage.postRollComplete ? "覆盖完整" : "覆盖不完整"),
      video: t(coverage.hasVideo ? "有画面" : "无画面"),
      audio: t(coverage.hasAudio ? "有声音" : "无声音"),
      monitor: t(coverage.audioMonitor ? "原声已回放" : "原声回放未确认"),
    }));
  }
  if (attachment.recordingFailure) {
    const failure = attachment.recordingFailure;
    item.append(translatedParagraph("failure-card", "{state} · {code} · {message}", {
      state: t(failure.started ? "现场录制中断" : "现场录制未开始"),
      code: failure.code,
      message: localizeMessage(failure.message),
    }));
  }
  if (attachment.fileReference) {
    const reference = document.createElement("code");
    reference.textContent = attachment.fileReference;
    item.append(reference);
  }
  return item;
}

function renderSelection(data: CaptureDetailResult): void {
  const selection = data.capture.selection;
  appendSectionHeading(detail, "采集事实", "封存内容只读；重新处理会创建新的工作项。");
  if (selection.type === "text") {
    const article = document.createElement("article");
    article.className = "detail-content";
    article.append(translatedParagraph("eyebrow", "完整原文"));
    const text = paragraph("selection-copy", selection.exact);
    article.append(text);
    if (selection.sanitizedHtml) {
      article.append(translatedParagraph("eyebrow preview-label", "安全图文预览"));
      const preview = document.createElement("div");
      preview.className = "safe-preview";
      preview.innerHTML = sanitizeHtml(selection.sanitizedHtml);
      article.append(preview);
    }
    detail.append(article);
    return;
  }
  const facts = document.createElement("dl");
  facts.className = "detail-facts";
  if (selection.type === "media") {
    appendKeyValue(facts, "目标", localizedSystemCode(selection.target));
    appendKeyValue(facts, "时间基准", localizedSystemCode(selection.timeBasis));
    appendKeyValue(facts, "真实起点", selection.startClick);
    appendKeyValue(facts, "真实终点", selection.endClick);
    appendKeyValue(facts, "观测区间", formatRanges(selection.segments));
    appendKeyValue(facts, "单次采集并集", formatRanges(selection.normalizedSegments));
    appendKeyValue(facts, "带预留获取范围", formatRanges(data.capture.plannedAcquisitionRanges));
    appendKeyValue(facts, "跳转与播放事实", selection.events);
  } else if (selection.type === "image") {
    appendKeyValue(facts, "资源地址", selection.resourceUrl ? redactUrl(selection.resourceUrl) : undefined);
    appendKeyValue(facts, "原始尺寸", selection.naturalWidth && selection.naturalHeight
      ? `${selection.naturalWidth} × ${selection.naturalHeight}` : undefined);
    appendKeyValue(facts, "替代文字", selection.altText);
    appendKeyValue(facts, "定位", selection.locator);
  } else if (selection.type === "region") {
    appendKeyValue(facts, "区域", `${selection.x}, ${selection.y} · ${selection.width} × ${selection.height}`);
    appendKeyValue(facts, "视口", `${selection.viewportWidth} × ${selection.viewportHeight}`);
    appendKeyValue(facts, "像素比", selection.devicePixelRatio);
  } else {
    appendKeyValue(facts, "剪贴板文字", selection.text);
    appendKeyValue(facts, "来源已知", t(selection.sourceKnown ? "是" : "否"));
  }
  detail.append(facts);
}

function taskDescription(data: CaptureDetailResult): string {
  const currentJob = data.jobs.at(-1);
  const rangeText = data.capture.selection.type === "media"
    ? t(" 原始规范区间：{ranges}。", {
      ranges: formatRanges(data.capture.selection.normalizedSegments),
    })
    : "";
  const outputPolicy = currentJob?.executionOptions.outputRangePolicy;
  const attachmentSummary = data.attachments.length === 0
    ? t("没有已保存附件")
    : t("{count} 个附件记录，其中 {available} 个数据可用", {
      count: numberText(data.attachments.length),
      available: numberText(data.attachments.filter(attachmentHasAvailableBytes).length),
    });
  return [
    t("请处理 Babel Content Clipper 记录 {captureId}。", { captureId: data.capture.captureId }),
    currentJob
      ? t("当前工作项 {jobId}，状态为 {status}。", {
        jobId: currentJob.jobId,
        status: localizedStatusLabel(currentJob.status),
      })
      : t("请先查询记录详情。"),
    t("来源：{source}（{url}）。{range}", {
      source: data.capture.source.title || data.capture.source.site,
      url: redactUrl(data.capture.source.pageUrl),
      range: rangeText,
    }),
    t("预留快照：前 {before} 秒、后 {after} 秒；{policy}。", {
      before: numberText(data.capture.padding.beforeSeconds),
      after: numberText(data.capture.padding.afterSeconds),
      policy: outputPolicy
        ? t("当前工作项输出策略为 {policy}", { policy: localizedSystemCode(outputPolicy) })
        : t("尚无工作项输出策略，执行时需明确"),
    }),
    t("附件：{summary}。已有 {count} 份终态结果。", {
      summary: attachmentSummary,
      count: numberText(data.results.length),
    }),
    t("请先通过 MCP 查询详情。待处理工作项须原子领取；若当前工作项已终态且用户明确要求重做，请创建新的重处理工作项。按记录事实与输出要求执行并回写完成或失败结果，不覆盖历史结果。"),
  ].join("\n");
}

function batchTaskDescription(items: readonly PendingBatchItem[]): string {
  const identifiers = items.map((item) => `- captureId=${item.captureId}; jobId=${item.jobId}`).join("\n");
  return [
    t("请统一处理 Babel Content Clipper 当前批次，共 {count} 个待处理工作项。", {
      count: numberText(items.length),
    }),
    t("这是明确执行授权，仅限下列 Capture/Job 快照；无需逐条再次向我确认，也不要自动纳入本次复制后新增的记录。"),
    t("请先读取 pending_batch_processing 处理指南，逐页核对记录；使用 babel_clipper_claim_records 分批原子领取（每次最多 200 个 jobId），只处理 accepted 项。"),
    t("每条记录独立读取、输出、验证和回写；一条失败不得撤销其他成功项。不得覆盖历史、自动重处理失败项或自动清理记录。"),
    t("每条任务按其实际输出要求处理；需要视频文字且已有文字不足时，再读取 video_text_extraction 指南。所有后处理由 Agent 使用自己的工具完成，不操作浏览器页面。"),
    t("如某项已被领取或不再符合条件，请跳过并在批次汇总中如实报告。"),
    t("批次项目："),
    identifiers,
  ].join("\n");
}

function renderCaptureDetail(data: CaptureDetailResult): void {
  setSettingsView(false);
  activeDetail = "capture";
  currentDetailData = data;
  clear(detail);
  const capture = data.capture;
  const latestJob = data.jobs.at(-1);
  const heading = document.createElement("div");
  heading.className = "detail-heading";
  heading.append(translatedParagraph("eyebrow", "{kind} · {status}", {
    kind: localizedKindLabel(capture.kind),
    status: localizedStatusLabel(latestJob?.status ?? capture.state),
  }));
  const title = document.createElement("h2");
  title.textContent = capture.source.title || capture.source.site || t("未命名记录");
  heading.append(title);
  const redactedPageUrl = redactUrl(capture.source.pageUrl);
  const href = safeWebUrl(redactedPageUrl);
  if (href) {
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = redactedPageUrl;
    heading.append(link);
  } else {
    const source = document.createElement("code");
    source.className = "unsafe-source";
    source.textContent = redactedPageUrl || t("来源地址不可用");
    heading.append(source);
  }
  detail.append(heading);

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const saveLabel = capture.collection === "saved" ? "重新加入待办" : "设为仅收藏";
  actions.append(makeButton(saveLabel, () => void setCollection(data)));
  actions.append(makeButton("复制任务说明", () => void copyTask(data), "quiet"));
  if (latestJob?.status === "completed" || latestJob?.status === "failed") {
    actions.append(makeButton("重新处理", () => void reprocessCapture(data), "accent"));
  }
  actions.append(makeButton("清理这条", () => void cleanupCapture(data), "danger"));
  actions.append(makeButton("清理同来源已处理", () => void cleanupSource(data), "danger"));
  detail.append(actions);

  const facts = document.createElement("dl");
  facts.className = "detail-facts";
  appendKeyValue(facts, "采集时间", formatDateTimeLocalized(capture.createdAt));
  appendKeyValue(facts, "记录 ID", capture.captureId);
  appendKeyValue(facts, "采集方式", localizedSystemCode(capture.captureMethod));
  appendKeyValue(facts, "记录状态", localizedStatusLabel(capture.state));
  appendKeyValue(facts, "当前处理", latestJob ? localizedStatusLabel(latestJob.status) : t("无工作项"));
  appendKeyValue(facts, "待办参与", t(capture.collection === "saved" ? "仅收藏" : "待办"));
  appendKeyValue(facts, "附件状态", localizedSystemCode(capture.assetsState));
  appendKeyValue(facts, "完整性", capture.integrity.missing.length > 0
    ? t("{status}；缺少：{missing}", {
      status: localizedSystemCode(capture.integrity.status),
      missing: capture.integrity.missing.map(localizedSystemCode).join(t("、")),
    })
    : localizedSystemCode(capture.integrity.status));
  appendKeyValue(facts, "预留", t("前 {before} 秒 / 后 {after} 秒", {
    before: numberText(capture.padding.beforeSeconds),
    after: numberText(capture.padding.afterSeconds),
  }));
  detail.append(facts);

  renderSelection(data);

  appendSectionHeading(detail, "处理历史", "{count} 次执行；终态结果不会被后续执行覆盖。", {
    count: numberText(data.jobs.length),
  });
  if (data.jobs.length === 0) detail.append(translatedParagraph("muted", "尚未创建处理工作项。"));
  else data.jobs.forEach((job, index) => detail.append(renderJob(job, index)));

  appendSectionHeading(detail, "结果与产物", "{count} 份终态结果。", {
    count: numberText(data.results.length),
  });
  if (data.results.length === 0) detail.append(translatedParagraph("muted", "尚无完成或失败结果。"));
  else data.results.forEach((result, index) => detail.append(renderResult(result, index)));

  appendSectionHeading(detail, "附件事实", "{count} 个附件记录。", {
    count: numberText(data.attachments.length),
  });
  if (data.attachments.length === 0) {
    detail.append(translatedParagraph("muted", "这条记录没有附件。"));
  } else {
    const attachments = document.createElement("ul");
    attachments.className = "attachment-list";
    for (const attachment of data.attachments) attachments.append(renderAttachment(attachment));
    detail.append(attachments);
  }

  if (data.events.length > 0) {
    appendSectionHeading(detail, "执行事件", "{count} 条按时间保存的事件。", {
      count: numberText(data.events.length),
    });
    const events = document.createElement("ol");
    events.className = "event-list";
    for (const event of data.events) {
      const item = document.createElement("li");
      item.textContent = `${formatDateTimeLocalized(event.createdAt)} · ${localizedSystemCode(event.type)}${event.message ? ` · ${localizeMessage(event.message)}` : ""}`;
      events.append(item);
    }
    detail.append(events);
  }
}

async function loadDetail(captureId: string, generation = loadGeneration): Promise<void> {
  if (!captureId) {
    renderEmptyDetail();
    return;
  }
  try {
    const data = await callCore("capture.get", { captureId });
    if (generation !== loadGeneration || state.selectedCaptureId !== captureId || activeDetail === "settings") return;
    renderCaptureDetail(data);
  } catch (error) {
    if (generation !== loadGeneration || state.selectedCaptureId !== captureId || activeDetail === "settings") return;
    if (error instanceof UiCoreError && error.code === "NOT_FOUND") {
      state = { ...state, selectedCaptureId: "" };
      await writeViewState(state);
      renderList();
      renderEmptyDetail("所选记录已清理或不属于当前浏览器。请选择其他记录。");
      return;
    }
    clear(detail);
    const wrapper = document.createElement("div");
    wrapper.className = "error-state";
    const heading = document.createElement("strong");
    bindTranslation(heading, "详情暂时不可用");
    wrapper.append(heading, localizedMessageParagraph("", errorMessage(error, "记录读取失败。")));
    wrapper.append(makeButton("重试", () => void loadDetail(captureId)));
    detail.append(wrapper);
  }
}

async function setCollection(data: CaptureDetailResult): Promise<void> {
  const collection = data.capture.collection === "saved" ? "inbox" : "saved";
  try {
    const response = await callCore("library.setCollection", {
      requestId: crypto.randomUUID(),
      captureId: data.capture.captureId,
      collection,
    });
    notify(t(response.value.collection === "saved"
      ? "已设为仅收藏，不再进入待处理查询与提醒。"
      : "已重新加入待办；不会自动开始处理。"));
    await loadPage(true);
  } catch (error) {
    notify(errorMessage(error, "收藏状态更新失败。"));
  }
}

async function copyTask(data: CaptureDetailResult): Promise<void> {
  try {
    await navigator.clipboard.writeText(taskDescription(data));
    notify(t("任务说明已复制。只有明确交给 Agent 后才会开始处理。"));
  } catch (error) {
    notify(errorMessage(error, "复制失败，请重试。"));
  }
}

async function pendingBatchSnapshot(): Promise<PendingBatchItem[]> {
  const snapshot = state;
  const query = snapshot.search.trim().toLocaleLowerCase(getLocale());
  return collectPendingBatch(
    (cursor) => callCore("capture.list", pendingBatchListParams(snapshot, cursor)),
    (record) => !query
      || `${record.title} ${record.site} ${record.preview}`.toLocaleLowerCase(getLocale()).includes(query),
  );
}

async function copyPendingBatch(): Promise<void> {
  setBusy(copyPendingBatchButton, true);
  try {
    const items = await pendingBatchSnapshot();
    if (items.length === 0) {
      notify(t("当前筛选范围没有可统一处理的待办。"));
      return;
    }
    await navigator.clipboard.writeText(batchTaskDescription(items));
    notify(t("已复制 {count} 条待办的统一处理说明；粘贴给已连接的 Agent 即可一次执行。", {
      count: numberText(items.length),
    }));
  } catch (error) {
    notify(errorMessage(error, "统一处理说明生成失败。"));
  } finally {
    setBusy(copyPendingBatchButton, false);
  }
}

async function reprocessCapture(data: CaptureDetailResult): Promise<void> {
  try {
    const latestJob = data.jobs.at(-1);
    const response = await callCore("job.reprocess", {
      requestId: crypto.randomUUID(),
      captureId: data.capture.captureId,
      ...(latestJob ? { parentJobId: latestJob.jobId } : {}),
    });
    notify(t("已创建新工作项 {jobId}；既有成功和失败历史继续保留。", {
      jobId: response.value.jobId,
    }));
    await loadPage(true);
  } catch (error) {
    notify(errorMessage(error, "重新处理未完成。"));
  }
}

function cleanupSummary(preview: CleanupPreviewResult): string {
  const jobs = preview.candidates.reduce((sum, candidate) => sum + candidate.jobCount, 0);
  const results = preview.candidates.reduce((sum, candidate) => sum + candidate.resultCount, 0);
  const attachments = preview.candidates.reduce((sum, candidate) => sum + candidate.attachmentCount, 0);
  return t("将删除 {captures} 条插件记录、{jobs} 个工作项、{results} 份结果和 {attachments} 个关联附件记录。外部成品文件保留。{skipped}", {
    captures: numberText(preview.candidates.length),
    jobs: numberText(jobs),
    results: numberText(results),
    attachments: numberText(attachments),
    skipped: preview.skipped.length
      ? t("另有 {count} 条因活跃任务、未处理或不存在而跳过。", {
        count: numberText(preview.skipped.length),
      })
      : "",
  });
}

async function previewAndCommitCleanup(params: {
  scope: "capture_ids" | "all_processed";
  captureIds?: readonly string[];
}): Promise<void> {
  try {
    const preview = await callCore("library.cleanupPreview", {
      requestId: crypto.randomUUID(),
      scope: params.scope,
      ...(params.captureIds ? { captureIds: params.captureIds } : {}),
      includeFailed: includeFailedCleanup.checked,
    });
    if (preview.candidates.length === 0) {
      notify(preview.skipped.length
        ? t("没有可清理记录；{count} 条受活跃任务或处理状态保护。", {
          count: numberText(preview.skipped.length),
        })
        : t("没有可清理的已处理记录。"));
      return;
    }
    if (!window.confirm(t("{summary}\n\n确认按本次预览清理？", {
      summary: cleanupSummary(preview),
    }))) return;
    const committed = await callCore("library.cleanupCommit", {
      requestId: crypto.randomUUID(),
      cleanupToken: preview.cleanupToken,
    });
    if (committed.deletedCaptureIds.includes(state.selectedCaptureId)) {
      state = { ...state, selectedCaptureId: "" };
      activeDetail = "empty";
      await writeViewState(state);
      renderEmptyDetail("所选记录已清理。外部成品文件仍然保留。");
    }
    notify(t("已清理 {count} 条插件记录；外部成品文件未删除。", {
      count: numberText(committed.deletedCaptureIds.length),
    }));
    await loadPage(true);
  } catch (error) {
    notify(errorMessage(error, "清理未完成；请重新预览后再试。"));
  }
}

async function cleanupCapture(data: CaptureDetailResult): Promise<void> {
  await previewAndCommitCleanup({ scope: "capture_ids", captureIds: [data.capture.captureId] });
}

async function collectSourceCaptureIds(sourceKey: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await callCore("capture.list", {
      view: "all",
      sourceKey,
      ...(cursor ? { cursor } : {}),
      limit: 200,
    });
    ids.push(...page.records.map((record) => record.captureId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

async function cleanupSource(data: CaptureDetailResult): Promise<void> {
  try {
    const captureIds = await collectSourceCaptureIds(data.capture.sourceKey);
    if (captureIds.length === 0) {
      notify(t("这个来源没有可读取的记录。"));
      return;
    }
    await previewAndCommitCleanup({ scope: "capture_ids", captureIds });
  } catch (error) {
    notify(errorMessage(error, "同来源记录读取失败。"));
  }
}

async function exportBackup(): Promise<void> {
  const button = $("#export") as HTMLButtonElement;
  setBusy(button, true);
  try {
    const bundle = await callCore("backup.export", {
      includeAttachmentData: includeAttachments.checked,
    });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `babel-clipper-backup-${new Date().toISOString().replaceAll(":", "-")}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    notify(bundle.attachmentDataIncluded
      ? t("完整备份已生成，包含 {count} 条附件元数据和内部附件数据。", {
        count: numberText(bundle.attachments.length),
      })
      : t("元数据备份已生成；附件字节未包含。"));
  } catch (error) {
    notify(errorMessage(error, "备份生成失败。"));
  } finally {
    setBusy(button, false);
  }
}

function parseBackup(text: string): BackupBundle {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || (value as { format?: unknown }).format !== "babel-content-clipper-backup") {
    throw new Error(t("所选文件不是 Babel Content Clipper 备份。"));
  }
  return value as BackupBundle;
}

async function importBackup(file: File): Promise<void> {
  try {
    const bundle = parseBackup(await file.text());
    const response = await callCore("backup.import", {
      requestId: crypto.randomUUID(),
      bundle,
    });
    const counts = response.imported;
    notify(t("导入完成：{captures} 条记录、{jobs} 个工作项、{results} 份结果、{attachments} 个附件记录。", {
      captures: numberText(counts.captures),
      jobs: numberText(counts.jobs),
      results: numberText(counts.results),
      attachments: numberText(counts.attachments),
    }));
    await loadPage(true);
  } catch (error) {
    notify(errorMessage(error, "备份导入失败。"));
  } finally {
    importFile.value = "";
  }
}

async function appendConnectionControls(): Promise<void> {
  detail.querySelector(".connection-card")?.remove();
  let connection: UiConnectionStatus;
  try {
    connection = await callCore("connection.status");
  } catch (error) {
    const section = document.createElement("section");
    section.className = "connection-card is-disconnected";
    section.append(
      translatedParagraph("eyebrow", "MCP 连接"),
      bindTranslation(document.createElement("h3"), "无法读取连接状态"),
      translatedParagraph("", "请点击“重新检查连接”。如果仍然失败，请先确认本地服务正在运行，再重新加载扩展。"),
      localizedMessageParagraph("failure-card", errorMessage(error, "连接状态不可用。")),
      makeButton("重新检查连接", () => void appendConnectionControls(), "accent"),
    );
    detail.append(section);
    return;
  }
  const section = document.createElement("section");
  section.className = `connection-card${connection.native.connected ? "" : " is-disconnected"}`;
  section.append(
    translatedParagraph("eyebrow", "MCP 连接"),
    bindTranslation(document.createElement("h3"), "连接本地 Agent"),
  );
  const idLine = document.createElement("div");
  idLine.className = "connection-id";
  const id = document.createElement("code");
  id.textContent = connection.profileId;
  idLine.append(id, makeButton("复制", () => {
    void navigator.clipboard.writeText(connection.profileId).then(
      () => notify(t("当前浏览器标识已复制。")),
      () => notify(t("复制失败，请手动选择。")),
    );
  }));
  const instructions = translatedParagraph(
    "",
    connection.native.connected
      ? "已连接。Agent 可以读取和回写记录；如果 Agent 仍提示无法连接，请让它刷新 MCP 连接。"
      : "如果 Agent 提示无法连接，请先确认它使用了上面的 profileId，然后点击“立即重连本地服务”；看到“本地桥已连接”后，再让 Agent 刷新 MCP。",
  );
  const status = translatedParagraph(
    "connection-state",
    connection.native.connected ? "本地桥已连接" : "本地记录可用 · 本地桥未连接",
  );
  let failure: HTMLElement | undefined;
  const reconnect = makeButton(connection.native.connected ? "重新连接本地服务" : "立即重连本地服务", () => {
    setBusy(reconnect, true);
    void sendRuntime<{ ok: boolean; error?: { message?: string } }>({
      channel: EXTENSION_CHANNEL,
      type: "action",
      action: "connect-native",
    }).then((response) => {
      if (!response.ok) throw new Error(response.error?.message ?? t("本地桥连接失败。"));
      return callCore("connection.status");
    }).then((nextConnection) => {
      if (!nextConnection.native.connected) throw new Error(t("重连后本地桥仍未连接。"));
      section.classList.remove("is-disconnected");
      bindTranslation(instructions, "已连接。Agent 可以读取和回写记录；如果 Agent 仍提示无法连接，请让它刷新 MCP 连接。");
      bindTranslation(status, "本地桥已连接");
      status.classList.remove("is-disconnected");
      status.classList.add("is-connected");
      bindTranslation(reconnect, "重新连接本地服务");
      notify(t("本地桥已连接。"));
    }).catch((error: unknown) => {
      failure?.remove();
      failure = document.createElement("div");
      failure.className = "failure-card";
      failure.append(
        localizedMessageParagraph("", errorMessage(error, "本地桥连接失败。")),
        translatedParagraph("", "没有连上时，请先确认 Agent 的 MCP 配置使用了这里的 profileId，然后点击“重连本地服务”；如果仍失败，请重新加载扩展后再试。"),
      );
      section.append(failure);
      notify(errorMessage(error, "本地桥连接失败。"));
    })
      .finally(() => setBusy(reconnect, false));
  }, connection.native.connected ? "quiet" : "accent");
  status.classList.add(connection.native.connected ? "is-connected" : "is-disconnected");
  section.append(
    instructions,
    translatedParagraph("eyebrow", "浏览器连接标识"),
    idLine,
    status,
    reconnect,
  );
  detail.append(section);
}

function numberField(name: string, label: string, value: number, min = 0): HTMLLabelElement {
  const wrapper = document.createElement("label");
  const labelText = bindTranslation(document.createElement("span"), label);
  const input = document.createElement("input");
  input.type = "number";
  input.name = name;
  input.min = String(min);
  input.step = "1";
  input.required = true;
  input.value = String(value);
  wrapper.append(labelText, input);
  return wrapper;
}

async function renderSettings(): Promise<void> {
  setSettingsView(true);
  activeDetail = "settings";
  currentDetailData = undefined;
  clear(detail);
  const loading = translatedParagraph("muted", "正在读取设置…");
  detail.append(loading);
  try {
    const [settings, diagnostics] = await Promise.all([
      callCore("settings.get"),
      callCore("diagnostics.get"),
    ]);
    if (activeDetail !== "settings") return;
    clear(detail);
    const heading = document.createElement("div");
    heading.className = "detail-heading settings-heading";
    const headingCopy = document.createElement("div");
    headingCopy.append(translatedParagraph("eyebrow", "设置"));
    const title = document.createElement("h2");
    bindTranslation(title, "采集、预算与连接");
    headingCopy.append(title, translatedParagraph("muted", "修改只影响新记录；历史记录保留原参数快照。达到录制或附件预算时会停止新增数据并保留已保存部分，不会自动清理历史。"));
    const back = makeButton("返回素材库", () => {
      history.replaceState(null, "", location.pathname);
      if (state.selectedCaptureId) {
        activeDetail = "capture";
        void loadDetail(state.selectedCaptureId, loadGeneration);
      } else renderEmptyDetail();
      void refreshConnectionBanner();
    }, "quiet");
    heading.append(headingCopy, back);
    detail.append(heading);

    const form = document.createElement("form");
    form.className = "settings-form";
    form.append(
      numberField("paddingBeforeSeconds", "前置预留（秒）", settings.paddingBeforeSeconds),
      numberField("paddingAfterSeconds", "后置预留（秒）", settings.paddingAfterSeconds),
    );

    const reminder = document.createElement("label");
    reminder.append(bindTranslation(document.createElement("span"), "待处理提醒（分钟，留空即关闭）"));
    const reminderInput = document.createElement("input");
    reminderInput.type = "number";
    reminderInput.name = "reminderMinutes";
    reminderInput.min = "1";
    reminderInput.step = "1";
    reminderInput.max = "10080";
    bindTranslatedAttribute(reminderInput, "placeholder", "关闭");
    reminderInput.value = settings.reminderMinutes === null ? "" : String(settings.reminderMinutes);
    reminder.append(reminderInput);
    form.append(reminder);

    const policy = document.createElement("label");
    policy.append(bindTranslation(document.createElement("span"), "默认成品范围"));
    const policySelect = document.createElement("select");
    policySelect.name = "defaultOutputRangePolicy";
    for (const [value, label] of [["padded", "保留前后预留"], ["original", "仅原始选择范围"]] as const) {
      const option = document.createElement("option");
      option.value = value;
      bindTranslation(option, label);
      option.selected = settings.defaultOutputRangePolicy === value;
      policySelect.append(option);
    }
    policy.append(policySelect);
    form.append(policy);

    form.append(
      numberField("maxRecordingSeconds", "单次现场录制最长（秒）", settings.maxRecordingSeconds, 1),
      numberField("maxRecordingBytes", "单次现场录制上限（MiB）", settings.maxRecordingBytes / MEBIBYTE, 1),
      numberField("maxAttachmentBytes", "当前浏览器附件总预算（MiB）", settings.maxAttachmentBytes / MEBIBYTE, 1),
    );

    const output = document.createElement("label");
    output.className = "settings-wide";
    output.append(bindTranslation(document.createElement("span"), "全局默认成品目录（可选）"));
    const outputInput = document.createElement("input");
    outputInput.name = "globalOutputDirectory";
    bindTranslatedAttribute(outputInput, "placeholder", "任务或 MCP 连接提供目录时可留空");
    outputInput.value = settings.globalOutputDirectory ?? "";
    output.append(outputInput);
    form.append(output);

    settingsBudgetBytes = {
      used: diagnostics.counts.internalAttachmentBytes,
      maximum: diagnostics.budgets.maxAttachmentBytes,
    };
    const budget = translatedParagraph(
      "settings-note",
      "附件已用 {used} / {maximum}。全库预算不足时不会静默删除历史。",
      {
        used: formatBytesLocalized(settingsBudgetBytes.used),
        maximum: formatBytesLocalized(settingsBudgetBytes.maximum),
      },
    );
    budget.id = "settings-budget";
    form.append(budget);
    const save = document.createElement("button");
    save.type = "submit";
    save.dataset.tone = "accent";
    bindTranslation(save, "保存设置");
    form.append(save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const recordingMiB = Number(data.get("maxRecordingBytes"));
      const attachmentMiB = Number(data.get("maxAttachmentBytes"));
      if (recordingMiB > attachmentMiB) {
        notify(t("单次录制上限不能超过当前浏览器的附件总预算。"));
        return;
      }
      const reminderValue = String(data.get("reminderMinutes") ?? "").trim();
      setBusy(save, true);
      void callCore("settings.update", {
        requestId: crypto.randomUUID(),
        patch: {
          paddingBeforeSeconds: Number(data.get("paddingBeforeSeconds")),
          paddingAfterSeconds: Number(data.get("paddingAfterSeconds")),
          reminderMinutes: reminderValue ? Number(reminderValue) : null,
          defaultOutputRangePolicy: String(data.get("defaultOutputRangePolicy")),
          maxRecordingSeconds: Number(data.get("maxRecordingSeconds")),
          maxRecordingBytes: Math.round(recordingMiB * MEBIBYTE),
          maxAttachmentBytes: Math.round(attachmentMiB * MEBIBYTE),
          globalOutputDirectory: String(data.get("globalOutputDirectory") ?? "").trim() || null,
        },
      }).then((response) => {
        notify(t("设置已保存（版本 {revision}）。", { revision: response.ack.revision }));
        return renderSettings();
      }).catch((error: unknown) => notify(errorMessage(error, "设置保存失败。")))
        .finally(() => setBusy(save, false));
    });
    detail.append(form);
    await appendConnectionControls();
  } catch (error) {
    clear(detail);
    const wrapper = document.createElement("div");
    wrapper.className = "error-state";
    const heading = document.createElement("strong");
    bindTranslation(heading, "设置暂时不可用");
    wrapper.append(heading, localizedMessageParagraph("", errorMessage(error, "设置读取失败。")));
    wrapper.append(makeButton("重试", () => void renderSettings()));
    detail.append(wrapper);
  }
}

function updateSettingsBudgetTranslation(): void {
  const budget = document.querySelector<HTMLElement>("#settings-budget");
  if (!budget || !settingsBudgetBytes) return;
  bindTranslation(
    budget,
    "附件已用 {used} / {maximum}。全库预算不足时不会静默删除历史。",
    {
      used: formatBytesLocalized(settingsBudgetBytes.used),
      maximum: formatBytesLocalized(settingsBudgetBytes.maximum),
    },
  );
}

function handleLocaleChange(): void {
  translateDocument();
  updateSourceOptions();
  renderList();
  updateSettingsBudgetTranslation();
  if (toast.textContent) toast.textContent = localizeMessage(toast.textContent);
  for (const message of document.querySelectorAll<HTMLElement>("[data-localize-message]")) {
    if (message.textContent) message.textContent = localizeMessage(message.textContent);
  }
  if (
    activeDetail === "capture"
    && currentDetailData?.capture.captureId === state.selectedCaptureId
  ) {
    renderCaptureDetail(currentDetailData);
  }
  void refreshConnectionBanner();
}

function applyStateToControls(): void {
  searchInput.value = state.search;
  dateFilter.value = state.date;
  sourceFilter.value = state.sourceKey;
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.view === state.view);
  }
}

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    const view = tab.dataset.view;
    if (!view || !["all", "pending", "history", "saved"].includes(view)) return;
    state = { ...state, view: view as LibraryViewState["view"] };
    applyStateToControls();
    void persistState(true);
  });
}

searchInput.addEventListener("input", () => {
  state = { ...state, search: searchInput.value };
  void writeViewState(state);
  if (searchTimer !== undefined) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void loadPage(true), 180);
});

sourceFilter.addEventListener("change", () => {
  state = { ...state, sourceKey: sourceFilter.value };
  void persistState(true);
});

dateFilter.addEventListener("change", () => {
  const date = dateFilter.value === "today" || dateFilter.value === "week" ? dateFilter.value : "";
  state = { ...state, date };
  void persistState(true);
});

$("#clear-filters").addEventListener("click", () => {
  state = { ...state, search: "", sourceKey: "", date: "" };
  applyStateToControls();
  void persistState(true);
});
copyPendingBatchButton.addEventListener("click", () => void copyPendingBatch());
$("#export").addEventListener("click", () => void exportBackup());
$("#import").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const file = importFile.files?.[0];
  if (file) void importBackup(file);
});
$("#settings").addEventListener("click", () => {
  openSettingsView();
});
$("#help").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("help.html") }, () => {
    const error = chrome.runtime.lastError;
    if (error) notify(localizeMessage(error.message || t("使用帮助暂时无法打开。")));
  });
});
$("#cleanup-all").addEventListener("click", () => void previewAndCommitCleanup({ scope: "all_processed" }));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[VIEW_STATE_KEY]) {
    const incoming = parseViewState(changes[VIEW_STATE_KEY].newValue);
    if (JSON.stringify(incoming) !== JSON.stringify(state)) {
      const selectionWasCleared = Boolean(state.selectedCaptureId) && !incoming.selectedCaptureId;
      state = incoming;
      applyStateToControls();
      if (selectionWasCleared && activeDetail !== "settings") {
        renderEmptyDetail("所选记录已清理或不再可用。请选择其他记录。");
      }
      void loadPage(true);
    }
    return;
  }
  if (changes[LIBRARY_REVISION_KEY]) void loadPage(true);
});

void (async () => {
  await initializeI18n();
  translateDocument();
  installLanguageControl($("#language-control") as HTMLElement);
  installClipboardImport(document.querySelector<HTMLElement>(".header-actions")!, {
    notify: (message: string) => notify(localizeMessage(message)),
  });
  onLocaleChange(handleLocaleChange);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  state = await readViewState();
  const hashCapture = hash.get("capture");
  if (hashCapture) state = { ...state, selectedCaptureId: hashCapture };
  applyStateToControls();
  updateSourceOptions();
  if (location.hash === "#settings") void renderSettings();
  else if (!state.selectedCaptureId) renderEmptyDetail();
  await loadPage(true);
  await refreshConnectionBanner();
})();
