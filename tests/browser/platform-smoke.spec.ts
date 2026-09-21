import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

type PlatformCase = {
  readonly id: "zhihu" | "icourse163" | "coursera";
  readonly url: string;
  readonly titleFragment: string;
  readonly textFragment: string;
  readonly preferImage: boolean;
  readonly limitation: string;
};

const platforms: readonly PlatformCase[] = [
  {
    id: "zhihu",
    url: "https://zhuanlan.zhihu.com/p/2045779736064947960",
    titleFragment: "AI 让写论文更高效了",
    textFragment: "AI 是你的帮手",
    preferImage: true,
    limitation: "未登录公开文章；知乎回答样本先验访问返回 403，因此使用公开专栏文章。",
  },
  {
    id: "icourse163",
    url: "https://www.icourse163.org/course/detail.htm?cid=47004",
    titleFragment: "大学计算机",
    textFragment: "课程概述",
    preferImage: false,
    limitation: "未登录公开课程详情页；课程正文提及视频资源，但本回归不把课程介绍或视频清单当作可播放视频。",
  },
  {
    id: "coursera",
    url: "https://www.coursera.org/learn/machine-learning",
    titleFragment: "Supervised Machine Learning",
    textFragment: "What you'll learn",
    preferImage: false,
    limitation: "未登录公开课程详情页；未播放任何视频，因此不宣称视频适配，可能存在课程访问/付费边界。",
  },
];

