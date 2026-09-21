import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const fixtureOrigin = "http://127.0.0.1:4179";
const extensionPath = resolve(process.cwd(), "dist/extension");
const evidencePath = resolve(process.cwd(), ".hallmark/browser-evidence");
const playwrightExecutable = chromium.executablePath();
const chromiumExecutable = process.env.BABEL_CHROMIUM_PATH ?? (existsSync(playwrightExecutable) ? playwrightExecutable : undefined);
const extensionChannel = "babel_content_clipper.v1";

type RuntimeError = { readonly code?: string; readonly message?: string };
type RuntimeResponse<T = unknown> = { readonly ok: boolean; readonly result?: T; readonly error?: RuntimeError };
type CaptureListItem = { readonly captureId: string; readonly kind: string; readonly preview: string; readonly state: string };
type CaptureList = { readonly records: readonly CaptureListItem[] };
type Attachment = { readonly attachmentId: string; readonly kind: string; readonly mimeType: string; readonly byteLength: number; readonly dataAvailable: boolean; readonly status: string };
type CaptureDetail = {
  readonly capture: {
    readonly captureId: string;
    readonly kind: string;
    readonly state: string;
    readonly source: { readonly pageUrl: string; readonly title: string };
    readonly selection: Record<string, unknown>;
    readonly assetsState: string;
    readonly attachmentIds: readonly string[];
    readonly integrity: { readonly status: string; readonly missing: readonly string[] };
  };
  readonly attachments: readonly Attachment[];
};

async function launchContext(label: string): Promise<{ context: BrowserContext; profile: string }> {
  await mkdir(evidencePath, { recursive: true });
  const profile = resolve(evidencePath, `profile-reader-boundaries-${label}-${Date.now()}`);
  const context = await chromium.launchPersistentContext(profile, {
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-sandbox",
      "--mute-audio",
    ],
  });
  return { context, profile };
}

async function extensionId(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ "babel_content_clipper.locale.v1": "zh-CN" }));
  return new URL(worker.url()).hostname;
}

async function extensionPage(context: BrowserContext, id: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("button", { name: "粘贴导入" })).toBeVisible();
  await page.locator(".loading-state, .skeleton-row").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
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

async function selectText(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    return selection?.toString().trim() ?? "";
  });
}

async function clickCaptureAction(sidepanel: Page, selector: string): Promise<string> {
  await sidepanel.evaluate((buttonSelector) => {
    const button = document.querySelector<HTMLButtonElement>(buttonSelector);
    if (!button) throw new Error(`missing sidepanel action ${buttonSelector}`);
    button.click();
  }, selector);
  await sidepanel.waitForTimeout(80);
  await expect.poll(() => sidepanel.locator("#capture-status").innerText(), { timeout: 20_000 }).not.toContain("正在");
  return sidepanel.locator("#capture-status").innerText();
}

async function rawCaptureSelectionAction(sidepanel: Page): Promise<RuntimeResponse> {
  return sidepanel.evaluate((channel) => new Promise<RuntimeResponse>((resolve) => {
    chrome.runtime.sendMessage({ channel, type: "action", action: "capture-selection" }, (value: RuntimeResponse) => resolve(value));
  }), extensionChannel);
}

async function listAll(page: Page): Promise<CaptureList> {
  return core<CaptureList>(page, "capture.list", { view: "all", limit: 200 });
}

async function saveEvidence(name: string, value: unknown): Promise<void> {
  await mkdir(evidencePath, { recursive: true });
  await writeFile(resolve(evidencePath, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function attachmentBytes(page: Page, attachmentId: string): Promise<{ readonly byteLength: number; readonly prefix: number[] }> {
  return page.evaluate(async (id) => {
    const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
      value.onerror = () => reject(value.error);
      value.onsuccess = () => resolve(value.result);
    });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("babel-content-clipper");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => resolve(open.result);
    });
    const transaction = database.transaction(["attachmentChunks"], "readonly");
    const chunks = await request<Array<{ readonly offset: number; readonly byteLength: number; readonly data: ArrayBuffer }>>(
      transaction.objectStore("attachmentChunks").index("by-attachment").getAll(id),
    );
    chunks.sort((left, right) => left.offset - right.offset);
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(new Uint8Array(chunk.data), offset);
      offset += chunk.byteLength;
    }
    return { byteLength: bytes.byteLength, prefix: [...bytes.slice(0, 8)] };
  }, attachmentId);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

