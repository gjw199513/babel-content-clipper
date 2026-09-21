import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const fixtureOrigin = "http://127.0.0.1:4179";
const extensionPath = resolve(process.cwd(), "dist/extension");
const evidencePath = resolve(process.cwd(), ".hallmark/browser-evidence");
const playwrightExecutable = chromium.executablePath();
const chromiumExecutable = process.env.BABEL_CHROMIUM_PATH ?? (existsSync(playwrightExecutable) ? playwrightExecutable : undefined);
const extensionChannel = "babel_content_clipper.v1";

type RuntimeResponse<T = unknown> = {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: { readonly code?: string; readonly message?: string };
};

type CaptureList = {
  readonly records: Array<{
    readonly captureId: string;
    readonly kind: string;
    readonly title: string;
    readonly preview: string;
    readonly state: string;
    readonly latestJobStatus?: string;
  }>;
};

type CaptureDetail = {
  readonly capture: {
    readonly captureId: string;
    readonly kind: string;
    readonly state: string;
    readonly source: {
      readonly title: string;
      readonly pageUrl: string;
      readonly site: string;
      readonly metadata?: Record<string, unknown>;
    };
    readonly selection: Record<string, unknown>;
    readonly padding: { readonly beforeSeconds: number; readonly afterSeconds: number };
    readonly plannedAcquisitionRanges: readonly { readonly start: number; readonly end: number }[];
    readonly assetsState: string;
    readonly attachmentIds: readonly string[];
    readonly integrity: { readonly status: string; readonly missing: readonly string[] };
  };
  readonly attachments: Array<Record<string, unknown>>;
};

async function launchContext(label: string): Promise<{ context: BrowserContext; profile: string }> {
  await mkdir(evidencePath, { recursive: true });
  const profile = resolve(evidencePath, `profile-capture-${label}-${Date.now()}`);
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

async function extensionPage(context: BrowserContext, id: string, path: "library.html" | "sidepanel.html"): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/${path}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("button", { name: "粘贴导入" })).toBeVisible();
  await page.locator(".loading-state, .skeleton-row").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  return page;
}

async function core<T = unknown>(page: Page, method: string, params: unknown): Promise<T> {
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

async function action(page: Page, name: "capture-selection" | "capture-region" | "toggle-media-capture"): Promise<RuntimeResponse> {
  return page.evaluate(
    ({ channel, actionName }) => new Promise<RuntimeResponse>((resolve) => {
      chrome.runtime.sendMessage({ channel, type: "action", action: actionName, recordLive: false }, (value: RuntimeResponse) => resolve(value));
    }),
    { channel: extensionChannel, actionName: name },
  );
}

async function activeTabUrl(page: Page): Promise<string> {
  return page.evaluate(() => new Promise<string>((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => resolve(tabs[0]?.url ?? ""));
  }));
}

