import type { CaptureCreateInput, CaptureCreateResult, SerializableClipperError } from "../../../packages/core/src/types.js";

import { EXTENSION_CHANNEL } from "./messages.js";
import { localizeMessage, onLocaleChange, t, translateDocument } from "./i18n.js";
import { redactUrl } from "./security.js";
import { readViewState, sendRuntime, UiCoreError, writeViewState } from "./ui-shared.js";

interface ImportResponse {
  readonly ok: boolean;
  readonly result?: CaptureCreateResult;
  readonly error?: SerializableClipperError;
}

interface ImportOptions {
  readonly notify?: (message: string) => void;
}

// These keys become capture metadata only after we resolve them once when the
// dialog opens. That gives a new untitled import the current UI language while
// keeping retries and saved records stable across later language switches.
const DEFAULT_IMPORT_TITLE = "粘贴导入";
const UNKNOWN_SOURCE = "来源未知";

function translatedText<T extends HTMLElement>(node: T, source: string): T {
  node.dataset.i18n = source;
  node.textContent = t(source);
  return node;
}

function translatedAttribute<T extends HTMLElement>(
  node: T,
  attribute: "placeholder" | "title" | "aria-label",
  source: string,
): T {
  node.setAttribute(`data-i18n-${attribute}`, source);
  node.setAttribute(attribute, t(source));
  return node;
}

function labelFor(source: string, control: HTMLInputElement | HTMLTextAreaElement): HTMLLabelElement {
  const label = document.createElement("label");
  const caption = translatedText(document.createElement("span"), source);
  label.append(caption, control);
  return label;
}

/** Explicit paste entry: opening it never reads or watches the clipboard. */
export function installClipboardImport(container: HTMLElement, options: ImportOptions = {}): void {
  if (container.querySelector("[data-clipboard-import]")) return;
  const trigger = translatedText(document.createElement("button"), "粘贴导入");
  trigger.type = "button";
  trigger.dataset.clipboardImport = "true";
  container.append(trigger);
  if (!document.querySelector('link[data-clipboard-import-style]')) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("clipboard-import.css");
    stylesheet.dataset.clipboardImportStyle = "true";
    document.head.append(stylesheet);
  }
  onLocaleChange(() => translateDocument(trigger));
  trigger.addEventListener("click", () => openImport(options));
}