test("阅读器原生划词与焦点正常，清空或换章不会保存旧章选区", async () => {
  const run = await launchContext("reader-selection");
  try {
    const id = await extensionId(run.context);
    const sidepanel = await extensionPage(run.context, id);
    const reader = await run.context.newPage();
    await reader.goto(`${fixtureOrigin}/reader.html`);
    await reader.waitForLoadState("domcontentloaded");

    const firstText = await selectText(reader, "#text");
    expect(firstText).toContain("第一章的选中文字");
    await expect(reader.locator("#menu")).toBeVisible();
    await reader.locator("#annotate").click();
    await expect(reader.locator("#notice")).toContainText("原阅读器批注操作正常");
    expect(await reader.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("annotate");

    await reader.locator("#text").click();
    await reader.locator("#clear").click();
    expect(await reader.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
    await reader.bringToFront();
    const clearedStatus = await clickCaptureAction(sidepanel, "#capture-selection");
    expect(clearedStatus).toMatch(/选区|SELECTION_EMPTY|没有取得|重新选择/iu);
    expect((await listAll(sidepanel)).records).toHaveLength(0);

    await selectText(reader, "#text");
    await reader.locator("#next").click();
    await expect(reader).toHaveURL(/reader\.html\?chapter=two$/);
    await reader.bringToFront();
    const staleStatus = await clickCaptureAction(sidepanel, "#capture-selection");
    expect(staleStatus).toMatch(/选区|SELECTION_EMPTY|没有取得|重新选择/iu);
    expect((await listAll(sidepanel)).records).toHaveLength(0);

    const secondText = await selectText(reader, "#text");
    expect(secondText).toContain("第二章有新的内容");
    await reader.bringToFront();
    const secondStatus = await clickCaptureAction(sidepanel, "#capture-selection");
    expect(secondStatus).toMatch(/保存|内容/iu);
    const records = await listAll(sidepanel);
    expect(records.records).toHaveLength(1);
    const detail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: records.records[0]?.captureId });
    expect(detail.capture.selection.exact).toBe(secondText);
    expect(detail.capture.selection.exact).not.toContain("第一章");
    expect(detail.capture.source.pageUrl).toContain("reader.html?chapter=two");
    await sidepanel.screenshot({ path: resolve(evidencePath, "reader-selection-focus-and-chapter.png"), fullPage: true });
    await saveEvidence("reader-selection-focus-and-chapter.json", {
      fixture: "reader.html",
      nativeSelectionMenu: { visible: true, annotateMessage: "原阅读器批注操作正常", annotateFocused: true },
      clearSelection: { status: clearedStatus, captureCount: 0 },
      staleChapter: { status: staleStatus, captureCountBeforeSecondChapter: 0 },
      secondChapter: { status: secondStatus, captureId: detail.capture.captureId, exactTextLength: String(detail.capture.selection.exact ?? "").length, sourceUrl: detail.capture.source.pageUrl },
    });
  } finally {
    await run.context.close();
  }
});