async function clickMediaActionFromSidepanel(
  sidepanel: Page,
  media: Page,
  recordLive?: boolean,
): Promise<string> {
  await media.bringToFront();
  await expect.poll(() => activeTabUrl(sidepanel), { timeout: 5_000 }).toContain("/media.html");
  await sidepanel.evaluate((shouldRecordLive) => {
    const checkbox = document.querySelector<HTMLInputElement>("#record-live");
    if (shouldRecordLive !== undefined && checkbox) checkbox.checked = shouldRecordLive;
    document.querySelector<HTMLButtonElement>("#capture-media")?.click();
  }, recordLive);
  await sidepanel.waitForTimeout(25);
  await expect.poll(() => sidepanel.locator("#capture-status").innerText(), { timeout: 15_000 }).not.toContain("正在读取媒体状态");
  await expect.poll(() => activeTabUrl(sidepanel), { timeout: 5_000 }).toContain("/media.html");
  return sidepanel.locator("#capture-status").innerText();
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

async function listAll(page: Page): Promise<CaptureList> {
  return core<CaptureList>(page, "capture.list", { view: "all", limit: 200 });
}

async function attachmentFacts(page: Page, attachmentId: string): Promise<{
  readonly metadata: Record<string, unknown>;
  readonly bytesLength: number;
  readonly bytesPrefix: number[];
  readonly sha256: string;
  readonly textPrefix: string;
  readonly pngDimensions?: { readonly width: number; readonly height: number };
}> {
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
    const transaction = database.transaction(["attachments", "attachmentChunks"], "readonly");
    const metadata = await request<Record<string, unknown> | undefined>(transaction.objectStore("attachments").get(id));
    if (!metadata) throw new Error("attachment metadata missing");
    const chunks = await request<Array<{ readonly offset: number; readonly byteLength: number; readonly data: ArrayBuffer }>>(
      transaction.objectStore("attachmentChunks").index("by-attachment").getAll(id),
    );
    chunks.sort((left, right) => left.offset - right.offset);
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(new Uint8Array(chunk.data), cursor);
      cursor += chunk.byteLength;
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const pngDimensions = bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      ? { width: new DataView(bytes.buffer).getUint32(16), height: new DataView(bytes.buffer).getUint32(20) }
      : undefined;
    return {
      metadata,
      bytesLength: bytes.byteLength,
      bytesPrefix: [...bytes.slice(0, 24)],
      sha256,
      textPrefix: new TextDecoder().decode(bytes.slice(0, 96)),
      ...(pngDimensions ? { pngDimensions } : {}),
    };
  }, attachmentId);
}

async function selectLibraryRow(page: Page, expectedText: string): Promise<void> {
  const rows = page.locator(".library-row");
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    await row.click();
    if ((await page.locator("#detail").innerText()).includes(expectedText)) return;
  }
  throw new Error(`library row containing ${expectedText} was not found`);
}

async function waitForMediaRow(page: Page, count: number): Promise<void> {
  await expect(page.locator(".library-row")).toHaveCount(count, { timeout: 15_000 });
}

