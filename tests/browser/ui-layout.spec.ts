import { expect, test, chromium, type BrowserContext, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const fixtureOrigin = "http://127.0.0.1:4179";
const extensionPath = resolve(process.env.BABEL_EXTENSION_PATH ?? resolve(process.cwd(), "dist/extension"));
const evidencePath = resolve(process.env.BABEL_UI_EVIDENCE_PATH
  ?? resolve(process.cwd(), ".hallmark/browser-evidence/ui-layout-20260920"));
const playwrightExecutable = chromium.executablePath();
const chromiumExecutable = process.env.BABEL_CHROMIUM_PATH
  ?? (existsSync(playwrightExecutable) ? playwrightExecutable : undefined);
const widths = [320, 375, 414, 768] as const;

type LayoutFacts = {
  readonly width: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly wrappedControls: readonly string[];
  readonly clippedControls: readonly string[];
};

async function extensionId(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ "babel_content_clipper.locale.v1": "zh-CN" }));
  return new URL(worker.url()).hostname;
}

async function openExtensionPage(
  context: BrowserContext,
  id: string,
  path: string,
  width: number,
): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`chrome-extension://${id}/${path}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("#language-select")).toBeVisible();
  await page.locator(".loading-state, .skeleton-row").first()
    .waitFor({ state: "detached", timeout: 15_000 })
    .catch(() => undefined);
  return page;
}

async function layoutFacts(page: Page, width: number): Promise<LayoutFacts> {
  return page.evaluate((viewportWidth) => {
    const visible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && !element.hidden
        && element.getClientRects().length > 0;
    };
    const controls = [...document.querySelectorAll<HTMLElement>("button, a, select, summary")]
      .filter(visible);
    const wrappedControls = controls.filter((element) => {
      if (element.classList.contains("capture-row") || element.classList.contains("library-row")) return false;
      const style = getComputedStyle(element);
      const lineHeight = Number.parseFloat(style.lineHeight);
      return style.whiteSpace !== "nowrap"
        && Number.isFinite(lineHeight)
        && element.getBoundingClientRect().height > lineHeight * 1.65;
    }).map((element) => element.textContent?.trim() || `${element.tagName.toLowerCase()}#${element.id}`);
    const clippedControls = controls.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > viewportWidth + 1;
    }).map((element) => element.textContent?.trim() || `${element.tagName.toLowerCase()}#${element.id}`);
    return {
      width: viewportWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      wrappedControls,
      clippedControls,
    };
  }, width);
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

