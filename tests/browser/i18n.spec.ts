import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const fixtureOrigin = "http://127.0.0.1:4179";
const extensionPath = resolve(process.cwd(), "dist/extension");
const evidencePath = resolve(process.cwd(), ".hallmark/browser-evidence/i18n-20260920");
const extensionChannel = "babel_content_clipper.v1";
const localeKey = "babel_content_clipper.locale.v1";
const playwrightExecutable = chromium.executablePath();
const chromiumExecutable = process.env.BABEL_CHROMIUM_PATH
  ?? (existsSync(playwrightExecutable) ? playwrightExecutable : undefined);

type Locale = "en" | "zh-CN" | "zh-TW" | "ja" | "ko";
type LocalePreference = Locale | "auto";
type ExtensionPage = "sidepanel.html" | "library.html" | "help.html";

type RuntimeResponse<T = unknown> = {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: { readonly code?: string; readonly message?: string };
};

type CaptureCreateResponse = {
  readonly value: { readonly capture: { readonly captureId: string; readonly initialJobId: string } };
};

type CaptureDetail = {
  readonly capture: {
    readonly source: { readonly title: string };
    readonly selection: { readonly exact?: string; readonly text?: string };
  };
};

const localeFacts: Record<Locale, {
  readonly html: string;
  readonly sideHeading: string;
  readonly libraryHeading: string;
  readonly libraryTitle: string;
  readonly helpTitle: string;
  readonly languageLabel: string;
  readonly pasteButton: string;
  readonly settingsButton: string;
  readonly emptyHeading: string;
  readonly saveSettings: string;
  readonly invalidUrl: string;
}> = {
  en: {
    html: "en",
    sideHeading: "Clips",
    libraryHeading: "Library",
    libraryTitle: "Babel Content Clipper Library",
    helpTitle: "Babel Content Clipper — About & help",
    languageLabel: "Language",
    pasteButton: "Paste import",
    settingsButton: "Save settings",
    emptyHeading: "Select a record",
    saveSettings: "Save settings",
    invalidUrl: "Enter a complete http or https URL, or leave it blank.",
  },
  "zh-CN": {
    html: "zh-CN",
    sideHeading: "素材夹",
    libraryHeading: "素材库",
    libraryTitle: "Babel Content Clipper 素材库",
    helpTitle: "Babel Content Clipper — 关于与使用帮助",
    languageLabel: "语言",
    pasteButton: "粘贴导入",
    settingsButton: "保存设置",
    emptyHeading: "选择一条记录",
    saveSettings: "保存设置",
    invalidUrl: "请填写完整的 http 或 https 网址，或留空。",
  },
  "zh-TW": {
    html: "zh-TW",
    sideHeading: "素材夾",
    libraryHeading: "素材庫",
    libraryTitle: "Babel Content Clipper 素材庫",
    helpTitle: "Babel Content Clipper — 關於與使用說明",
    languageLabel: "語言",
    pasteButton: "貼上匯入",
    settingsButton: "儲存設定",
    emptyHeading: "選擇一筆記錄",
    saveSettings: "儲存設定",
    invalidUrl: "請填寫完整的 http 或 https 網址，或留空。",
  },
  ja: {
    html: "ja",
    sideHeading: "クリップ",
    libraryHeading: "ライブラリ",
    libraryTitle: "Babel Content Clipper ライブラリ",
    helpTitle: "Babel Content Clipper — このアプリと使い方",
    languageLabel: "言語",
    pasteButton: "貼り付けて取り込む",
    settingsButton: "設定を保存",
    emptyHeading: "記録を選択",
    saveSettings: "設定を保存",
    invalidUrl: "完全な http または https URL を入力するか、空欄にしてください。",
  },
  ko: {
    html: "ko",
    sideHeading: "클립 보관함",
    libraryHeading: "라이브러리",
    libraryTitle: "Babel Content Clipper 라이브러리",
    helpTitle: "Babel Content Clipper — 소개 및 도움말",
    languageLabel: "언어",
    pasteButton: "붙여넣기 가져오기",
    settingsButton: "설정 저장",
    emptyHeading: "기록 선택",
    saveSettings: "설정 저장",
    invalidUrl: "완전한 http 또는 https 주소를 입력하거나 비워 두세요.",
  },
};

const manualLocales: readonly Locale[] = ["en", "zh-CN", "zh-TW", "ja", "ko"];

