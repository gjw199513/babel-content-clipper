import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const fixtureOrigin = "http://127.0.0.1:4179";
const extensionPath = resolve(process.cwd(), "dist/extension");
const evidencePath = resolve(process.cwd(), ".hallmark/browser-evidence");
const playwrightExecutable = chromium.executablePath();
const chromiumExecutable = process.env.BABEL_CHROMIUM_PATH ?? (existsSync(playwrightExecutable) ? playwrightExecutable : undefined);

async function extensionId(context: BrowserContext): Promise<string> {
  const workers = context.serviceWorkers();
  const worker = workers[0] ?? await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ "babel_content_clipper.locale.v1": "zh-CN" }));
  return new URL(worker.url()).hostname;
}

async function extensionPage(context: BrowserContext, id: string, path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/${path}`);
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function selectText(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  });
}

async function clickExtensionAction(page: Page, action: "capture-selection" | "toggle-media-capture", recordLive = false, frameId = 0, tabId?: number): Promise<Record<string, unknown>> {
  return page.evaluate(async ({ action, recordLive, frameId, tabId }) => {
    const response = await chrome.runtime.sendMessage({ channel: "babel_content_clipper.v1", type: "action", action, recordLive, frameId, ...(tabId === undefined ? {} : { tabId }) });
    if (!response?.ok) throw new Error(response?.error?.message ?? "extension action failed");
    return (response.result && typeof response.result === "object" ? response.result : {}) as Record<string, unknown>;
  }, { action, recordLive, frameId, tabId });
}

test("selection, same-origin iframe provenance, shared pages and safe preview", async () => {
  await mkdir(evidencePath, { recursive: true });
  const userDataDir = resolve(evidencePath, `profile-selection-${Date.now()}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    headless: process.env.BABEL_HEADFUL !== "1",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox", "--mute-audio"],
  });
  const workerErrors: string[] = [];
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    worker.on("console", message => { if (message.type() === "error") workerErrors.push(message.text()); });
    const id = new URL(worker.url()).hostname;
    const article = await context.newPage();
    await article.goto(`${fixtureOrigin}/article.html`);
    await article.waitForLoadState("domcontentloaded");
    const sidepanel = await extensionPage(context, id, "sidepanel.html");
    await article.bringToFront();
    await selectText(article, "#selection");
    await clickExtensionAction(sidepanel, "capture-selection");
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1);
    await sidepanel.screenshot({ path: resolve(evidencePath, "A01-sidepanel-selection.png"), fullPage: true });

    const library = await extensionPage(context, id, "library.html");
    await expect(library.locator(".library-row")).toHaveCount(1);
    await library.locator(".library-row").first().click();
    await expect(library.locator(".detail-content")).toContainText("完整原文");
    await library.screenshot({ path: resolve(evidencePath, "B01-library-detail.png"), fullPage: true });

    const frames = await context.newPage();
    frames.on("console", message => console.log(`[fixture:${message.type()}] ${message.text()}`));
    await frames.goto(`${fixtureOrigin}/frames.html`);
    await frames.waitForLoadState("domcontentloaded");
    const child = frames.frameLocator("#same-origin");
    await child.locator("#selection").waitFor();
    await child.locator("#selection").evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    await expect.poll(async () => await child.locator("body").evaluate(() => window.getSelection()?.toString() ?? "")).toContain("阅读时");
    await frames.waitForTimeout(250);
    const childFrameId = await sidepanel.evaluate(async () => { const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); const tabId = tabs[0]?.id; if (tabId === undefined) throw new Error("active fixture tab missing"); const frameList = await chrome.webNavigation.getAllFrames({ tabId }) ?? []; const child = frameList.find(frame => frame.frameId !== 0 && frame.url.includes("article.html")); if (!child) throw new Error("same-origin child frame missing"); return child.frameId; });
    await clickExtensionAction(sidepanel, "capture-selection", false, childFrameId);
    await expect(sidepanel.locator(".capture-row")).toHaveCount(2);
    await expect(library.locator(".library-row")).toHaveCount(2);
    await expect(library.locator(".detail-panel")).toBeVisible();
    await expect.poll(async () => await sidepanel.locator(".capture-row").count()).toBe(2);
    await library.screenshot({ path: resolve(evidencePath, "B03-cross-page-frame-sync.png"), fullPage: true });
    expect(workerErrors, workerErrors.join("\n")).toEqual([]);
  } finally {
    await context.close();
  }
});