test("side panel stays compact and settings use a dedicated responsive page", async () => {
  await mkdir(evidencePath, { recursive: true });
  const profile = resolve(evidencePath, `profile-${Date.now()}`);
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
  const errors: string[] = [];
  const evidence: Record<string, unknown> = {
    extensionPath,
    muteAudio: true,
    widths,
    sidepanel: [],
    settings: [],
  };
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    worker.on("console", message => {
      if (message.type() === "error") errors.push(`worker:${message.text()}`);
    });
    const id = await extensionId(context);
    const article = await context.newPage();
    await article.goto(`${fixtureOrigin}/article.html`);
    await article.waitForLoadState("domcontentloaded");
    await selectText(article, "#selection");
    const sidepanel = await openExtensionPage(context, id, "sidepanel.html", widths[0]);
    sidepanel.on("console", message => {
      if (message.type() === "error") errors.push(`sidepanel:${message.text()}`);
    });
    sidepanel.on("pageerror", error => errors.push(`sidepanel:${error.message}`));

    await expect(sidepanel.locator(".capture-actions > button")).toHaveCount(4);
    await expect(sidepanel.locator(".capture-options")).not.toHaveAttribute("open", "");
    const buttonRows = await sidepanel.locator(".capture-actions > button").evaluateAll((buttons) =>
      buttons.map(button => Math.round(button.getBoundingClientRect().top)));
    expect(new Set(buttonRows).size).toBe(2);

    await article.bringToFront();
    const captureResponse = await sidepanel.evaluate(async () =>
      await chrome.runtime.sendMessage({
        channel: "babel_content_clipper.v1",
        type: "action",
        action: "capture-selection",
        recordLive: false,
        frameId: 0,
      }));
    expect(captureResponse?.ok).toBe(true);
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1);
    await expect(sidepanel.locator("#connection-notice")).toBeVisible();
    await expect(sidepanel.locator("#connection-notice")).toContainText("请按这个顺序操作");
    await expect(sidepanel.getByRole("button", { name: "立即重连本地服务" })).toBeVisible();
    await expect(sidepanel.locator("#connection-notice").getByRole("button", { name: "打开连接设置" })).toBeVisible();

    for (const width of widths) {
      await sidepanel.setViewportSize({ width, height: 900 });
      const facts = await layoutFacts(sidepanel, width);
      expect(facts.scrollWidth).toBeLessThanOrEqual(facts.clientWidth + 1);
      expect(facts.wrappedControls).toEqual([]);
      expect(facts.clippedControls).toEqual([]);
      (evidence.sidepanel as LayoutFacts[]).push(facts);
      await sidepanel.screenshot({ path: resolve(evidencePath, `sidepanel-${width}.png`), fullPage: true });
    }

    await sidepanel.setViewportSize({ width: 320, height: 900 });
    const pagePromise = context.waitForEvent("page");
    await sidepanel.locator("#settings").click();
    const settings = await pagePromise;
    settings.on("console", message => {
      if (message.type() === "error") errors.push(`settings:${message.text()}`);
    });
    settings.on("pageerror", error => errors.push(`settings:${error.message}`));
    await settings.waitForLoadState("domcontentloaded");
    await expect(settings).toHaveURL(new RegExp(`chrome-extension://${id}/library\\.html#settings$`, "u"));
    await expect(settings.locator("body")).toHaveClass(/settings-view/u);
    await expect(settings.locator(".settings-form")).toBeVisible();
    await expect(settings.locator(".view-tabs")).toBeHidden();
    await expect(settings.locator(".library-toolbar")).toBeHidden();
    await expect(settings.locator(".maintenance-panel")).toBeHidden();
    await expect(settings.locator(".library-list")).toBeHidden();
    await expect(settings.locator("#settings")).toBeHidden();
    await expect(settings.locator(".header-actions")).toBeVisible();

    for (const width of widths) {
      await settings.setViewportSize({ width, height: 900 });
      const facts = await layoutFacts(settings, width);
      expect(facts.scrollWidth).toBeLessThanOrEqual(facts.clientWidth + 1);
      expect(facts.wrappedControls).toEqual([]);
      expect(facts.clippedControls).toEqual([]);
      (evidence.settings as LayoutFacts[]).push(facts);
      await settings.screenshot({ path: resolve(evidencePath, `settings-${width}.png`), fullPage: true });
    }

    const settingsGrid = await settings.locator(".settings-form").evaluate((form) =>
      getComputedStyle(form).gridTemplateColumns.split(" ").filter(Boolean).length);
    expect(settingsGrid).toBeGreaterThanOrEqual(2);
    await settings.getByRole("button", { name: "返回素材库" }).click();
    await expect(settings).toHaveURL(new RegExp(`chrome-extension://${id}/library\\.html$`, "u"));
    await expect(settings.locator("body")).not.toHaveClass(/settings-view/u);
    await expect(settings.locator(".view-tabs")).toBeVisible();
    await expect(settings.locator(".maintenance-panel")).toBeVisible();
    await expect(settings.locator(".maintenance-panel")).not.toHaveAttribute("open", "");
    await expect(settings.locator("#connection-banner")).toBeVisible();
    await expect(settings.locator("#connection-banner")).toContainText("请按这个顺序操作");
    await settings.locator("#connection-banner").getByRole("button", { name: "打开连接设置" }).click();
    await expect(settings.locator(".settings-form")).toBeVisible();
    await expect(settings.locator(".connection-card")).toContainText("MCP 连接");
    await expect(settings.locator(".connection-card")).toContainText("立即重连本地服务");
    expect(errors).toEqual([]);
    evidence.extensionId = id;
    evidence.settingsUrl = settings.url();
    evidence.consoleErrors = errors;
    await writeFile(resolve(evidencePath, "layout-report.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