test("mixed image selection and region capture persist real attachment bytes and scope", async () => {
  const run = await launchContext("image-region");
  const evidence: Record<string, unknown> = {
    fixture: "article.html",
    imageCapture: "selection action plus IndexedDB attachmentChunks byte inspection",
    regionCapture: "capture-region action plus real pointer drag and PNG IHDR inspection",
  };
  try {
    const id = await extensionId(run.context);
    const article = await run.context.newPage();
    await article.goto(`${fixtureOrigin}/article.html`);
    await article.waitForLoadState("domcontentloaded");
    await article.waitForTimeout(500);
    const sidepanel = await extensionPage(run.context, id, "sidepanel.html");
    const library = await extensionPage(run.context, id, "library.html");

    await selectText(article, "#mixed");
    await article.bringToFront();
    const mixedResponse = await action(sidepanel, "capture-selection");
    expect(mixedResponse.ok).toBe(true);
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1);
    const mixedRows = await listAll(sidepanel);
    const mixedRecord = mixedRows.records.find((record) => record.kind === "mixed_selection");
    if (!mixedRecord) throw new Error("mixed selection record missing");
    const mixedDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: mixedRecord.captureId });
    expect(mixedDetail.capture.kind).toBe("mixed_selection");
    expect(mixedDetail.capture.assetsState).toBe("saved");
    expect(mixedDetail.capture.integrity).toEqual({ status: "complete_selection", missing: [] });
    expect(mixedDetail.capture.selection.type).toBe("text");
    expect(mixedDetail.capture.selection.sanitizedHtml).toContain("<img");
    expect(mixedDetail.capture.selection.sanitizedHtml).toContain("三段资料流向个人素材库");
    expect(mixedDetail.capture.attachmentIds).toHaveLength(1);
    expect(mixedDetail.attachments).toHaveLength(1);
    expect(mixedDetail.attachments[0]).toMatchObject({ kind: "source_image", mimeType: "image/svg+xml", status: "complete", dataAvailable: true });
    const mixedAttachmentId = mixedDetail.capture.attachmentIds[0];
    if (!mixedAttachmentId) throw new Error("mixed image attachment id missing");
    const mixedBytes = await attachmentFacts(sidepanel, mixedAttachmentId);
    expect(mixedBytes.bytesLength).toBeGreaterThan(0);
    expect(mixedBytes.bytesLength).toBe(mixedDetail.attachments[0]?.byteLength);
    expect(mixedBytes.metadata).toMatchObject({ mimeType: "image/svg+xml", byteLength: mixedBytes.bytesLength, expectedTotalBytes: mixedBytes.bytesLength });
    expect(mixedBytes.textPrefix.trimStart().startsWith("<svg") || mixedBytes.textPrefix.trimStart().startsWith("<?xml")).toBe(true);
    await library.reload();
    await library.waitForLoadState("domcontentloaded");
    await waitForMediaRow(library, 1);
    await library.locator(".library-row").click();
    await expect(library.locator("#detail")).toContainText("图文选区同时包含");
    await expect(library.locator("#detail")).toContainText("image/svg+xml");
    await expect(library.locator("#detail")).toContainText("数据可用");
    await library.screenshot({ path: resolve(evidencePath, "capture-mixed-detail.png"), fullPage: true });

    await article.bringToFront();
    const regionAction = action(sidepanel, "capture-region");
    await article.locator('[role="application"]').waitFor();
    const regionStart = { x: 80, y: 120 };
    const regionEnd = { x: 300, y: 300 };
    await article.mouse.move(regionStart.x, regionStart.y);
    await article.mouse.down();
    await article.mouse.move(regionEnd.x, regionEnd.y, { steps: 5 });
    await article.mouse.up();
    const regionResponse = await regionAction;
    expect(regionResponse.ok).toBe(true);
    await expect(sidepanel.locator(".capture-row")).toHaveCount(2);
    const regionRows = await listAll(sidepanel);
    const regionRecord = regionRows.records.find((record) => record.kind === "region_capture");
    if (!regionRecord) throw new Error("region capture record missing");
    const regionDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: regionRecord.captureId });
    expect(regionDetail.capture.selection).toMatchObject({ type: "region", x: 80, y: 120, width: 220, height: 180, devicePixelRatio: 1 });
    expect(regionDetail.capture.integrity).toEqual({ status: "complete_selection", missing: [] });
    expect(regionDetail.capture.assetsState).toBe("saved");
    expect(regionDetail.attachments).toHaveLength(1);
    expect(regionDetail.attachments[0]).toMatchObject({ kind: "screen_region", mimeType: "image/png", status: "complete", dataAvailable: true });
    const regionAttachmentId = regionDetail.capture.attachmentIds[0];
    if (!regionAttachmentId) throw new Error("region attachment id missing");
    const regionBytes = await attachmentFacts(sidepanel, regionAttachmentId);
    expect(regionBytes.bytesLength).toBeGreaterThan(0);
    expect(regionBytes.bytesLength).toBe(regionDetail.attachments[0]?.byteLength);
    expect(regionBytes.bytesPrefix.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(regionBytes.pngDimensions).toEqual({ width: 220, height: 180 });
    await selectLibraryRow(library, "区域");
    await expect(library.locator("#detail")).toContainText("220 × 180");
    await expect(library.locator("#detail")).toContainText("image/png");
    await library.screenshot({ path: resolve(evidencePath, "capture-region-detail.png"), fullPage: true });

    evidence.image = {
      kind: mixedDetail.capture.kind,
      integrity: mixedDetail.capture.integrity,
      attachment: { mimeType: mixedBytes.metadata.mimeType, bytesLength: mixedBytes.bytesLength, sha256: mixedBytes.sha256, dataAvailable: mixedDetail.attachments[0]?.dataAvailable, status: mixedDetail.attachments[0]?.status },
      sanitizedHtmlContainsImage: true,
    };
    evidence.region = {
      selection: regionDetail.capture.selection,
      integrity: regionDetail.capture.integrity,
      attachment: { mimeType: regionBytes.metadata.mimeType, bytesLength: regionBytes.bytesLength, sha256: regionBytes.sha256, pngDimensions: regionBytes.pngDimensions, dataAvailable: regionDetail.attachments[0]?.dataAvailable, status: regionDetail.attachments[0]?.status },
    };
    await writeFile(resolve(evidencePath, "capture-image-region-summary.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  } finally {
    await run.context.close();
  }
});

