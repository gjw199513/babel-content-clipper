import type { CaptureListItem } from "../../../packages/core/src/types.js";

import { EXTENSION_CHANNEL } from "./messages.js";
import { REMINDER_NOTICE_KEY, type ReminderNotice } from "./reminders.js";
import { ACTION_NOTICE_KEY, parseActionNotice, type ActionNotice } from "./action-notice.js";
import { installClipboardImport } from "./clipboard-import.js";
import { describeMediaToggleResult } from "./media-action.js";
import { describeCaptureSaveResult } from "./capture-feedback.js";
import {
  getLocale,
  initializeI18n,
  installLanguageControl,
  localizeMessage,
  onLocaleChange,
  t,
  translateDocument,
} from "./i18n.js";
import {
  LIBRARY_REVISION_KEY,
  VIEW_STATE_KEY,
  callCore,
  createdFromFor,
  kindLabel,
  readViewState,
  sendRuntime,
  statusCode,
  statusLabel,
  writeViewState,
  type LibraryViewState,
  type UiConnectionStatus,
} from "./ui-shared.js";

const MAX_VISIBLE = 5;
const DEFAULT_STATUS = "选择页面内容后即可保存到素材夹。";

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

const list = $("#capture-list") as HTMLElement;
const status = $("#capture-status") as HTMLElement;
const origin = $("#page-origin") as HTMLElement;
const recordLive = $("#record-live") as HTMLInputElement;
const connectionStatus = $("#connection-status") as HTMLElement;
const connectionNotice = $("#connection-notice") as HTMLElement;
const viewLabel = $("#view-label") as HTMLElement;
const reminder = $("#reminder-notice") as HTMLElement;
const reminderMessage = $("#reminder-message") as HTMLElement;
let refreshGeneration = 0;
let visibleReminder: ReminderNotice | undefined;
let visibleActionNotice: ActionNotice | undefined;
let visibleStatus: { readonly message: string; readonly tone?: string } = { message: DEFAULT_STATUS };

function clear(node: Element): void {
  node.replaceChildren();
}

function paragraph(className: string, text: string): HTMLParagraphElement {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? localizeMessage(error.message) : t(fallback);
}

function setStatus(message: string, tone?: string): void {
  visibleStatus = { message, tone };
  if (tone) status.dataset.state = tone;
  else delete status.dataset.state;
  status.textContent = localizeMessage(message);
}

function renderStatus(): void {
  if (visibleStatus.tone) status.dataset.state = visibleStatus.tone;
  else delete status.dataset.state;
  status.textContent = localizeMessage(visibleStatus.message);
}

function makeButton(label: string, listener: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = t(label);
  button.addEventListener("click", listener);
  return button;
}

function openConnectionSettings(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL("library.html#settings") });
}

function renderConnectionNotice(connection: UiConnectionStatus | undefined, error?: unknown): void {
  clear(connectionNotice);
  const disconnected = !connection?.native.connected;
  connectionNotice.hidden = !disconnected;
  if (!disconnected) return;

  const heading = document.createElement("strong");
  heading.textContent = t("Agent 暂时无法读取或回写记录");
  const message = paragraph(
    "",
    error
      ? t("无法检查连接状态；请点击“打开连接设置”，在连接设置页点击“重连本地服务”，看到“本地桥已连接”后，再让 Agent 刷新 MCP。")
      : t("请按这个顺序操作：先点击“打开连接设置”，进入页面后点击“重连本地服务”；看到“本地桥已连接”后，再让 Agent 刷新 MCP。"),
  );
  const actions = document.createElement("div");
  actions.className = "connection-notice-actions";
  let reconnectButton: HTMLButtonElement;
  reconnectButton = makeButton("立即重连本地服务", () => void reconnectLocalService(reconnectButton));
  reconnectButton.dataset.tone = "accent";
  actions.append(reconnectButton, makeButton("打开连接设置", openConnectionSettings));
  connectionNotice.className = "connection-notice";
  connectionNotice.append(
    paragraph("eyebrow", "MCP 连接未完成"),
    heading,
    message,
    ...(error ? [paragraph("failure-card", errorMessage(error, "连接状态不可用。"))] : []),
    actions,
  );
}

async function reconnectLocalService(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const response = await sendRuntime<{ ok: boolean; error?: { message?: string } }>({
      channel: EXTENSION_CHANNEL,
      type: "action",
      action: "connect-native",
    });
    if (!response.ok) throw new Error(response.error?.message ?? t("本地桥连接失败。"));
    const connection = await callCore("connection.status");
    if (!connection.native.connected) throw new Error(t("重连后本地桥仍未连接。"));
    connectionStatus.textContent = t("本地桥已连接");
    renderConnectionNotice(connection);
    setStatus("本地桥已连接。", "success");
  } catch (error) {
    connectionStatus.textContent = t("本地状态不可用");
    renderConnectionNotice(undefined, error);
    setStatus(errorMessage(error, "本地桥连接失败。"), "error");
  } finally {
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
  }
}