test("Canvas 只保存 PNG 截图；404 图片和十图预算保留引用与缺失事实", async () => {
  const run = await launchContext("capture-boundaries");
  try {
    const id = await extensionId(run.context);
    const sidepanel = await extensionPage(run.context, id);
    const boundaries = await run.context.newPage();
    await boundaries.goto(`${fixtureOrigin}/capture-boundaries.html`);
    await boundaries.waitForLoadState("domcontentloaded");

    const canvas = boundaries.locator("#canvas-only");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas bounds unavailable");
    await boundaries.bringToFront();
    const regionAction = clickCaptureAction(sidepanel, "#capture-region");
    await expect(boundaries.locator('[role="application"]')).toBeVisible({ timeout: 5_000 });
    await boundaries.mouse.move(box.x + 12, box.y + 14);
    await boundaries.mouse.down();
    await boundaries.mouse.move(box.x + 242, box.y + 116, { steps: 5 });
    await boundaries.mouse.up();
    const regionStatus = await regionAction;
    expect(regionStatus).toMatch(/截图|保存/iu);
    const regionRows = await listAll(sidepanel);
    const regionRow = [...regionRows.records].reverse().find(row => row.kind === "region_capture");
    if (!regionRow) throw new Error("Canvas region capture missing");
    const regionDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: regionRow.captureId });
    expect(regionDetail.capture.kind).toBe("region_capture");
    expect(regionDetail.capture.selection.type).toBe("region");
    expect(regionDetail.capture.selection.exact).toBeUndefined();
    expect(regionDetail.attachments).toHaveLength(1);
    expect(regionDetail.attachments[0]).toMatchObject({ kind: "screen_region", mimeType: "image/png", status: "complete", dataAvailable: true });
    const pngAttachment = regionDetail.attachments[0];
    if (!pngAttachment) throw new Error("Canvas attachment missing");
    const pngBytes = await attachmentBytes(sidepanel, pngAttachment.attachmentId);
    expect(pngBytes.byteLength).toBeGreaterThan(0);
    expect(pngBytes.byteLength).toBe(pngAttachment.byteLength);
    expect(pngBytes.prefix).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const missingText = await selectText(boundaries, "#missing-image-selection");
    expect(missingText).toContain("无法取得字节");
    await boundaries.bringToFront();
    const missingStatus = await clickCaptureAction(sidepanel, "#capture-selection");
    expect(missingStatus).toMatch(/图片|缺失|引用|不可用|部分/iu);
    const missingRows = await listAll(sidepanel);
    const missingRow = [...missingRows.records].reverse().find(row => row.kind === "mixed_selection");
    if (!missingRow) throw new Error("404 mixed selection capture missing");
    const missingDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: missingRow.captureId });
    expect(String(missingDetail.capture.selection.exact ?? "")).toContain("无法取得字节");
    expect(missingDetail.capture.selection.sanitizedHtml).toContain("故意不存在的测试图片");
    expect(missingDetail.capture.integrity.status).toBe("partial");
    expect(missingDetail.capture.integrity.missing).toContain("image_bytes");
    const missingMetadata = objectValue(objectValue(missingDetail.capture.selection.locator).metadata);
    expect(missingMetadata.failedImageFetchCount).toBe(1);
    expect(missingMetadata.unsavedImageByteCount).toBeGreaterThanOrEqual(1);

    const manyText = await selectText(boundaries, "#many-images-selection");
    expect(manyText).toContain("十张不同 URL");
    await boundaries.bringToFront();
    const manyStatus = await clickCaptureAction(sidepanel, "#capture-selection");
    expect(manyStatus).toMatch(/图片|部分|保存/iu);
    const manyRows = await listAll(sidepanel);
    const manyRow = [...manyRows.records].reverse().find(row => row.kind === "mixed_selection" && row.captureId !== missingRow.captureId);
    if (!manyRow) throw new Error("ten-image mixed selection capture missing");
    const manyDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: manyRow.captureId });
    const manySelection = manyDetail.capture.selection;
    const manyMetadata = objectValue(objectValue(manySelection.locator).metadata);
    expect(manySelection.sanitizedHtml).toContain("预算图片 1");
    expect(manySelection.sanitizedHtml).toContain("预算图片 10");
    expect(manyMetadata.selectedImageCount).toBe(10);
    expect(manyMetadata.preservedImageReferenceCount).toBe(10);
    expect(manyMetadata.imageFetchLimit).toBe(8);
    expect(manyMetadata.savedImageByteCount).toBe(8);
    expect(manyMetadata.skippedImageFetchCount).toBe(2);
    expect(manyMetadata.unsavedImageByteCount).toBe(2);
    expect(manyDetail.capture.integrity.status).toBe("partial");
    expect(manyDetail.capture.integrity.missing).toContain("image_fetch_limit");
    expect(manyDetail.attachments).toHaveLength(8);
    expect(manyDetail.attachments.every(attachment => attachment.dataAvailable && attachment.byteLength > 0)).toBe(true);

    await boundaries.screenshot({ path: resolve(evidencePath, "reader-boundaries-canvas-images.png"), fullPage: true });
    await sidepanel.screenshot({ path: resolve(evidencePath, "reader-boundaries-capture-status.png"), fullPage: true });
    await saveEvidence("reader-boundaries-canvas-images.json", {
      fixture: "capture-boundaries.html",
      canvas: {
        status: regionStatus,
        captureId: regionDetail.capture.captureId,
        selectionType: regionDetail.capture.selection.type,
        originalTextClaimed: false,
        attachment: { mimeType: pngAttachment.mimeType, byteLength: pngAttachment.byteLength, returnedBytes: pngBytes.byteLength, pngSignature: pngBytes.prefix },
      },
      missingImage: {
        status: missingStatus,
        captureId: missingDetail.capture.captureId,
        integrity: missingDetail.capture.integrity,
        metadata: { selectedImageCount: missingMetadata.selectedImageCount, failedImageFetchCount: missingMetadata.failedImageFetchCount, unsavedImageByteCount: missingMetadata.unsavedImageByteCount },
        visibleWarning: /图片|缺失|引用|不可用|部分/iu.test(missingStatus),
      },
      tenImageBudget: {
        status: manyStatus,
        captureId: manyDetail.capture.captureId,
        selectedImageCount: manyMetadata.selectedImageCount,
        preservedImageReferenceCount: manyMetadata.preservedImageReferenceCount,
        savedImageByteCount: manyMetadata.savedImageByteCount,
        skippedImageFetchCount: manyMetadata.skippedImageFetchCount,
        integrity: manyDetail.capture.integrity,
        attachmentCount: manyDetail.attachments.length,
        allPersistedAttachmentsHaveBytes: manyDetail.attachments.every(attachment => attachment.dataAvailable && attachment.byteLength > 0),
      },
    });
  } finally {
    await run.context.close();
  }
});