test("media timeline preserves target, events, padding snapshots, and interrupted facts", async () => {
  const run = await launchContext("media");
  const evidence: Record<string, unknown> = {
    fixture: "media.html with sample.webm (30.008s VP9/Opus; all playback muted)",
    liveRecording: false,
  };
  try {
    const id = await extensionId(run.context);
    const media = await run.context.newPage();
    await media.goto(`${fixtureOrigin}/media.html`);
    await media.waitForLoadState("domcontentloaded");
    await expect.poll(async () => await media.locator("#main-video").evaluate((element) => (element as HTMLVideoElement).readyState)).toBeGreaterThan(0);
    await media.locator("#main-video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      video.currentTime = 2;
      video.pause();
    });
    const sidepanel = await extensionPage(run.context, id, "sidepanel.html");
    const library = await extensionPage(run.context, id, "library.html");

    await media.bringToFront();
    const started = await action(sidepanel, "toggle-media-capture");
    expect(started.ok).toBe(true);
    const firstCaptureId = typeof started.result === "object" && started.result && "captureId" in started.result
      ? String((started.result as { captureId: unknown }).captureId)
      : "";
    expect(firstCaptureId).toMatch(/^cap_/);

    await media.locator("#main-video").evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      await video.play();
    });
    await media.waitForTimeout(1_050);
    await media.locator("#main-video").evaluate((element) => (element as HTMLVideoElement).pause());
    await media.waitForTimeout(350);
    await media.locator("#seek-back").click();
    await media.waitForTimeout(450);
    await media.locator("#main-video").evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      await video.play();
    });
    await media.waitForTimeout(900);
    await media.locator("#main-video").evaluate((element) => (element as HTMLVideoElement).pause());
    await media.waitForTimeout(350);
    await media.locator("#seek-forward").click();
    await media.waitForTimeout(450);
    await media.locator("#speed").click();
    await media.locator("#audio").evaluate(async (element) => {
      const audio = element as HTMLAudioElement;
      audio.muted = true;
      audio.volume = 0;
      await audio.play().catch(() => undefined);
    });
    await media.locator("#main-video").evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      await video.play();
    });
    await media.waitForTimeout(900);
    await media.locator("#main-video").evaluate((element) => (element as HTMLVideoElement).pause());
    await media.locator("#audio").evaluate((element) => (element as HTMLAudioElement).pause());
    await media.waitForTimeout(350);
    await media.locator("#seek-back").click();
    await media.waitForTimeout(450);
    await media.locator("#main-video").evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      await video.play();
    });
    await media.waitForTimeout(650);
    await media.locator("#main-video").evaluate((element) => (element as HTMLVideoElement).pause());
    await media.waitForTimeout(350);
    await media.bringToFront();
    const ended = await action(sidepanel, "toggle-media-capture");
    expect(ended.ok).toBe(true);
    await media.waitForTimeout(750);

    const firstDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: firstCaptureId });
    const firstSelection = firstDetail.capture.selection;
    expect(firstDetail.capture.kind).toBe("media_range");
    expect(firstDetail.capture.state).toBe("sealed");
    expect(firstDetail.capture.source.metadata?.targetId).toBe("video-0");
    expect(firstDetail.capture.source.metadata?.mediaType).toBe("video");
    expect(firstSelection.type).toBe("media");
    expect(firstSelection.endClick).toBeDefined();
    const mediaEvents = Array.isArray(firstSelection.events) ? firstSelection.events as Array<Record<string, unknown>> : [];
    const mediaSegments = Array.isArray(firstSelection.segments) ? firstSelection.segments as Array<{ start: number; end: number }> : [];
    const normalizedSegments = Array.isArray(firstSelection.normalizedSegments) ? firstSelection.normalizedSegments as Array<{ start: number; end: number }> : [];
    expect(mediaEvents.some((event) => event.type === "pause")).toBe(true);
    expect(mediaEvents.some((event) => event.type === "resume")).toBe(true);
    expect(mediaEvents.filter((event) => event.type === "seek").length).toBeGreaterThanOrEqual(2);
    expect(mediaEvents.some((event) => event.type === "rate_change" && event.playbackRate === 2)).toBe(true);
    expect(mediaEvents.some((event) => event.type === "end")).toBe(true);
    expect(mediaSegments.length).toBeGreaterThan(1);
    expect(normalizedSegments.length).toBeGreaterThan(0);
    const forwardSeek = mediaEvents.find((event) => event.type === "seek" && typeof event.mediaSeconds === "number" && (event.mediaSeconds as number) >= 17);
    const previousPause = mediaEvents.filter((event) => event.type === "pause" && typeof event.mediaSeconds === "number" && (event.mediaSeconds as number) < 17).at(-1);
    const forwardGapFilled = Boolean(
      forwardSeek && previousPause && normalizedSegments.some((range) => range.start <= (previousPause.mediaSeconds as number) + 0.6 && range.end >= (forwardSeek.mediaSeconds as number) - 0.6),
    );
    const distinctForwardRangeObserved = Boolean(
      forwardSeek && normalizedSegments.some((range) => range.start >= (forwardSeek.mediaSeconds as number) - 0.6),
    );
    const overlappingRanges = normalizedSegments.filter((range, index) => normalizedSegments.slice(index + 1).some((other) => range.start <= other.end && other.start <= range.end));
    expect(overlappingRanges).toHaveLength(0);

    await library.locator("#settings").click();
    await expect(library.locator(".settings-form")).toBeVisible();
    await library.locator('.settings-form input[name="paddingBeforeSeconds"]').fill("3");
    await library.locator('.settings-form input[name="paddingAfterSeconds"]').fill("4");
    await library.locator(".settings-form").getByRole("button", { name: "保存设置" }).click();
    await expect(library.locator("#toast")).toContainText("设置已保存");
    const oldAfterSettings = await core<CaptureDetail>(library, "capture.get", { captureId: firstCaptureId });
    expect(oldAfterSettings.capture.padding).toEqual({ beforeSeconds: 10, afterSeconds: 10 });
    await library.getByRole("button", { name: "返回素材库" }).click();
    await expect(library.locator(".settings-form")).toBeHidden();
    await expect(library.locator(".library-list")).toBeVisible();

    await media.locator("#main-video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      video.currentTime = 1;
      video.pause();
    });
    await media.bringToFront();
    const secondStart = await action(sidepanel, "toggle-media-capture");
    expect(secondStart.ok).toBe(true);
    await media.waitForTimeout(250);
    await media.bringToFront();
    const secondEnd = await action(sidepanel, "toggle-media-capture");
    expect(secondEnd.ok).toBe(true);
    await media.waitForTimeout(650);
    const secondCaptureId = typeof secondStart.result === "object" && secondStart.result && "captureId" in secondStart.result
      ? String((secondStart.result as { captureId: unknown }).captureId)
      : "";
    const secondDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: secondCaptureId });
    expect(secondDetail.capture.padding).toEqual({ beforeSeconds: 3, afterSeconds: 4 });
    await library.reload();
    await library.waitForLoadState("domcontentloaded");
    await waitForMediaRow(library, 2);
    await selectLibraryRow(library, "30 秒公开测试媒体");
    await expect(library.locator("#detail")).toContainText("观测区间");
    await expect(library.locator("#detail")).toContainText("真实起点");
    await library.screenshot({ path: resolve(evidencePath, "capture-media-detail.png"), fullPage: true });

    const interruptedMedia = await run.context.newPage();
    await interruptedMedia.goto(`${fixtureOrigin}/media.html`);
    await interruptedMedia.waitForLoadState("domcontentloaded");
    await interruptedMedia.locator("#main-video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      video.currentTime = 8;
      video.pause();
    });
    await interruptedMedia.bringToFront();
    const interruptedStart = await action(sidepanel, "toggle-media-capture");
    expect(interruptedStart.ok).toBe(true);
    const interruptedCaptureId = typeof interruptedStart.result === "object" && interruptedStart.result && "captureId" in interruptedStart.result
      ? String((interruptedStart.result as { captureId: unknown }).captureId)
      : "";
    await interruptedMedia.locator("#main-video").evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      await video.play();
    });
    await interruptedMedia.waitForTimeout(600);
    await interruptedMedia.locator("#main-video").evaluate((element) => (element as HTMLVideoElement).pause());
    await interruptedMedia.close();
    await expect.poll(async () => (await listAll(sidepanel)).records.some((record) => record.captureId === interruptedCaptureId && record.state === "interrupted"), { timeout: 15_000 }).toBe(true);
    const interruptedDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: interruptedCaptureId });
    const interruptedSelection = interruptedDetail.capture.selection;
    const interruptedEvents = Array.isArray(interruptedSelection.events) ? interruptedSelection.events as Array<Record<string, unknown>> : [];
    expect(interruptedDetail.capture.state).toBe("interrupted");
    expect(interruptedSelection.endClick).toBeUndefined();
    expect(interruptedDetail.capture.integrity.status).toBe("needs_completion");
    expect(interruptedDetail.capture.integrity.missing).toContain("end_click");
    expect(interruptedEvents.some((event) => event.type === "end")).toBe(false);
    await library.reload();
    await library.waitForLoadState("domcontentloaded");
    await waitForMediaRow(library, 3);
    await selectLibraryRow(library, "已中断");
    await expect(library.locator("#detail")).toContainText("已中断");
    // The core integrity contract keeps the raw enum above; the rendered
    // detail panel presents its localized label to users.
    await expect(library.locator("#detail")).toContainText("终点点击");
    await library.screenshot({ path: resolve(evidencePath, "capture-interrupted-detail.png"), fullPage: true });

    evidence.media = {
      captureTarget: firstDetail.capture.source.metadata?.targetId,
      sourceMetadata: firstDetail.capture.source.metadata,
      paddingOld: oldAfterSettings.capture.padding,
      paddingNew: secondDetail.capture.padding,
      events: mediaEvents,
      rawSegments: mediaSegments,
      normalizedSegments,
      plannedAcquisitionRanges: firstDetail.capture.plannedAcquisitionRanges,
      forwardSeek: forwardSeek?.mediaSeconds,
      previousPause: previousPause?.mediaSeconds,
      forwardGapFilled,
      distinctForwardRangeObserved,
      sameRevisitMerged: normalizedSegments.length === 1 || overlappingRanges.length === 0,
    };
    evidence.interrupted = {
      state: interruptedDetail.capture.state,
      endClickPresent: interruptedSelection.endClick !== undefined,
      integrity: interruptedDetail.capture.integrity,
      hasSyntheticEndEvent: interruptedEvents.some((event) => event.type === "end"),
    };
    await writeFile(resolve(evidencePath, "capture-media-summary.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

    // This is intentionally a hard assertion. A forward seek must leave a
    // gap in the observed source-time ranges; otherwise playback between the
    // prior pause and the jump target has been fabricated.
    expect(forwardGapFilled, `forward seek gap was filled; rawSegments=${JSON.stringify(mediaSegments)} normalized=${JSON.stringify(normalizedSegments)}`).toBe(false);
    expect(distinctForwardRangeObserved, `forward seek did not create a distinct observed range: ${JSON.stringify(normalizedSegments)}`).toBe(true);
  } finally {
    await run.context.close();
  }
});