function listParams(state: LibraryViewState, cursor?: string): Record<string, unknown> {
  const createdFrom = createdFromFor(state.date);
  return {
    view: state.view === "saved" ? "all" : state.view,
    ...(state.view === "saved" ? { collection: "saved" } : {}),
    ...(state.sourceKey ? { sourceKey: state.sourceKey } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 50,
  };
}

function matchesSearch(record: CaptureListItem, query: string): boolean {
  if (!query) return true;
  return `${record.title} ${record.site} ${record.preview}`.toLocaleLowerCase(getLocale()).includes(query);
}

function viewDescription(state: LibraryViewState): string {
  const labels: Record<LibraryViewState["view"], string> = {
    all: t("全部"),
    pending: t("待处理"),
    history: t("历史"),
    saved: t("仅收藏"),
  };
  const filters = [labels[state.view]];
  if (state.search.trim()) filters.push(t("搜索中"));
  if (state.sourceKey) filters.push(t("指定来源"));
  if (state.date === "today") filters.push(t("今天"));
  if (state.date === "week") filters.push(t("最近 7 天"));
  return filters.join(" · ");
}

async function openRecord(captureId: string): Promise<void> {
  const current = await readViewState();
  await writeViewState({ ...current, selectedCaptureId: captureId });
  await sendRuntime({ channel: EXTENSION_CHANNEL, type: "open_library" });
}

function renderRows(rows: readonly CaptureListItem[], hasMore: boolean): void {
  clear(list);
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    const mark = document.createElement("span");
    mark.className = "empty-mark";
    mark.textContent = "⌁";
    const openLibrary = makeButton("打开素材库", () => {
      void sendRuntime({ channel: EXTENSION_CHANNEL, type: "open_library" });
    });
    openLibrary.dataset.tone = "quiet";
    empty.append(mark, paragraph("", t("当前视图没有记录")), openLibrary);
    list.append(empty);
    return;
  }
  for (const row of rows.slice(0, MAX_VISIBLE)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "capture-row";
    const badge = document.createElement("span");
    badge.className = "type-badge";
    badge.textContent = t(kindLabel(row.kind));
    const body = document.createElement("span");
    body.className = "row-body";
    const title = document.createElement("strong");
    title.textContent = row.preview || row.title || t("未命名记录");
    const code = statusCode(row);
    const meta = document.createElement("span");
    const saved = row.collection === "saved" ? `${t("仅收藏")} · ` : "";
    meta.textContent = `${row.site || t("来源未知")} · ${saved}${t(statusLabel(code))}`;
    body.append(title, meta);
    const state = document.createElement("span");
    state.className = `mini-status status-${code}`;
    state.textContent = t(statusLabel(code));
    button.append(badge, body, state);
    button.addEventListener("click", () => void openRecord(row.captureId));
    list.append(button);
  }
  const footer = paragraph(
    "list-progress",
    hasMore || rows.length > MAX_VISIBLE
      ? t("显示前 {count} 条；展开管理可继续逐页加载。", { count: Math.min(rows.length, MAX_VISIBLE) })
      : t("当前筛选共 {count} 条，已全部显示。", { count: rows.length }),
  );
  list.append(footer);
}

function renderListError(message: string): void {
  clear(list);
  const wrapper = document.createElement("div");
  wrapper.className = "error-state";
  const heading = document.createElement("strong");
  heading.textContent = t("记录暂时不可用");
  wrapper.append(heading, paragraph("", message), makeButton("重试", () => void refresh()));
  list.append(wrapper);
}

async function refresh(): Promise<void> {
  const generation = ++refreshGeneration;
  let viewState: LibraryViewState | undefined;
  try {
    viewState = await readViewState();
    if (generation !== refreshGeneration) return;
    viewLabel.textContent = viewDescription(viewState);
    const query = viewState.search.trim().toLocaleLowerCase(getLocale());
    const matches: CaptureListItem[] = [];
    let cursor: string | undefined;
    let hasMore = false;
    do {
      const page = await callCore("capture.list", listParams(viewState, cursor));
      if (generation !== refreshGeneration) return;
      for (const record of page.records) {
        if (matchesSearch(record, query)) matches.push(record);
      }
      cursor = page.nextCursor ?? undefined;
      hasMore = Boolean(cursor);
      // With text filtering, walk pages until enough matching rows exist. This
      // prevents the side panel from treating the first page as the whole set.
    } while (cursor && query && matches.length <= MAX_VISIBLE);
    renderRows(matches, hasMore);

  } catch (error) {
    if (generation !== refreshGeneration) return;
    renderListError(errorMessage(error, "数据库或后台服务未响应。"));
  }
  if (generation !== refreshGeneration || !viewState) return;
  try {
    const connection = await callCore("connection.status");
    if (generation !== refreshGeneration) return;
    connectionStatus.textContent = connection.native.connected
      ? t("本地桥已连接")
      : t("本地记录可用 · 本地桥未连接");
    renderConnectionNotice(connection);
  } catch (error) {
    if (generation !== refreshGeneration) return;
    connectionStatus.textContent = t("本地状态不可用");
    renderConnectionNotice(undefined, error);
  }
}