async function launchContext(label: string): Promise<{ context: BrowserContext; profile: string }> {
  await mkdir(evidencePath, { recursive: true });
  const profile = resolve(evidencePath, `profile-platform-${label}-${Date.now()}`);
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

async function extensionPage(context: BrowserContext, id: string, path: "sidepanel.html" | "library.html"): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/${path}`);
  await page.waitForLoadState("domcontentloaded");
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

async function captureSelection(sidepanel: Page): Promise<RuntimeResponse> {
  return sidepanel.evaluate(({ channel }) => new Promise<RuntimeResponse>((resolve) => {
    chrome.runtime.sendMessage({ channel, type: "action", action: "capture-selection", recordLive: false }, (value: RuntimeResponse) => resolve(value));
  }), { channel: extensionChannel });
}

async function selectReadableBlock(page: Page, preferImage: boolean): Promise<{
  readonly tagName: string;
  readonly textLength: number;
  readonly textPrefix: string;
  readonly exact: string;
  readonly selectedImageCount: number;
}> {
  return page.evaluate(({ preferImage }) => {
    const selectors = [
      "article",
      "main",
      "[role=main]",
      ".Post-RichText",
      ".RichContent-inner",
      ".course-info",
      ".course-detail",
      "body",
    ];
    const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    const readable = candidates.filter((element) => (element.textContent?.trim().length ?? 0) >= 80);
    const selected = readable.find((element) => {
      const imageCount = element.querySelectorAll("img").length;
      return preferImage ? imageCount > 0 : imageCount === 0;
    }) ?? readable[0] ?? document.body;
    if (!selected) throw new Error("public page has no readable selection target");
    const range = document.createRange();
    range.selectNodeContents(selected);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    const text = selection?.toString().trim() ?? "";
    return {
      tagName: selected.tagName,
      textLength: text.length,
      textPrefix: text.slice(0, 240),
      exact: text,
      selectedImageCount: selected.querySelectorAll("img").length,
    };
  }, { preferImage });
}

async function muteAndInspectMedia(page: Page): Promise<{
  readonly elements: Array<{ readonly tagName: string; readonly paused: boolean; readonly muted: boolean; readonly readyState: number }>;
  readonly assessment: string;
}> {
  return page.evaluate(() => {
    const elements = [...document.querySelectorAll("video, audio")].map((element) => {
      const media = element as HTMLMediaElement;
      media.muted = true;
      media.volume = 0;
      media.pause();
      return { tagName: media.tagName.toLowerCase(), paused: media.paused, muted: media.muted, readyState: media.readyState };
    });
    return {
      elements,
      assessment: elements.length === 0
        ? "未观察到 video/audio；本次仅验证课程/文章正文采集。"
        : "观察到 media 元素但未播放；本次仅验证正文采集，未宣称视频适配。",
    };
  });
}

async function attachmentFacts(page: Page, attachmentId: string): Promise<{
  readonly metadata: Record<string, unknown>;
  readonly bytesLength: number;
  readonly bytesPrefix: number[];
  readonly sha256: string;
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
    if (!metadata) throw new Error(`attachment metadata missing: ${id}`);
    const chunks = await request<Array<{ readonly offset: number; readonly byteLength: number; readonly data: ArrayBuffer }>>(
      transaction.objectStore("attachmentChunks").index("by-attachment").getAll(id),
    );
    chunks.sort((left, right) => left.offset - right.offset);
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(new Uint8Array(chunk.data), offset);
      offset += chunk.byteLength;
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      metadata,
      bytesLength: bytes.byteLength,
      bytesPrefix: [...bytes.slice(0, 16)],
      sha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""),
    };
  }, attachmentId);
}

async function runPlatform(sample: PlatformCase): Promise<void> {
  const run = await launchContext(sample.id);
  const evidence: Record<string, unknown> = {
    platform: sample.id,
    url: sample.url,
    checkedAt: new Date().toISOString(),
    accessScope: "公开 URL、未登录、未付费、未绕验证码；真实扩展 selection action",
    limitation: sample.limitation,
    launch: "independent headless persistent profile with --mute-audio",
  };
  try {
    const id = await extensionId(run.context);
    const page = await run.context.newPage();
    const response = await page.goto(sample.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!response) throw new Error("public page navigation returned no response");
    await page.waitForTimeout(1_000);
    const pageTitle = await page.title();
    const bodyText = await page.locator("body").innerText({ timeout: 15_000 });
    expect(pageTitle).toContain(sample.titleFragment);
    expect(bodyText).toContain(sample.textFragment);
    const media = await muteAndInspectMedia(page);
    const selected = await selectReadableBlock(page, sample.preferImage);
    expect(selected.textLength).toBeGreaterThan(80);
    const sidepanel = await extensionPage(run.context, id, "sidepanel.html");
    await page.bringToFront();
    const actionResponse = await captureSelection(sidepanel);
    expect(actionResponse.ok, actionResponse.error?.message ?? "capture-selection failed").toBe(true);
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1, { timeout: 15_000 });
    const list = await core<{ records: Array<{ captureId: string; kind: string }> }>(sidepanel, "capture.list", { view: "all", limit: 20 });
    const record = list.records.find((item) => item.kind === "text_selection" || item.kind === "mixed_selection");
    if (!record) throw new Error("public selection capture row missing");
    const detail = await core<{
      capture: {
        captureId: string;
        kind: string;
        state: string;
        source: { title: string; pageUrl: string; site: string };
        selection: Record<string, unknown>;
        attachmentIds: readonly string[];
        integrity: { status: string; missing: readonly string[] };
      };
      attachments: Array<Record<string, unknown>>;
    }>(sidepanel, "capture.get", { captureId: record.captureId });
    const selectedHtml = typeof detail.capture.selection.sanitizedHtml === "string" ? detail.capture.selection.sanitizedHtml : "";
    const selectedText = typeof detail.capture.selection.exact === "string" ? detail.capture.selection.exact : "";
    expect(detail.capture.state).toBe("sealed");
    expect(detail.capture.source.title).toContain(sample.titleFragment);
    expect(detail.capture.source.pageUrl).toBe(page.url());
    expect(selectedText).toBe(selected.exact);
    expect(selectedText.length).toBeGreaterThan(80);
    if (selected.selectedImageCount > 8) {
      // The extension preserves all selected references but only fetches the
      // first eight image bytes. A public article can therefore be a valid
      // partial capture with explicit budget facts.
      expect(detail.capture.integrity.status).toBe("partial");
      expect(detail.capture.integrity.missing).toContain("image_bytes");
      expect(detail.capture.integrity.missing).toContain("image_fetch_limit");
    } else {
      expect(detail.capture.integrity.missing).toHaveLength(0);
    }
    const attachments: Array<Record<string, unknown>> = [];
    for (const attachment of detail.attachments) {
      const attachmentId = typeof attachment.attachmentId === "string" ? attachment.attachmentId : "";
      if (!attachmentId) continue;
      const bytes = await attachmentFacts(sidepanel, attachmentId);
      expect(bytes.bytesLength).toBeGreaterThan(0);
      expect(attachment.dataAvailable).toBe(true);
      attachments.push({
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        status: attachment.status,
        byteLength: attachment.byteLength,
        dataAvailable: attachment.dataAvailable,
        bytesLength: bytes.bytesLength,
        bytesPrefix: bytes.bytesPrefix,
        sha256: bytes.sha256,
      });
    }
    if (sample.preferImage && selected.selectedImageCount > 0) {
      expect(attachments.some((attachment) => String(attachment.mimeType).startsWith("image/"))).toBe(true);
    }
    const library = await extensionPage(run.context, id, "library.html");
    await library.reload();
    await library.waitForLoadState("domcontentloaded");
    await expect(library.locator(".library-row")).toHaveCount(1, { timeout: 15_000 });
    await library.locator(".library-row").click();
    await expect(library.locator("#detail")).toContainText(sample.titleFragment);
    await expect(library.locator(".selection-copy")).toHaveText(selectedText);
    await library.screenshot({ path: resolve(evidencePath, `platform-${sample.id}-detail.png`), fullPage: true });
    evidence.status = "pass";
    evidence.page = {
      actualUrl: page.url(),
      title: pageTitle,
      responseStatus: response.status(),
      source: detail.capture.source,
      captureId: detail.capture.captureId,
      captureKind: detail.capture.kind,
      captureState: detail.capture.state,
      selectedTextLength: selectedText.length,
      selectedTextSha256: createHash("sha256").update(selectedText).digest("hex"),
      exactTextVerified: true,
      selectedHtmlLength: selectedHtml.length,
      selectedImageCount: selected.selectedImageCount,
      selectionTextPrefix: selected.textPrefix,
      attachments,
      mediaAssessment: media,
    };
  } catch (error) {
    evidence.status = "fail";
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await writeFile(resolve(evidencePath, `platform-${sample.id}-summary.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await run.context.close();
  }
}

for (const sample of platforms) {
  test(`public platform selection and library round trip: ${sample.id}`, async () => {
    await runPlatform(sample);
  });
}