function browserLocaleToExtensionLocale(language: string): Locale {
  const normalized = language.replaceAll("_", "-").toLowerCase();
  if (/^zh(?:-|$)/u.test(normalized)) return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/u.test(normalized) ? "zh-TW" : "zh-CN";
  if (/^ja(?:-|$)/u.test(normalized)) return "ja";
  if (/^ko(?:-|$)/u.test(normalized)) return "ko";
  return "en";
}

async function extensionWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
}

async function extensionId(context: BrowserContext, preference: LocalePreference | undefined = "zh-CN"): Promise<string> {
  const worker = await extensionWorker(context);
  await worker.evaluate(async ({ key, value }) => {
    if (value === undefined) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: value });
  }, { key: localeKey, value: preference });
  return new URL(worker.url()).hostname;
}

async function launchContext(label: string): Promise<{ readonly context: BrowserContext; readonly profile: string }> {
  await mkdir(evidencePath, { recursive: true });
  const profile = resolve(evidencePath, `profile-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const context = await chromium.launchPersistentContext(profile, {
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-sandbox",
      "--mute-audio",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--no-first-run",
      "--disable-sync",
    ],
  });
  await context.route("**/*", async route => {
    const url = route.request().url();
    if (url.startsWith("chrome-extension://") || url.startsWith("data:") || url.startsWith("blob:") || url.startsWith(fixtureOrigin + "/")) {
      await route.continue();
      return;
    }
    await route.abort();
  });
  return { context, profile };
}

function collectPageErrors(page: Page, errors: string[]): void {
  page.on("console", message => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  page.on("pageerror", error => errors.push(`pageerror:${error.message}`));
}

async function extensionPage(
  context: BrowserContext,
  id: string,
  path: ExtensionPage,
  errors: string[],
  viewport: { readonly width: number; readonly height?: number } = { width: 768, height: 900 },
): Promise<Page> {
  const page = await context.newPage();
  collectPageErrors(page, errors);
  await page.setViewportSize({ width: viewport.width, height: viewport.height ?? 900 });
  await page.goto(`chrome-extension://${id}/${path}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("#language-select")).toBeVisible();
  if (path !== "help.html") {
    await page.locator(".loading-state, .skeleton-row").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  }
  return page;
}

async function core<T = unknown>(page: Page, method: string, params: unknown = {}): Promise<T> {
  const response = await page.evaluate(
    ({ channel, requestedMethod, requestedParams }) => new Promise<RuntimeResponse<T>>((resolve) => {
      chrome.runtime.sendMessage(
        { channel, type: "core", method: requestedMethod, params: requestedParams },
        (value: RuntimeResponse<T>) => resolve(value),
      );
    }),
    { channel: extensionChannel, requestedMethod: method, requestedParams: params },
  );
  if (!response?.ok || response.result === undefined) {
    throw new Error(`${method} failed: ${response?.error?.code ?? "UNKNOWN"} ${response?.error?.message ?? ""}`.trim());
  }
  return response.result;
}

async function setLocale(page: Page, locale: LocalePreference): Promise<void> {
  await page.locator("#language-select").selectOption(locale);
}

async function waitForLocale(page: Page, locale: LocalePreference): Promise<void> {
  await expect(page.locator("#language-select")).toHaveValue(locale);
  const browserLanguage = locale === "auto"
    ? await page.evaluate(() => chrome.i18n.getUILanguage?.() || navigator.language || "en")
    : undefined;
  const resolved = locale === "auto" ? browserLocaleToExtensionLocale(browserLanguage!) : locale;
  await expect(page.locator("html")).toHaveAttribute("lang", localeFacts[resolved].html);
}

async function assertNoUntranslatedPlaceholders(page: Page): Promise<void> {
  const unresolved = await page.evaluate(() => {
    const body = document.body.innerText;
    const attributes = [...document.querySelectorAll<HTMLElement>("*")].flatMap(element =>
      [element.getAttribute("title"), element.getAttribute("aria-label"), element.getAttribute("placeholder")].filter((value): value is string => value !== null));
    return [...body.matchAll(/\{[a-zA-Z][a-zA-Z0-9_]*\}/gu)].map(match => match[0])
      .concat(attributes.flatMap(value => [...value.matchAll(/\{[a-zA-Z][a-zA-Z0-9_]*\}/gu)].map(match => match[0])));
  });
  expect(unresolved, `unresolved localized placeholders on ${await page.title()}`).toEqual([]);
}

async function assertAccessibleAndContained(page: Page): Promise<void> {
  const facts = await page.evaluate(() => {
    const visible = (element: HTMLElement): boolean => {
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && !element.hidden && (element.offsetWidth > 0 || element.offsetHeight > 0);
    };
    const controls = [...document.querySelectorAll<HTMLElement>("button, input, select, textarea, a")]
      .filter(element => visible(element)
        && (!(element instanceof HTMLInputElement) || element.type !== "file")
        && !element.classList.contains("visually-hidden"));
    const missingAccessibleNames = controls.filter(element => {
      const label = element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText ||
        (element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : "") ||
        element.closest("label")?.textContent || "";
      return !label.trim();
    }).map(element => `${element.tagName.toLowerCase()}#${element.id}`);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      missingAccessibleNames,
    };
  });
  expect(facts.missingAccessibleNames, `unnamed controls on ${await page.title()}`).toEqual([]);
  expect(facts.scrollWidth, `horizontal overflow on ${await page.title()}`).toBeLessThanOrEqual(facts.clientWidth + 1);
}