function parseReminderNotice(value: unknown): ReminderNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const notice = value as Partial<ReminderNotice>;
  return typeof notice.id === "string" && typeof notice.createdAt === "string" && typeof notice.message === "string"
    ? notice as ReminderNotice
    : undefined;
}

function renderReminder(): void {
  reminder.hidden = !visibleReminder;
  reminderMessage.textContent = visibleReminder ? localizeMessage(visibleReminder.message) : "";
}

function showReminder(value: unknown): void {
  visibleReminder = parseReminderNotice(value);
  renderReminder();
}

async function refreshReminder(): Promise<void> {
  const stored = await chrome.storage.local.get(REMINDER_NOTICE_KEY);
  showReminder(stored[REMINDER_NOTICE_KEY]);
}

function showActionNotice(value: unknown): void {
  visibleActionNotice = parseActionNotice(value);
  if (!visibleActionNotice) {
    setStatus(DEFAULT_STATUS);
    return;
  }
  if (Date.now() - Date.parse(visibleActionNotice.createdAt) > 10 * 60_000) return;
  setStatus(visibleActionNotice.message, visibleActionNotice.tone);
}

async function refreshActionNotice(): Promise<void> {
  const stored = await chrome.storage.local.get(ACTION_NOTICE_KEY);
  showActionNotice(stored[ACTION_NOTICE_KEY]);
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
}

async function showOrigin(): Promise<void> {
  const tab = await activeTab();
  if (!tab?.url) {
    origin.textContent = t("当前页面");
    return;
  }
  try {
    const parsed = new URL(tab.url);
    origin.textContent = parsed.hostname || parsed.protocol.replace(":", "") || t("当前页面");
  } catch {
    origin.textContent = t("当前页面");
  }
}

async function runAction(
  action: "capture-selection" | "toggle-media-capture" | "capture-region",
): Promise<void> {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".capture-actions button")];
  for (const button of buttons) button.disabled = true;
  setStatus(action === "toggle-media-capture" ? "正在读取媒体状态…" : "正在保存用户选择…", "loading");
  try {
    const requestedRecordLive = action === "toggle-media-capture" && recordLive.checked;
    const response = await sendRuntime<{ ok: boolean; result?: unknown; error?: { message?: string } }>({
      channel: EXTENSION_CHANNEL,
      type: "action",
      action,
      recordLive: requestedRecordLive,
    });
    if (!response.ok) throw new Error(response.error?.message ?? t("采集失败。"));
    if (action === "toggle-media-capture") {
      const feedback = describeMediaToggleResult(response.result, requestedRecordLive);
      if (feedback.consumeRecordLive) recordLive.checked = false;
      setStatus(feedback.message, feedback.tone);
    } else {
      const feedback = describeCaptureSaveResult(
        response.result,
        action === "capture-region" ? "框选截图已保存。" : "选中内容已保存。",
      );
      setStatus(feedback.message, feedback.tone);
    }
    await refresh();
  } catch (error) {
    setStatus(errorMessage(error, "采集失败；请重试。"), "error");
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function installPanel(): void {
  installLanguageControl($("#language-control") as HTMLElement);
  $("#capture-selection").addEventListener("click", () => void runAction("capture-selection"));
  $("#capture-media").addEventListener("click", () => void runAction("toggle-media-capture"));
  $("#capture-region").addEventListener("click", () => void runAction("capture-region"));
  $("#refresh").addEventListener("click", () => void refresh());
  $("#open-library").addEventListener("click", () => {
    void sendRuntime({ channel: EXTENSION_CHANNEL, type: "open_library" });
  });
  $("#help").addEventListener("click", () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("help.html") });
  });
  $("#settings").addEventListener("click", () => {
    openConnectionSettings();
  });
  $("#dismiss-reminder").addEventListener("click", () => {
    void chrome.storage.local.remove(REMINDER_NOTICE_KEY).then(() => showReminder(undefined));
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[REMINDER_NOTICE_KEY]) showReminder(changes[REMINDER_NOTICE_KEY].newValue);
    if (changes[ACTION_NOTICE_KEY]) showActionNotice(changes[ACTION_NOTICE_KEY].newValue);
    if (changes[LIBRARY_REVISION_KEY] || changes[VIEW_STATE_KEY]) void refresh();
  });

  chrome.tabs.onActivated.addListener(() => { void showOrigin(); });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.url !== undefined || changeInfo.status === "complete")) void showOrigin();
  });
  chrome.windows.onFocusChanged.addListener(() => { void showOrigin(); });

  installClipboardImport(document.querySelector<HTMLElement>(".capture-actions")!, {
    notify: message => {
      setStatus(message, "success");
      void refresh();
    },
  });

  onLocaleChange(() => {
    // Static labels are refreshed by i18n before this callback. These values
    // are generated from records or notices, so render them without resetting
    // the live-recording checkbox or a dialog's typed values.
    renderStatus();
    renderReminder();
    void showOrigin();
    void refresh();
  });

  void Promise.all([showOrigin(), refresh(), refreshReminder(), refreshActionNotice()]);
}

void (async () => {
  await initializeI18n();
  translateDocument(document);
  installPanel();
})();
