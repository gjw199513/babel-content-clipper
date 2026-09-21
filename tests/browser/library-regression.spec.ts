import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

type CoreListResult = {
  readonly records: Array<{
    readonly captureId: string;
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
    readonly source: { readonly pageUrl: string; readonly site: string };
    readonly selection:
      | { readonly type: "clipboard"; readonly text: string; readonly sourceKnown: boolean }
      | { readonly type: string; readonly exact?: string };
  };
  readonly attachments: readonly unknown[];
};

async function launchContext(label: string): Promise<{ context: BrowserContext; profile: string }> {
  await mkdir(evidencePath, { recursive: true });
  const profile = resolve(evidencePath, `profile-library-${label}-${Date.now()}`);
  const context = await chromium.launchPersistentContext(profile, {
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox", "--mute-audio"],
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
    ({ channel, method: requestedMethod, params: requestedParams }) => new Promise<RuntimeResponse<T>>((resolve) => {
      chrome.runtime.sendMessage(
        { channel, type: "core", method: requestedMethod, params: requestedParams },
        (value: RuntimeResponse<T>) => resolve(value),
      );
    }),
    { channel: extensionChannel, method, params },
  );
  if (!response?.ok || response.result === undefined) {
    throw new Error(`${method} failed: ${response?.error?.code ?? "UNKNOWN"} ${response?.error?.message ?? ""}`.trim());
  }
  return response.result;
}

async function listAll(page: Page): Promise<CoreListResult> {
  return core<CoreListResult>(page, "capture.list", { view: "all", limit: 200 });
}

async function waitForRows(page: Page, count: number): Promise<void> {
  await expect(page.locator(".library-row, .capture-row")).toHaveCount(count, { timeout: 15_000 });
}

async function createFixture(page: Page, slug: string, text: string): Promise<{ captureId: string; jobId: string }> {
  const result = await core<{
    value: { capture: { captureId: string; initialJobId: string } };
  }>(page, "capture.create", {
    requestId: randomUUID(),
    input: {
      kind: "text_selection",
      state: "sealed",
      source: {
        title: `UI cleanup ${slug}`,
        pageUrl: `https://fixture.invalid/library-cleanup/${slug}`,
        site: "fixture.invalid",
        identityConfidence: "best_effort",
        metadata: { setup: "fixture-setup", purpose: "library-cleanup-regression" },
      },
      selection: {
        type: "text",
        exact: text,
        locator: { type: "text_quote", sourceConfidence: "fixture-setup" },
      },
      captureMethod: "fixture-setup",
      assetsState: "saved",
      integrity: { status: "complete_selection", missing: [] },
    },
  });
  return { captureId: result.value.capture.captureId, jobId: result.value.capture.initialJobId };
}

async function claimJob(page: Page, jobId: string): Promise<string> {
  const result = await core<{
    items: Array<{ readonly disposition: string; readonly claimToken?: string }>;
  }>(page, "job.claim", {
    requestId: randomUUID(),
    agentId: "fixture-library-agent",
    jobIds: [jobId],
  });
  const item = result.items.find((candidate) => candidate.disposition === "accepted");
  if (!item?.claimToken) throw new Error("fixture job was not claimed");
  return item.claimToken;
}

async function completeFixture(page: Page, jobId: string): Promise<void> {
  const claimToken = await claimJob(page, jobId);
  await core(page, "job.complete", {
    requestId: randomUUID(),
    jobId,
    claimToken,
    outcome: "completed",
    acquisitionMethod: "saved_text",
    requestedRanges: [],
    acquiredRanges: [],
    outputRanges: [],
    artifacts: [],
    verification: { level: "agent_reported", warnings: [] },
  });
}

async function saveEvidenceSummary(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(evidencePath, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("clipboard import, shared filters, selection persistence, reminder notice, and UI backup round trip", async () => {
  const first = await launchContext("clipboard");
  let imported: { context: BrowserContext; profile: string } | undefined;
  const evidence: Record<string, unknown> = {
    fixtureSetup: "Clipboard records are created through the actual paste dialog; reminder notice is a synthetic storage fixture.",
    attachments: "No attachments were created; the export assertion is metadata-only and makes no media claim.",
  };
  try {
    const id = await extensionId(first.context);
    const sidepanel = await extensionPage(first.context, id, "sidepanel.html");
    const library = await extensionPage(first.context, id, "library.html");

    const unknownText = "LIBRARY_CLIPBOARD_UNKNOWN_FULL_TEXT_20260919";
    const paste = sidepanel.getByRole("button", { name: "粘贴导入" });
    await paste.click();
    const dialog = sidepanel.locator(".paste-dialog");
    await dialog.locator('textarea[name="text"]').fill(unknownText);
    await dialog.locator('input[name="title"]').fill("Unknown clipboard source");
    const save = dialog.getByRole("button", { name: "保存到素材库" });
    // Submit the real form twice in the same task. The first handler sets its
    // busy guard before the second submit reaches it, so the UI must persist
    // exactly one record.
    await dialog.locator("form").evaluate((formElement) => {
      const form = formElement as HTMLFormElement;
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect(dialog).toBeHidden();
    await expect(sidepanel.locator("#capture-status")).toContainText("粘贴内容已保存");
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1);
    const unknownRows = await listAll(sidepanel);
    expect(unknownRows.records).toHaveLength(1);
    const unknownId = unknownRows.records[0]?.captureId;
    if (!unknownId) throw new Error("unknown-source clipboard record was not persisted");
    const unknownDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: unknownId });
    expect(unknownDetail.capture.kind).toBe("clipboard_import");
    expect(unknownDetail.capture.source.pageUrl).toBe("clipboard:unknown");
    expect(unknownDetail.capture.source.site).toBe("来源未知");
    expect(unknownDetail.capture.selection).toMatchObject({ type: "clipboard", text: unknownText, sourceKnown: false });

    await library.reload();
    await library.waitForLoadState("domcontentloaded");
    await waitForRows(library, 1);
    await library.locator(".library-row").click();
    await expect(library.locator("#detail")).toContainText(unknownText);
    await expect(library.locator("#detail")).toContainText("来源已知");
    await expect(library.locator("#detail")).toContainText("否");
    await expect(library.locator(".source-line")).toContainText("来源未知");
    await library.screenshot({ path: resolve(evidencePath, "library-clipboard-unknown.png"), fullPage: true });

    await paste.click();
    const invalidDialog = sidepanel.locator(".paste-dialog");
    await invalidDialog.locator('textarea[name="text"]').fill("INVALID_HTTP_SOURCE_TEXT");
    await invalidDialog.locator('input[name="title"]').fill("Invalid source fixture");
    await invalidDialog.locator('input[name="source"]').fill("ftp://invalid.example/resource");
    await invalidDialog.getByRole("button", { name: "保存到素材库" }).click();
    await expect(invalidDialog.locator(".paste-error")).toContainText("仅支持");
    expect((await listAll(sidepanel)).records).toHaveLength(1);
    await invalidDialog.getByRole("button", { name: "取消" }).click();

    const validText = "ALPHA_HTTP_SOURCE_FULL_TEXT_20260919";
    await paste.click();
    const validDialog = sidepanel.locator(".paste-dialog");
    await validDialog.locator('textarea[name="text"]').fill(validText);
    await validDialog.locator('input[name="title"]').fill("Alpha source");
    await validDialog.locator('input[name="source"]').fill("https://example.com/article?token=secret-value&x=1");
    await validDialog.getByRole("button", { name: "保存到素材库" }).click();
    await expect(validDialog).toBeHidden();
    await expect(sidepanel.locator(".capture-row")).toHaveCount(2);
    const rowsAfterValid = await listAll(sidepanel);
    expect(rowsAfterValid.records).toHaveLength(2);
    const validRow = rowsAfterValid.records.find((record) => record.preview === validText);
    if (!validRow) throw new Error("valid http clipboard record was not persisted");
    const validDetail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: validRow.captureId });
    expect(validDetail.capture.source.pageUrl).toBe("https://example.com/article?x=1");
    expect(validDetail.capture.source.site).toBe("example.com");
    expect(validDetail.capture.selection).toMatchObject({ type: "clipboard", text: validText, sourceKnown: true });

    await library.reload();
    await library.waitForLoadState("domcontentloaded");
    await waitForRows(library, 2);
    await library.locator("#search").fill("Alpha");
    await expect.poll(async () => await library.locator(".library-row").count()).toBe(1);
    await expect.poll(async () => await sidepanel.locator("#view-label").textContent()).toContain("搜索中");
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1);
    await expect(sidepanel.locator(".capture-row")).toContainText(validText);

    const alphaOption = library.locator("#source-filter option").filter({ hasText: "Alpha source" });
    await expect(alphaOption).toHaveCount(1);
    const alphaSourceKey = await alphaOption.getAttribute("value");
    if (!alphaSourceKey) throw new Error("source filter option has no key");
    await library.locator("#source-filter").selectOption(alphaSourceKey);
    await expect.poll(async () => await sidepanel.locator("#view-label").textContent()).toContain("指定来源");
    await expect(sidepanel.locator(".capture-row")).toHaveCount(1);
    await library.locator(".library-row").click();
    await expect(library.locator("#detail")).toContainText(validText);
    const storedState = await sidepanel.evaluate(async () => (await chrome.storage.local.get("babel_content_clipper.view_state.v1"))["babel_content_clipper.view_state.v1"]);
    expect(storedState).toMatchObject({ search: "Alpha", sourceKey: alphaSourceKey, selectedCaptureId: validRow.captureId });
    await library.screenshot({ path: resolve(evidencePath, "library-view-sync-library.png"), fullPage: true });
    await sidepanel.screenshot({ path: resolve(evidencePath, "library-view-sync-sidepanel.png"), fullPage: true });

    await library.close();
    await sidepanel.close();
    const reopenedLibrary = await extensionPage(first.context, id, "library.html");
    const reopenedSidepanel = await extensionPage(first.context, id, "sidepanel.html");
    await expect(reopenedLibrary.locator("#search")).toHaveValue("Alpha");
    await expect(reopenedLibrary.locator("#source-filter")).toHaveValue(alphaSourceKey);
    await expect(reopenedLibrary.locator("#detail")).toContainText(validText);
    await expect(reopenedSidepanel.locator("#view-label")).toContainText("搜索中");
    await expect(reopenedSidepanel.locator("#view-label")).toContainText("指定来源");
    await expect(reopenedSidepanel.locator(".capture-row")).toHaveCount(1);
    await reopenedLibrary.screenshot({ path: resolve(evidencePath, "library-view-sync-reopened.png"), fullPage: true });

    await reopenedSidepanel.evaluate(async () => chrome.storage.local.set({
      "babel_content_clipper.reminder_notice.v1": {
        id: "library-ui-fixture-reminder",
        createdAt: new Date().toISOString(),
        message: "测试提醒：这是素材库 UI 回归 fixture。",
      },
    }));
    await expect(reopenedSidepanel.locator("#reminder-notice")).toBeVisible();
    await expect(reopenedSidepanel.locator("#reminder-message")).toContainText("测试提醒");
    await reopenedSidepanel.screenshot({ path: resolve(evidencePath, "library-reminder-visible.png"), fullPage: true });
    await reopenedSidepanel.getByRole("button", { name: "关闭提示" }).click();
    await expect(reopenedSidepanel.locator("#reminder-notice")).toBeHidden();

    const backupPath = resolve(evidencePath, "library-backup-metadata.json");
    await reopenedLibrary.locator(".maintenance-panel > summary").click();
    const downloadPromise = reopenedLibrary.waitForEvent("download");
    await reopenedLibrary.getByRole("button", { name: "导出备份" }).click();
    const download = await downloadPromise;
    await download.saveAs(backupPath);
    await expect(reopenedLibrary.locator("#toast")).toContainText("元数据备份已生成");
    await reopenedLibrary.screenshot({ path: resolve(evidencePath, "library-backup-export.png"), fullPage: true });

    imported = await launchContext("backup-import");
    const importedId = await extensionId(imported.context);
    const importedLibrary = await extensionPage(imported.context, importedId, "library.html");
    await expect(importedLibrary.locator(".library-row")).toHaveCount(0);
    await importedLibrary.locator("#import-file").setInputFiles(backupPath);
    await expect(importedLibrary.locator("#toast")).toContainText("导入完成：2 条记录");
    await waitForRows(importedLibrary, 2);
    await importedLibrary.locator(".library-row").filter({ hasText: validText }).click();
    await expect(importedLibrary.locator("#detail")).toContainText(validText);
    await expect(importedLibrary.locator("#detail")).toContainText("https://example.com/article?x=1");
    await expect(importedLibrary.locator("#detail")).not.toContainText("secret-value");
    await importedLibrary.screenshot({ path: resolve(evidencePath, "library-backup-import.png"), fullPage: true });

    evidence.profileA = first.profile.split("/").at(-1);
    evidence.profileB = imported.profile.split("/").at(-1);
    evidence.pasteImport = { unknownSource: true, fullTextPreserved: true, duplicateSubmitRows: 1, httpSourceRedacted: true, invalidProtocolRejected: true };
    evidence.sharedView = { search: "Alpha", sourceFilter: true, selectedCapturePersisted: true, closeReopenRestored: true };
    evidence.reminder = { fixtureInjected: true, visible: true, dismissed: true };
    evidence.backup = { metadataOnly: true, downloadedThroughUi: true, importedThroughUiInIndependentProfile: true, recordsRestored: 2, fullTextRestored: true, sourceRestored: true };
    await saveEvidenceSummary("library-regression-summary.json", evidence);
  } finally {
    if (imported) await imported.context.close();
    await first.context.close();
  }
});

