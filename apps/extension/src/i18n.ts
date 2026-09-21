import { libraryMessages } from "./locales/library.js";
import { panelMessages } from "./locales/panel.js";
import { systemMessages } from "./locales/system.js";

export const SUPPORTED_LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];
export type LocalePreference = Locale | "auto";
export type MessageValues = Readonly<Record<string, string | number>>;
export type Translations = Readonly<Record<Exclude<Locale, "zh-CN">, string>>;
export const LOCALE_KEY = "babel_content_clipper.locale.v1";
export const messages: Readonly<Record<string, Translations>> = { ...libraryMessages, ...panelMessages, ...systemMessages };

// Pure helpers keep their existing source-language behavior until a browser
// entry point initializes its preference. No browser APIs run during import.
let locale: Locale = "zh-CN";
let preference: LocalePreference = "auto";
let initialization: Promise<void> | undefined;
const listeners = new Set<() => void>();

export function resolveLocale(language: string): Locale {
  const normalized = language.replaceAll("_", "-").toLowerCase();
  if (/^zh(?:-|$)/u.test(normalized)) {
    if (/(?:^|-)hans(?:-|$)/u.test(normalized)) return "zh-CN";
    return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/u.test(normalized) ? "zh-TW" : "zh-CN";
  }
  if (/^ja(?:-|$)/u.test(normalized)) return "ja";
  if (/^ko(?:-|$)/u.test(normalized)) return "ko";
  return "en";
}

export function parseLocalePreference(value: unknown): LocalePreference {
  return typeof value === "string" && SUPPORTED_LOCALES.some(item => item === value) ? value as Locale : "auto";
}

function browserLocale(): Locale {
  const language = globalThis.chrome?.i18n?.getUILanguage?.()
    || globalThis.navigator?.language || "en";
  return resolveLocale(language);
}

export function getLocale(): Locale { return locale; }
export function getLocalePreference(): LocalePreference { return preference; }

export function translate(source: string, target: Locale, values: MessageValues = {}): string {
  const template = target === "zh-CN" ? source : messages[source]?.[target] ?? source;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}

export function t(source: string, values?: MessageValues): string { return translate(source, locale, values); }

// Only call this for application-owned notices/diagnostics, never scraped
// text or user input. Old notices remain immutable in storage across switches.
const exactMessages = new Map<string, string>();
const patterns: Array<{ source: string; pattern: RegExp; names: string[] }> = [];
for (const [source, translations] of Object.entries(messages)) {
  for (const text of [source, ...Object.values(translations)]) {
    if (!text.includes("{")) { exactMessages.set(text, source); continue; }
    const names: string[] = [];
    let previous = 0;
    let pattern = "^";
    for (const match of text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu)) {
      pattern += escapePattern(text.slice(previous, match.index)) + "([\\s\\S]*?)";
      names.push(match[1]!);
      previous = match.index + match[0].length;
    }
    if (names.length && text.replace(/\{[a-zA-Z][a-zA-Z0-9_]*\}/gu, "").trim()) {
      patterns.push({ source, names, pattern: new RegExp(pattern + escapePattern(text.slice(previous)) + "$", "u") });
    }
  }
}
function escapePattern(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

export function localizeMessage(message: string): string {
  return localizeKnownMessage(message, 0);
}

function localizeKnownMessage(message: string, depth: number): string {
  if (depth > 4) return message;
  const source = exactMessages.get(message);
  if (source) return t(source);
  for (const entry of patterns) {
    const match = entry.pattern.exec(message);
    if (match) return t(entry.source, Object.fromEntries(entry.names.map((name, index) => [name, localizeKnownMessage(match[index + 1] ?? "", depth + 1)])));
  }
  const diagnostic = /^([A-Z][A-Z_0-9]+):\s*([\s\S]+)$/u.exec(message);
  if (diagnostic) return `${diagnostic[1]}: ${localizeKnownMessage(diagnostic[2]!, depth + 1)}`;
  return message;
}

function applyPreference(value: unknown): void {
  const nextPreference = parseLocalePreference(value);
  const nextLocale = nextPreference === "auto" ? browserLocale() : nextPreference;
  const changed = nextLocale !== locale || nextPreference !== preference;
  preference = nextPreference;
  locale = nextLocale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    translateDocument();
  }
  if (changed) for (const listener of listeners) listener();
}

export function initializeI18n(): Promise<void> {
  initialization ??= (async () => {
    // Subscribe before reading so a change in another window cannot be lost.
    let changedWhileReading = false;
    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !Object.prototype.hasOwnProperty.call(changes, LOCALE_KEY)) return;
      changedWhileReading = true;
      applyPreference(changes[LOCALE_KEY]?.newValue);
    });
    const stored = await globalThis.chrome?.storage?.local?.get(LOCALE_KEY);
    if (!changedWhileReading) applyPreference(stored?.[LOCALE_KEY]);
  })();
  return initialization;
}

export async function setLocalePreference(value: LocalePreference): Promise<void> {
  const next = parseLocalePreference(value);
  // Do not claim persistence or repaint successfully when storage rejects.
  await chrome.storage.local.set({ [LOCALE_KEY]: next });
  applyPreference(next);
}

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function translateDocument(root: ParentNode = document): void {
  const selector = "[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]";
  const nodes = [...root.querySelectorAll<HTMLElement>(selector)];
  if (root instanceof Element && root.matches(selector)) nodes.unshift(root as HTMLElement);
  for (const element of nodes) {
    let values: MessageValues = {};
    if (element.dataset.i18nValues) {
      try {
        const parsed: unknown = JSON.parse(element.dataset.i18nValues);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values = parsed as MessageValues;
      } catch { /* use visible placeholders */ }
    }
    if (element.dataset.i18n !== undefined) element.textContent = t(element.dataset.i18n, values);
    for (const attribute of ["title", "placeholder", "aria-label"]) {
      const key = element.getAttribute(`data-i18n-${attribute}`);
      if (key !== null) element.setAttribute(attribute, t(key, values));
    }
  }
}

export function installLanguageControl(container: HTMLElement): HTMLSelectElement {
  const label = document.createElement("label");
  label.className = "language-control";
  const caption = document.createElement("span");
  caption.dataset.i18n = "语言";
  const select = document.createElement("select");
  select.id = "language-select";
  select.dataset.i18nAriaLabel = "界面语言";
  const names: Record<LocalePreference, string> = { auto: "跟随浏览器", en: "English", "zh-CN": "简体中文", "zh-TW": "繁體中文", ja: "日本語", ko: "한국어" };
  for (const [value, text] of Object.entries(names)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    if (value === "auto") option.dataset.i18n = text;
    select.append(option);
  }
  const error = document.createElement("span");
  error.className = "language-error";
  error.setAttribute("role", "status");
  error.hidden = true;
  label.append(caption, select, error);
  container.append(label);
  const refresh = (): void => { select.value = preference; translateDocument(label); };
  select.addEventListener("change", () => {
    const next = parseLocalePreference(select.value);
    select.disabled = true;
    error.hidden = true;
    void setLocalePreference(next).catch(() => {
      error.textContent = t("无法保存语言设置，请重试。");
      error.hidden = false;
      refresh();
    }).finally(() => { select.disabled = false; });
  });
  onLocaleChange(refresh);
  refresh();
  return select;
}