async function saveScreenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(evidencePath, name), fullPage: true });
}

async function saveEvidence(name: string, value: unknown): Promise<void> {
  await mkdir(evidencePath, { recursive: true });
  await writeFile(resolve(evidencePath, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createControlledRecord(page: Page): Promise<{ readonly captureId: string; readonly jobId: string }> {
  const response = await core<CaptureCreateResponse>(page, "capture.create", {
    requestId: randomUUID(),
    input: {
      kind: "text_selection",
      state: "sealed",
      source: {
        title: "选择一条记录",
        pageUrl: "https://fixture.invalid/i18n-source",
        site: "fixture.invalid",
        identityConfidence: "best_effort",
        metadata: { setup: "i18n-browser", purpose: "source-text-immutability" },
      },
      selection: {
        type: "text",
        exact: "保存设置",
        locator: { type: "text_quote", sourceConfidence: "fixture-setup" },
      },
      captureMethod: "fixture-setup",
      assetsState: "saved",
      integrity: { status: "complete_selection", missing: [] },
    },
  });
  return {
    captureId: response.value.capture.captureId,
    jobId: response.value.capture.initialJobId,
  };
}

test("five locales render dynamic labels, titles, help links and responsive screenshots", async () => {
  const run = await launchContext("render");
  const errors: string[] = [];
  try {
    const id = await extensionId(run.context, "zh-CN");
    const sidepanel = await extensionPage(run.context, id, "sidepanel.html", errors, { width: 375 });
    const library = await extensionPage(run.context, id, "library.html", errors, { width: 768 });
    const help = await extensionPage(run.context, id, "help.html", errors, { width: 414 });
    const pages = { sidepanel, library, help };
    const screenshotWidths: Record<Locale, { readonly sidepanel: number; readonly library: number; readonly help: number }> = {
      en: { sidepanel: 320, library: 1440, help: 768 },
      "zh-CN": { sidepanel: 375, library: 768, help: 414 },
      "zh-TW": { sidepanel: 414, library: 375, help: 1440 },
      ja: { sidepanel: 768, library: 414, help: 320 },
      ko: { sidepanel: 1440, library: 320, help: 375 },
    };
    const evidence: Record<string, unknown> = { profile: run.profile, network: "local fixture and chrome-extension URLs only", muteAudio: true, locales: {} };

    for (const locale of manualLocales) {
      await setLocale(sidepanel, locale);
      await Promise.all(Object.values(pages).map(page => waitForLocale(page, locale)));
      const facts = localeFacts[locale];
      await expect(sidepanel.locator("h1")).toHaveText(facts.sideHeading);
      await expect(library.locator("h1")).toHaveText(facts.libraryHeading);
      await expect(help.locator("#language-control .language-control > span[data-i18n]")).toHaveText(facts.languageLabel);
      await expect(sidepanel.locator("#language-select")).toHaveValue(locale);
      await expect(library.locator("#language-select")).toHaveValue(locale);
      await expect(help.locator("#language-select")).toHaveValue(locale);
      await expect(sidepanel).toHaveTitle(new RegExp(`^Babel Content Clipper`));
      await expect(library).toHaveTitle(facts.libraryTitle);
      await expect(help).toHaveTitle(facts.helpTitle);
      await expect(library.getByRole("button", { name: facts.pasteButton })).toBeVisible();
      await expect(library.locator("#detail")).toContainText(facts.emptyHeading);
      expect(await help.locator("body").innerText()).toContain("Babel Content Clipper");
      await expect(help.locator("#install-doc")).toHaveAttribute("href", new RegExp(`help-docs/${facts.html}/install\\.md$`));
      await expect(help.locator("#install-doc")).toHaveAttribute("download", new RegExp(facts.html));
      await assertNoUntranslatedPlaceholders(sidepanel);
      await assertNoUntranslatedPlaceholders(library);
      await assertNoUntranslatedPlaceholders(help);

      const widths = screenshotWidths[locale];
      for (const [pageName, page] of Object.entries(pages) as Array<[keyof typeof pages, Page]>) {
        await page.setViewportSize({ width: widths[pageName], height: 900 });
        await assertAccessibleAndContained(page);
        await saveScreenshot(page, `${locale}-${pageName}-${widths[pageName]}.png`);
      }
      (evidence.locales as Record<string, unknown>)[locale] = {
        html: await sidepanel.locator("html").getAttribute("lang"),
        sideHeading: await sidepanel.locator("h1").innerText(),
        libraryHeading: await library.locator("h1").innerText(),
        helpTitle: await help.title(),
        screenshotWidths: widths,
      };
    }
    expect(errors, "new page console/page errors").toEqual([]);
    await saveEvidence("render-summary.json", evidence);
  } finally {
    await run.context.close();
  }
});

test("locale changes propagate across open pages, preserve drafts, persist on reopen, and auto follows Chrome", async () => {
  const run = await launchContext("sync-drafts");
  const errors: string[] = [];
  try {
    const id = await extensionId(run.context, "zh-CN");
    const sidepanel = await extensionPage(run.context, id, "sidepanel.html", errors, { width: 375 });
    const library = await extensionPage(run.context, id, "library.html", errors, { width: 768 });
    const help = await extensionPage(run.context, id, "help.html", errors, { width: 768 });

    await setLocale(sidepanel, "en");
    await Promise.all([waitForLocale(sidepanel, "en"), waitForLocale(library, "en"), waitForLocale(help, "en")]);
    await expect(library.locator("#detail")).toContainText(localeFacts.en.emptyHeading);

    await library.locator("#settings").click();
    await expect(library.locator(".settings-form")).toBeVisible();
    await library.locator('input[name="paddingBeforeSeconds"]').fill("17");
    await library.locator('input[name="globalOutputDirectory"]').fill("/tmp/i18n-draft-output");
    await library.locator('select[name="defaultOutputRangePolicy"]').selectOption("original");

    await library.getByRole("button", { name: localeFacts.en.pasteButton }).click();
    const pasteDialog = library.locator(".paste-dialog");
    await expect(pasteDialog).toBeVisible();
    await expect(pasteDialog.locator("form")).toHaveAttribute("novalidate", "");
    // The optional title control stays blank; the default is payload metadata
    // generated at open time and frozen across a retry.
    await expect(pasteDialog.locator('input[name="title"]')).toHaveValue("");
    await pasteDialog.locator('textarea[name="text"]').fill("无标题跨语言重试原文");
    await pasteDialog.locator('input[name="source"]').fill("not-a-url");
    await pasteDialog.getByRole("button", { name: "Save to library" }).click();
    await expect(pasteDialog.locator(".paste-error")).toContainText(/http/u);
    await expect(pasteDialog.locator(".paste-error")).not.toContainText("{count}");
    const invalidUrlErrorEn = await pasteDialog.locator(".paste-error").innerText();
    await expect(pasteDialog.locator('textarea[name="text"]')).toHaveValue("无标题跨语言重试原文");
    await expect(pasteDialog.locator('input[name="title"]')).toHaveValue("");

    // Changing another open page localizes the error and must not change the
    // default title captured when this dialog opened in English.
    await setLocale(sidepanel, "ja");
    await Promise.all([waitForLocale(sidepanel, "ja"), waitForLocale(library, "ja"), waitForLocale(help, "ja")]);
    await expect(pasteDialog.locator('input[name="title"]')).toHaveValue("");
    await expect(pasteDialog.locator(".paste-error")).toContainText(/http/u);
    const invalidUrlErrorJa = await pasteDialog.locator(".paste-error").innerText();
    await pasteDialog.locator('input[name="source"]').fill("https://fixture.invalid/untitled-paste");
    await pasteDialog.getByRole("button", { name: "ライブラリに保存" }).click();
    await expect(pasteDialog).toBeHidden();
    await expect(library.locator("#toast")).toContainText("貼り付けた内容を保存しました");
    const firstPasteRecords = await core<{ readonly records: readonly { readonly captureId: string; readonly title: string }[] }>(library, "capture.list", { view: "all", limit: 50 });
    const untitledRecord = firstPasteRecords.records.find(record => record.title === "Paste import");
    expect(untitledRecord, "untitled paste should freeze the English default title").toBeDefined();

    // The second modal stays open while another already-open extension page
    // changes the preference, preserving both settings and paste drafts.
    await library.getByRole("button", { name: localeFacts.ja.pasteButton }).click();
    const draftDialog = library.locator(".paste-dialog");
    await expect(draftDialog).toBeVisible();
    await draftDialog.locator('textarea[name="text"]').fill("保存设置：跨页面切换后仍保留");
    await draftDialog.locator('input[name="title"]').fill("选择一条记录");
    await draftDialog.locator('input[name="source"]').fill("https://fixture.invalid/paste-draft");
    await setLocale(sidepanel, "ko");
    await Promise.all([waitForLocale(sidepanel, "ko"), waitForLocale(library, "ko"), waitForLocale(help, "ko")]);
    await expect(library.locator('input[name="paddingBeforeSeconds"]')).toHaveValue("17");
    await expect(library.locator('input[name="globalOutputDirectory"]')).toHaveValue("/tmp/i18n-draft-output");
    await expect(library.locator('select[name="defaultOutputRangePolicy"]')).toHaveValue("original");
    await expect(draftDialog.locator('textarea[name="text"]')).toHaveValue("保存设置：跨页面切换后仍保留");
    await expect(draftDialog.locator('input[name="title"]')).toHaveValue("选择一条记录");
    await expect(draftDialog.locator('input[name="source"]')).toHaveValue("https://fixture.invalid/paste-draft");
    await expect(draftDialog.getByRole("button", { name: "라이브러리에 저장" })).toBeVisible();

    await draftDialog.locator('input[name="source"]').fill("not-a-url");
    await draftDialog.getByRole("button", { name: "라이브러리에 저장" }).click();
    await expect(draftDialog.locator(".paste-error")).toContainText(/http/u);
    await expect(draftDialog.locator(".paste-error")).not.toContainText("{count}");
    const invalidUrlError = await draftDialog.locator(".paste-error").innerText();
    await expect(draftDialog.locator('textarea[name="text"]')).toHaveValue("保存设置：跨页面切换后仍保留");
    await expect(draftDialog.locator('input[name="title"]')).toHaveValue("选择一条记录");
    await draftDialog.locator('input[name="source"]').fill("https://fixture.invalid/paste-draft");
    await draftDialog.getByRole("button", { name: "라이브러리에 저장" }).click();
    await expect(draftDialog).toBeHidden();
    await expect(library.locator("#toast")).toContainText("붙여넣은 내용을 저장했습니다");

    await setLocale(sidepanel, "en");
    await Promise.all([waitForLocale(sidepanel, "en"), waitForLocale(library, "en"), waitForLocale(help, "en")]);
    await expect(library.locator(".settings-form")).toBeVisible();
    await expect(library.locator('input[name="paddingBeforeSeconds"]')).toHaveValue("17");

    const reopenedLibrary = await extensionPage(run.context, id, "library.html", errors, { width: 768 });
    const reopenedHelp = await extensionPage(run.context, id, "help.html", errors, { width: 768 });
    await Promise.all([waitForLocale(reopenedLibrary, "en"), waitForLocale(reopenedHelp, "en")]);
    await expect(reopenedLibrary.locator("#language-select")).toHaveValue("en");
    await expect(reopenedHelp.locator("#language-select")).toHaveValue("en");

    const browserLanguage = await reopenedHelp.evaluate(() => chrome.i18n.getUILanguage?.() || navigator.language || "en");
    const expectedAuto = browserLocaleToExtensionLocale(browserLanguage);
    await setLocale(sidepanel, "auto");
    await Promise.all([
      waitForLocale(sidepanel, "auto"),
      waitForLocale(library, "auto"),
      waitForLocale(help, "auto"),
      waitForLocale(reopenedLibrary, "auto"),
      waitForLocale(reopenedHelp, "auto"),
    ]);
    await expect(sidepanel.locator("html")).toHaveAttribute("lang", localeFacts[expectedAuto].html);
    await expect(library.locator("html")).toHaveAttribute("lang", localeFacts[expectedAuto].html);
    await expect(reopenedLibrary.locator("html")).toHaveAttribute("lang", localeFacts[expectedAuto].html);
    const storedPreference = await reopenedHelp.evaluate(async key => (await chrome.storage.local.get(key))[key], localeKey);
    expect(storedPreference).toBe("auto");

    await Promise.all([sidepanel.close(), library.close(), help.close(), reopenedLibrary.close(), reopenedHelp.close()]);
    expect(errors, "new page console/page errors").toEqual([]);
    await saveEvidence("sync-drafts-summary.json", {
      profile: run.profile,
      propagatedManualLocale: "ja -> ko",
      settingsDraft: { paddingBeforeSeconds: "17", globalOutputDirectory: "/tmp/i18n-draft-output", defaultOutputRangePolicy: "original" },
      pasteDraft: { text: "保存设置：跨页面切换后仍保留", title: "选择一条记录", source: "https://fixture.invalid/paste-draft" },
      untitledPaste: { text: "无标题跨语言重试原文", frozenTitle: "Paste import", persisted: Boolean(untitledRecord) },
      invalidUrlError: { en: invalidUrlErrorEn, ja: invalidUrlErrorJa, ko: invalidUrlError },
      reopenedPreference: "en",
      browserLanguage,
      autoResolvedLocale: expectedAuto,
      storedPreferenceAfterAuto: storedPreference,
    });
  } finally {
    await run.context.close();
  }
});

test("captured source and title remain byte-for-byte source data across locale changes, and real paste saves a record", async () => {
  const run = await launchContext("source-integrity");
  const errors: string[] = [];
  try {
    const id = await extensionId(run.context, "zh-CN");
    const library = await extensionPage(run.context, id, "library.html", errors, { width: 768 });
    const controlled = await createControlledRecord(library);
    const before = await core<CaptureDetail>(library, "capture.get", { captureId: controlled.captureId });
    expect(before.capture.source.title).toBe("选择一条记录");
    expect(before.capture.selection.exact).toBe("保存设置");

    await library.reload();
    await library.waitForLoadState("domcontentloaded");
    await expect(library.locator(".library-row")).toHaveCount(1);
    await library.locator(".library-row").click();
    await expect(library.locator("#detail")).toContainText("选择一条记录");
    await expect(library.locator("#detail")).toContainText("保存设置");

    for (const locale of ["en", "ja", "ko", "zh-TW", "zh-CN"] as const) {
      await setLocale(library, locale);
      await waitForLocale(library, locale);
      const after = await core<CaptureDetail>(library, "capture.get", { captureId: controlled.captureId });
      expect(after.capture.source.title, `source title rewritten in ${locale}`).toBe("选择一条记录");
      expect(after.capture.selection.exact, `source text rewritten in ${locale}`).toBe("保存设置");
      await expect(library.locator("#detail")).toContainText("选择一条记录");
      await expect(library.locator("#detail")).toContainText("保存设置");
      await assertNoUntranslatedPlaceholders(library);
    }

    await setLocale(library, "en");
    await expect(library.getByRole("button", { name: localeFacts.en.pasteButton })).toBeVisible();
    await library.getByRole("button", { name: localeFacts.en.pasteButton }).click();
    const dialog = library.locator(".paste-dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator('textarea[name="text"]').fill("真实入口保存的原文：选择一条记录");
    await dialog.locator('input[name="title"]').fill("保存设置");
    await dialog.getByRole("button", { name: "Save to library" }).click();
    await expect(dialog).toBeHidden();
    await expect(library.locator("#toast")).toContainText("Pasted content saved");

    const records = await core<{ readonly records: readonly { readonly captureId: string; readonly title: string }[] }>(library, "capture.list", { view: "all", limit: 50 });
    expect(records.records).toHaveLength(2);
    const pasted = records.records.find(record => record.captureId !== controlled.captureId);
    expect(pasted).toBeDefined();
    const pastedDetail = await core<CaptureDetail>(library, "capture.get", { captureId: pasted?.captureId });
    expect(pastedDetail.capture.source.title).toBe("保存设置");
    expect(pastedDetail.capture.selection.text).toBe("真实入口保存的原文：选择一条记录");
    await saveScreenshot(library, "source-integrity-library-en-768.png");
    expect(errors, "new page console/page errors").toEqual([]);
    await saveEvidence("source-integrity-summary.json", {
      profile: run.profile,
      controlledCapture: { captureId: controlled.captureId, title: "选择一条记录", exact: "保存设置" },
      checkedLocales: ["en", "ja", "ko", "zh-TW", "zh-CN"],
      realEntry: { method: "library paste dialog", title: "保存设置", text: "真实入口保存的原文：选择一条记录", persisted: true },
    });
  } finally {
    await run.context.close();
  }
});