test("受限 chrome 页面给出明确不可采集提示，不冒充普通选区", async () => {
  const run = await launchContext("restricted-page");
  try {
    const id = await extensionId(run.context);
    const sidepanel = await extensionPage(run.context, id);
    const restricted = await run.context.newPage();
    await restricted.goto("chrome://version/").catch(() => undefined);
    if (!restricted.url().startsWith("chrome://version")) {
      await saveEvidence("reader-boundaries-restricted.json", { page: restricted.url(), result: "browser_refused_restricted_fixture_navigation" });
      test.info().annotations.push({ type: "unavailable", description: `Chromium did not expose chrome://version (current URL ${restricted.url()})` });
      return;
    }
    await restricted.bringToFront();
    const status = await clickCaptureAction(sidepanel, "#capture-selection");
    expect(status).toContain("当前页面受浏览器保护，扩展无法读取内容");
    const raw = await rawCaptureSelectionAction(sidepanel);
    expect(raw.ok).toBe(false);
    expect(raw.error?.code).toBe("PAGE_ACCESS_RESTRICTED");
    expect((await listAll(sidepanel)).records).toHaveLength(0);
    await saveEvidence("reader-boundaries-restricted.json", { page: restricted.url(), status, rawCode: raw.error?.code, captureCount: 0, explicitBoundary: true });
  } finally {
    await run.context.close();
  }
});