test("sidepanel现场保存失败显示具体诊断并将单次开关消耗", async () => {
  const run = await launchContext("live-unavailable");
  const evidence: Record<string, unknown> = {
    fixture: "media.html",
    fixtureSetup: "headless tabCapture/offscreen recording is expected to be unavailable; this is a fixture setup, not real Agent processing.",
    launch: "independent headless persistent context with --mute-audio; media elements muted and volume=0",
    interaction: "media tab kept active; sidepanel #capture-media button dispatched through real runAction handler; no native gesture claimed",
  };
  try {
    const id = await extensionId(run.context);
    const media = await run.context.newPage();
    await media.goto(`${fixtureOrigin}/media.html`);
    await media.waitForLoadState("domcontentloaded");
    await expect.poll(async () => await media.locator("#main-video").evaluate((element) => (element as HTMLVideoElement).readyState)).toBeGreaterThan(0);
    await media.locator("#main-video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      video.currentTime = 2;
      video.pause();
    });
    await media.locator("#audio").evaluate((element) => {
      const audio = element as HTMLAudioElement;
      audio.muted = true;
      audio.volume = 0;
      audio.pause();
    });
    const sidepanel = await extensionPage(run.context, id, "sidepanel.html");

    const unavailableStatus = await clickMediaActionFromSidepanel(sidepanel, media, true);
    expect(unavailableStatus).toMatch(/未启动|失败|不可用|现场录制|RECORDER|PARTIAL|TAB_CAPTURE/u);
    expect(unavailableStatus).not.toContain("媒体标记操作已提交");
    await expect(sidepanel.locator("#record-live")).not.toBeChecked();
    await sidepanel.screenshot({ path: resolve(evidencePath, "capture-live-unavailable-status.png"), fullPage: true });

    await expect.poll(async () => (await listAll(sidepanel)).records.length, { timeout: 15_000 }).toBe(1);
    const firstRecord = (await listAll(sidepanel)).records.find((record) => record.kind === "media_range");
    if (!firstRecord) throw new Error("live-unavailable media capture row missing");
    const firstCaptureId = firstRecord.captureId;
    await expect.poll(async () => (await core<CaptureDetail>(sidepanel, "capture.get", { captureId: firstCaptureId })).capture.state, { timeout: 15_000 }).toBe("open");

    const endStatus = await clickMediaActionFromSidepanel(sidepanel, media);
    await expect.poll(async () => (await core<CaptureDetail>(sidepanel, "capture.get", { captureId: firstCaptureId })).capture.state, { timeout: 15_000 }).toBe("sealed");
    const failedLiveDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: firstCaptureId });
    const recordingAttachment = failedLiveDetail.attachments.find((attachment) => attachment.kind === "browser_recording");
    if (!recordingAttachment) throw new Error("failed live capture did not retain browser_recording attachment metadata");
    const recordingFailure = recordingAttachment.recordingFailure as Record<string, unknown> | undefined;
    const recordingAttachmentId = typeof recordingAttachment.attachmentId === "string" ? recordingAttachment.attachmentId : "";
    if (!recordingAttachmentId) throw new Error("failed live capture attachment id missing");
    const recordingBytes = await attachmentFacts(sidepanel, recordingAttachmentId);
    expect(recordingAttachment).toMatchObject({ kind: "browser_recording", status: "interrupted", storage: "chunked", dataAvailable: false, byteLength: 0 });
    expect(recordingBytes.bytesLength).toBe(0);
    expect(recordingBytes.metadata).toMatchObject({ byteLength: 0 });
    if (recordingBytes.metadata.expectedTotalBytes !== undefined) expect(recordingBytes.metadata.expectedTotalBytes).toBe(0);
    expect(recordingFailure).toMatchObject({ started: false });
    expect(typeof recordingFailure?.code).toBe("string");
    expect(String(recordingFailure?.code)).not.toHaveLength(0);
    expect(typeof recordingFailure?.message).toBe("string");
    expect(String(recordingFailure?.message)).not.toHaveLength(0);
    expect(["start", "stream", "chunk", "stop"]).toContain(recordingFailure?.stage);
    expect(recordingAttachment.recordingCoverage).toBeUndefined();
    expect(failedLiveDetail.capture.attachmentIds).toContain(recordingAttachment.attachmentId);
    expect(failedLiveDetail.capture.assetsState).toBe("partial_saved");
    expect(failedLiveDetail.capture.integrity.missing).toContain("complete_recording_coverage");

    await media.locator("#main-video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      video.currentTime = 1;
      video.pause();
    });
    const normalStartStatus = await clickMediaActionFromSidepanel(sidepanel, media);
    expect(normalStartStatus).toMatch(/媒体|标记/u);
    expect(normalStartStatus).not.toMatch(/未启动|失败|不可用|RECORDER|PARTIAL|TAB_CAPTURE/u);
    await expect(sidepanel.locator("#record-live")).not.toBeChecked();
    await expect.poll(async () => (await listAll(sidepanel)).records.length, { timeout: 15_000 }).toBe(2);
    const normalRecord = (await listAll(sidepanel)).records.find((record) => record.kind === "media_range" && record.captureId !== firstCaptureId);
    if (!normalRecord) throw new Error("normal media marker row missing after one-shot recording toggle");
    const normalCaptureId = normalRecord.captureId;
    await clickMediaActionFromSidepanel(sidepanel, media);
    await expect.poll(async () => (await core<CaptureDetail>(sidepanel, "capture.get", { captureId: normalCaptureId })).capture.state, { timeout: 15_000 }).toBe("sealed");
    const normalDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: normalCaptureId });
    expect(normalDetail.capture.assetsState).toBe("location_only");
    expect(normalDetail.capture.attachmentIds).toHaveLength(0);
    expect(normalDetail.attachments).toHaveLength(0);

    const library = await extensionPage(run.context, id, "library.html");
    await library.reload();
    await library.waitForLoadState("domcontentloaded");
    await waitForMediaRow(library, 2);
    await selectLibraryRow(library, "无录制字节，失败事实可用");
    // The attachment kind assertion above covers the raw API value; the
    // library detail uses the localized system label.
    await expect(library.locator("#detail")).toContainText("浏览器录制");
    await expect(library.locator("#detail")).toContainText("无录制字节，失败事实可用");
    await library.screenshot({ path: resolve(evidencePath, "capture-live-unavailable-detail.png"), fullPage: true });

    evidence.failedLive = {
      captureState: failedLiveDetail.capture.state,
      assetsState: failedLiveDetail.capture.assetsState,
      integrity: failedLiveDetail.capture.integrity,
      statusAfterStart: unavailableStatus,
      statusAfterEnd: endStatus,
      attachment: {
        kind: recordingAttachment.kind,
        status: recordingAttachment.status,
        storage: recordingAttachment.storage,
        dataAvailable: recordingAttachment.dataAvailable,
        byteLength: recordingAttachment.byteLength,
        persistedBytesLength: recordingBytes.bytesLength,
        recordingFailure,
        hasRecordingCoverage: recordingAttachment.recordingCoverage !== undefined,
      },
    };
    evidence.normalMarker = {
      captureState: normalDetail.capture.state,
      assetsState: normalDetail.capture.assetsState,
      attachmentCount: normalDetail.attachments.length,
      checkboxAfterStart: false,
      statusAfterStart: normalStartStatus,
    };
    evidence.libraryShowsMetadataOnly = true;
    await writeFile(resolve(evidencePath, "capture-live-unavailable-summary.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  } finally {
    await run.context.close();
  }
});