test("media timeline range preserves real start, seek and end facts", async () => {
  const userDataDir = resolve(evidencePath, `profile-media-${Date.now()}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    headless: process.env.BABEL_HEADFUL !== "1",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox", "--mute-audio"],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    await worker.evaluate(() => chrome.storage.local.set({ "babel_content_clipper.locale.v1": "zh-CN" }));
    const id = new URL(worker.url()).hostname;
    const media = await context.newPage();
    await media.goto(`${fixtureOrigin}/media.html`);
    await media.locator("#main-video").evaluate((video) => { (video as HTMLVideoElement).currentTime = 4; });
    const sidepanel = await extensionPage(context, id, "sidepanel.html");
    await media.bringToFront();
    const started = await clickExtensionAction(sidepanel, "toggle-media-capture");
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1);
    expect(started.status).toBe("open");
    await media.locator("#seek-forward").click();
    await media.waitForTimeout(300);
    await media.bringToFront();
    await clickExtensionAction(sidepanel, "toggle-media-capture");
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1);
    const library = await extensionPage(context, id, "library.html");
    await expect(library.locator(".library-row")).toHaveCount(1);
    await library.locator(".library-row").click();
    await expect(library.locator(".detail-panel")).toContainText("观测区间");
    await expect(library.locator(".detail-panel")).toContainText("真实终点");
    await library.screenshot({ path: resolve(evidencePath, "A04-media-range.png"), fullPage: true });
  } finally {
    await context.close();
  }
});

test("explicit live recording reports real tabCapture coverage or a visible unavailable result", async () => {
  const userDataDir = resolve(evidencePath, `profile-live-${Date.now()}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    headless: process.env.BABEL_HEADFUL !== "1",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox", "--mute-audio"],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).hostname;
    const media = await context.newPage();
    await media.goto(`${fixtureOrigin}/media.html`);
    const sidepanel = await extensionPage(context, id, "sidepanel.html");
    const targetTabId = await sidepanel.evaluate(async () => { const tabs = await chrome.tabs.query({}); const tab = tabs.find(item => item.url?.endsWith("/media.html")); if (tab?.id === undefined) throw new Error("media tab missing"); return tab.id; });
    const started = await clickExtensionAction(sidepanel, "toggle-media-capture", true, 0, targetTabId);
    expect(started.recordLive).toBe(true);
    expect(["started", "unavailable"]).toContain(started.recording);
    await media.waitForTimeout(2_000);
    const stopped = await clickExtensionAction(sidepanel, "toggle-media-capture", true, 0, targetTabId);
    expect(stopped).toBeDefined();
    const library = await extensionPage(context, id, "library.html");
    await expect(library.locator(".library-row")).toHaveCount(1);
    await library.locator(".library-row").click();
    if (started.recording === "started") await expect(library.locator(".attachment-list")).toBeVisible();
    await library.screenshot({ path: resolve(evidencePath, `live-recording-${started.recording}.png`), fullPage: true });
  } finally {
    await context.close();
  }
});

test("public-page selection smoke uses the same explicit action", async () => {
  const userDataDir = resolve(evidencePath, `profile-public-${Date.now()}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    headless: process.env.BABEL_HEADFUL !== "1",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox", "--mute-audio"],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).hostname;
    const page = await context.newPage();
    await page.goto("https://example.com");
    await page.waitForLoadState("domcontentloaded");
    await selectText(page, "h1");
    const sidepanel = await extensionPage(context, id, "sidepanel.html");
    await page.bringToFront();
    await clickExtensionAction(sidepanel, "capture-selection");
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1);
    await expect(sidepanel.locator(".capture-row").first()).toContainText("Example Domain");
    await sidepanel.screenshot({ path: resolve(evidencePath, "A05-public-example.png"), fullPage: true });
  } finally {
    await context.close();
  }
});

test("reader same-URL chapter replacement rejects a stale selection snapshot", async () => {
  const userDataDir = resolve(evidencePath, `profile-reader-${Date.now()}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    headless: process.env.BABEL_HEADFUL !== "1",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox", "--mute-audio"],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).hostname;
    const reader = await context.newPage();
    await reader.goto(`${fixtureOrigin}/reader.html`);
    await reader.waitForLoadState("domcontentloaded");
    await selectText(reader, "#text");
    const sidepanel = await extensionPage(context, id, "sidepanel.html");
    await reader.bringToFront();
    await clickExtensionAction(sidepanel, "capture-selection");
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1);
    await reader.evaluate(() => {
      const article = document.querySelector("#reader");
      if (!article) throw new Error("reader article missing");
      article.innerHTML = "<p id=\"text\">同一地址已经换成另一章，上一章的选区不能继续使用。</p>";
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
    const stale = await sidepanel.evaluate(async () => await chrome.runtime.sendMessage({ channel: "babel_content_clipper.v1", type: "action", action: "capture-selection" }));
    expect(stale?.ok).toBe(false);
    expect(stale?.error?.code).toBe("SELECTION_EMPTY");
    await sidepanel.screenshot({ path: resolve(evidencePath, "A05-reader-stale-selection.png"), fullPage: true });
  } finally {
    await context.close();
  }
});