function openImport(options: ImportOptions): void {
  if (document.querySelector(".paste-dialog")) return;
  const defaultImportTitle = t(DEFAULT_IMPORT_TITLE);
  const unknownSource = t(UNKNOWN_SOURCE);
  const dialog = document.createElement("dialog");
  dialog.className = "paste-dialog";
  dialog.setAttribute("aria-labelledby", "paste-heading");

  const form = document.createElement("form");
  form.className = "paste-form";
  // Validation below uses catalog-backed messages instead of an unlocalized
  // browser constraint-validation bubble.
  form.noValidate = true;
  const heading = translatedText(document.createElement("h2"), "粘贴导入");
  heading.id = "paste-heading";
  const help = translatedText(document.createElement("p"), "把需要保存的文字粘贴到下方。来源可以留空，留空时标记为未知。");
  help.className = "paste-help";

  const content = document.createElement("textarea");
  content.name = "text";
  content.required = true;
  content.spellcheck = false;
  translatedAttribute(content, "placeholder", "在这里粘贴原文");

  const title = document.createElement("input");
  title.name = "title";
  title.maxLength = 4_096;
  translatedAttribute(title, "placeholder", "为这条记录取一个名字");

  const source = document.createElement("input");
  source.name = "source";
  source.type = "url";
  source.maxLength = 8_192;
  source.placeholder = "https://…";
  source.autocomplete = "off";

  const errorText = document.createElement("p");
  errorText.className = "paste-error";
  errorText.setAttribute("role", "alert");
  errorText.hidden = true;

  const actions = document.createElement("div");
  actions.className = "paste-actions";
  const cancel = translatedText(document.createElement("button"), "取消");
  cancel.type = "button";
  cancel.dataset.cancel = "true";
  const save = translatedText(document.createElement("button"), "保存到素材库");
  save.type = "submit";
  save.dataset.tone = "accent";
  actions.append(cancel, save);
  form.append(
    heading,
    help,
    labelFor("文字内容", content),
    labelFor("标题（可选）", title),
    labelFor("来源网址（可选）", source),
    errorText,
    actions,
  );
  dialog.append(form);

  let busy = false;
  let attempt: { serialized: string; requestId: string } | undefined;
  let displayedError: string | undefined;

  const showError = (message: string): void => {
    displayedError = message;
    errorText.textContent = localizeMessage(message);
    errorText.hidden = false;
  };
  const hideError = (): void => {
    displayedError = undefined;
    errorText.hidden = true;
  };
  const removeLocaleListener = onLocaleChange(() => {
    translateDocument(dialog);
    if (displayedError !== undefined) errorText.textContent = localizeMessage(displayedError);
  });

  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    removeLocaleListener();
    dialog.remove();
  }, { once: true });
  cancel.addEventListener("click", () => { if (!busy) dialog.close(); });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (busy) return;
    void (async () => {
      busy = true;
      save.disabled = cancel.disabled = true;
      save.setAttribute("aria-busy", "true");
      hideError();
      try {
        if (!content.value.trim()) throw new Error(t("请先粘贴需要保存的文字。"));
        if (content.value.length > 10_000_000) {
          throw new Error(t("文字超过单条记录上限，请分成多条保存；内容尚未保存。"));
        }
        const sourceValue = source.value.trim();
        let parsed: URL | undefined;
        if (sourceValue) {
          try {
            parsed = new URL(sourceValue);
          } catch {
            throw new Error(t("请填写完整的 http 或 https 网址，或留空。"));
          }
          if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
            throw new Error(t("来源仅支持不含账号密码的 http 或 https 网址。"));
          }
        }
        const input: CaptureCreateInput = {
          kind: "clipboard_import",
          state: "sealed",
          source: {
            title: title.value.trim() || defaultImportTitle,
            pageUrl: parsed ? redactUrl(parsed.href) : "clipboard:unknown",
            site: parsed?.hostname || unknownSource,
            identityConfidence: parsed ? "best_effort" : "unknown",
            metadata: { sourceProvidedBy: parsed ? "user" : "unknown" },
          },
          selection: { type: "clipboard", text: content.value, sourceKnown: parsed !== undefined },
          captureMethod: "explicit-paste",
          assetsState: "saved",
          integrity: { status: "complete_selection", missing: [] },
        };
        const serialized = JSON.stringify(input);
        if (!attempt || attempt.serialized !== serialized) attempt = { serialized, requestId: crypto.randomUUID() };
        const response = await sendRuntime<ImportResponse>({
          channel: EXTENSION_CHANNEL,
          type: "core",
          method: "capture.create",
          params: { requestId: attempt.requestId, input },
        });
        if (!response?.ok || !response.result) throw new UiCoreError(response?.error);
        if (response.result.ack.persisted !== true) throw new Error(t("尚未取得保存确认，请重试。"));
        const captureId = response.result.value.capture.captureId;
        let message = t("粘贴内容已保存。");
        try {
          const view = await readViewState();
          await writeViewState({ ...view, view: "all", search: "", sourceKey: "", date: "", selectedCaptureId: captureId });
        } catch {
          message = t("粘贴内容已保存，可刷新素材库查看。");
        }
        dialog.close();
        options.notify?.(message);
      } catch (error) {
        showError(error instanceof Error ? error.message : t("保存失败，请重试。"));
      } finally {
        busy = false;
        save.disabled = cancel.disabled = false;
        save.removeAttribute("aria-busy");
      }
    })();
  });
  document.body.append(dialog);
  translateDocument(dialog);
  dialog.showModal();
  content.focus();
}