test("cleanup UI previews, cancellation, commit, and active/unprocessed protection", async () => {
  const run = await launchContext("cleanup");
  const evidence: Record<string, unknown> = {
    fixtureSetup: "The three cleanup records and the completed job are created through trusted extension runtime core RPC for UI setup only; this is not real Agent processing.",
    externalFiles: "No external file was deleted; the UI preview contract states external files are preserved. Core deletion semantics are covered separately.",
  };
  try {
    const id = await extensionId(run.context);
    const library = await extensionPage(run.context, id, "library.html");
    const completed = await createFixture(library, "completed", "UI_CLEANUP_COMPLETED_FULL_TEXT");
    const pending = await createFixture(library, "pending", "UI_CLEANUP_PENDING_FULL_TEXT");
    const processing = await createFixture(library, "processing", "UI_CLEANUP_PROCESSING_FULL_TEXT");
    await claimJob(library, processing.jobId);
    await completeFixture(library, completed.jobId);
    await expect.poll(async () => (await listAll(library)).records.length).toBe(3);
    await library.reload();
    await library.waitForLoadState("domcontentloaded");
    await waitForRows(library, 3);
    await library.locator(".maintenance-panel > summary").click();

    const cleanupAllDialog = library.waitForEvent("dialog");
    await library.getByRole("button", { name: "预览清理全部已处理" }).click();
    const cleanupAll = await cleanupAllDialog;
    const cleanupAllMessage = cleanupAll.message();
    expect(cleanupAllMessage).toContain("外部成品文件保留");
    expect(cleanupAllMessage).toContain("另有 2 条因活跃任务、未处理或不存在而跳过");
    await cleanupAll.dismiss();
    await waitForRows(library, 3);
    await library.screenshot({ path: resolve(evidencePath, "library-cleanup-preview-cancel.png"), fullPage: true });

    await library.locator(".library-row").filter({ hasText: "UI_CLEANUP_COMPLETED_FULL_TEXT" }).click();
    await expect(library.locator("#detail")).toContainText("UI_CLEANUP_COMPLETED_FULL_TEXT");
    const singlePreviewDialog = library.waitForEvent("dialog");
    await library.getByRole("button", { name: "清理这条" }).click();
    const singlePreview = await singlePreviewDialog;
    const singlePreviewMessage = singlePreview.message();
    expect(singlePreviewMessage).toContain("将删除 1 条插件记录");
    expect(singlePreviewMessage).toContain("0 个关联附件记录");
    expect(singlePreviewMessage).toContain("外部成品文件保留");
    await singlePreview.dismiss();
    await expect(library.locator(".library-row").filter({ hasText: "UI_CLEANUP_COMPLETED_FULL_TEXT" })).toHaveCount(1);

    const commitDialog = library.waitForEvent("dialog");
    await library.getByRole("button", { name: "清理这条" }).click();
    const commit = await commitDialog;
    expect(commit.message()).toContain("外部成品文件保留");
    await commit.accept();
    await expect(library.locator("#toast")).toContainText("已清理 1 条插件记录；外部成品文件未删除");
    await expect(library.locator(".library-row").filter({ hasText: "UI_CLEANUP_COMPLETED_FULL_TEXT" })).toHaveCount(0);
    await expect(library.locator(".library-row").filter({ hasText: "UI_CLEANUP_PENDING_FULL_TEXT" })).toHaveCount(1);
    await expect(library.locator(".library-row").filter({ hasText: "UI_CLEANUP_PROCESSING_FULL_TEXT" })).toHaveCount(1);
    await expect(library.locator(".library-row").filter({ hasText: "待处理" })).toHaveCount(1);
    await expect(library.locator(".library-row").filter({ hasText: "处理中" })).toHaveCount(1);
    const afterCleanup = await listAll(library);
    expect(afterCleanup.records.map((record) => record.captureId)).toEqual(expect.arrayContaining([pending.captureId, processing.captureId]));
    expect(afterCleanup.records.map((record) => record.captureId)).not.toContain(completed.captureId);
    const removedDetail = await core<RuntimeResponse<CaptureDetail>>(library, "capture.get", { captureId: completed.captureId }).catch(() => undefined);
    expect(removedDetail).toBeUndefined();
    await library.screenshot({ path: resolve(evidencePath, "library-cleanup-committed.png"), fullPage: true });

    evidence.cleanup = {
      allProcessedPreview: { candidates: 1, skippedActiveOrUnprocessed: 2, externalFilesPreserved: true },
      cancelledPreviewKeptRecord: true,
      commitDeletedCompletedRecord: true,
      pendingProtected: true,
      processingProtected: true,
      externalAttachmentRecordPreviewed: false,
    };
    await saveEvidenceSummary("library-cleanup-summary.json", evidence);
  } finally {
    await run.context.close();
  }
});
