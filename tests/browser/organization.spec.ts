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
const reminderAlarm = "babel_content_clipper.idle_reminder.v1";
const reminderStateKey = "babel_content_clipper.reminder_state.v1";
const reminderNoticeKey = "babel_content_clipper.reminder_notice.v1";

type RuntimeError = { readonly code?: string; readonly message?: string };
type RuntimeResponse<T = unknown> = { readonly ok: boolean; readonly result?: T; readonly error?: RuntimeError };

type CaptureListItem = {
  readonly captureId: string;
  readonly kind: string;
  readonly title: string;
  readonly preview: string;
  readonly state: string;
  readonly sourceKey?: string;
  readonly collection?: string;
  readonly latestJobStatus?: string;
};

type CaptureList = { readonly records: readonly CaptureListItem[]; readonly nextCursor?: string };
type CaptureDetail = {
  readonly capture: {
    readonly captureId: string;
    readonly kind: string;
    readonly state: string;
    readonly collection: string;
    readonly source: { readonly title: string; readonly pageUrl: string; readonly site: string };
    readonly sourceKey: string;
    readonly selection: Record<string, unknown>;
  };
  readonly jobs: ReadonlyArray<{ readonly jobId: string; readonly status: string }>;
  readonly attachments: readonly Record<string, unknown>[];
};

async function launchContext(label: string): Promise<{ context: BrowserContext; profile: string }> {
  await mkdir(evidencePath, { recursive: true });
  const profile = resolve(evidencePath, `profile-organization-${label}-${Date.now()}`);
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

async function listAll(page: Page): Promise<CaptureList> {
  return core<CaptureList>(page, "capture.list", { view: "all", limit: 200 });
}

async function waitRows(page: Page, count: number): Promise<void> {
  await expect(page.locator(".library-row")).toHaveCount(count, { timeout: 15_000 });
}

async function createFixture(page: Page, slug: string, text: string): Promise<{ captureId: string; jobId: string }> {
  const result = await core<{ value: { capture: { captureId: string; initialJobId: string } } }>(page, "capture.create", {
    requestId: randomUUID(),
    input: {
      kind: "text_selection",
      state: "sealed",
      source: {
        title: `组织回归 ${slug}`,
        pageUrl: `https://fixture.invalid/organization/${slug}`,
        site: "fixture.invalid",
        identityConfidence: "best_effort",
        metadata: { setup: "fixture-setup", purpose: "organization-browser-regression" },
      },
      selection: { type: "text", exact: text, locator: { type: "text_quote", sourceConfidence: "fixture-setup" } },
      captureMethod: "fixture-setup",
      assetsState: "saved",
      integrity: { status: "complete_selection", missing: [] },
    },
  });
  return { captureId: result.value.capture.captureId, jobId: result.value.capture.initialJobId };
}

async function claimJob(page: Page, jobId: string): Promise<string> {
  const result = await core<{ items: ReadonlyArray<{ disposition: string; claimToken?: string }> }>(page, "job.claim", {
    requestId: randomUUID(),
    agentId: "organization-fixture-agent",
    jobIds: [jobId],
  });
  const accepted = result.items.find(item => item.disposition === "accepted");
  if (!accepted?.claimToken) throw new Error(`job ${jobId} was not accepted`);
  return accepted.claimToken;
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

async function selectLibraryRow(page: Page, text: string): Promise<void> {
  const rows = page.locator(".library-row");
  for (let index = 0; index < await rows.count(); index += 1) {
    await rows.nth(index).click();
    try {
      await expect.poll(() => page.locator("#detail").innerText(), { timeout: 1_000 }).toContain(text);
      return;
    } catch {
      // Continue to the next row. A source with several records can render a
      // different selected row before the next click reaches the detail pane.
    }
  }
  throw new Error(`record ${text} was not found in the library`);
}

async function clickPanelAction(sidepanel: Page, selector: string): Promise<string> {
  await sidepanel.evaluate((buttonSelector) => {
    const button = document.querySelector<HTMLButtonElement>(buttonSelector);
    if (!button) throw new Error(`missing sidepanel action ${buttonSelector}`);
    button.click();
  }, selector);
  await sidepanel.waitForTimeout(80);
  await expect.poll(() => sidepanel.locator("#capture-status").innerText(), { timeout: 20_000 }).not.toContain("正在");
  return sidepanel.locator("#capture-status").innerText();
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

async function reminderSnapshot(page: Page): Promise<{
  readonly alarms: readonly { readonly name: string; readonly scheduledTime?: number }[];
  readonly state?: { readonly captureId?: string; readonly captureRevision?: number; readonly captureTime?: number; readonly notified?: boolean };
  readonly notice?: { readonly id?: string; readonly createdAt?: string; readonly message?: string };
}> {
  return page.evaluate(async ({ alarmName, stateKey, noticeKey }) => {
    const [alarms, stored] = await Promise.all([
      chrome.alarms.getAll(),
      chrome.storage.local.get([stateKey, noticeKey]),
    ]);
    return {
      alarms: alarms.filter(alarm => alarm.name === alarmName).map(alarm => ({ name: alarm.name, scheduledTime: alarm.scheduledTime })),
      state: stored[stateKey] as { captureId?: string; captureRevision?: number; captureTime?: number; notified?: boolean } | undefined,
      notice: stored[noticeKey] as { id?: string; createdAt?: string; message?: string } | undefined,
    };
  }, { alarmName: reminderAlarm, stateKey: reminderStateKey, noticeKey: reminderNoticeKey });
}

async function saveEvidence(name: string, value: unknown): Promise<void> {
  await mkdir(evidencePath, { recursive: true });
  await writeFile(resolve(evidencePath, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("仅收藏往返保留待处理事实，复制任务说明只复制不领取", async () => {
  const run = await launchContext("favorites-copy");
  try {
    const id = await extensionId(run.context);
    await run.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `chrome-extension://${id}` }).catch(() => undefined);
    const library = await extensionPage(run.context, id, "library.html");
    const record = await createFixture(library, "favorites-copy", "ORGANIZATION_FAVORITE_FULL_TEXT_20260919");
    await library.reload();
    await library.waitForLoadState("domcontentloaded");
    await waitRows(library, 1);
    await selectLibraryRow(library, "ORGANIZATION_FAVORITE_FULL_TEXT_20260919");

    await library.getByRole("button", { name: "设为仅收藏" }).click();
    await expect(library.locator("#toast")).toContainText("仅收藏");
    const savedDetail = await core<CaptureDetail>(library, "capture.get", { captureId: record.captureId });
    expect(savedDetail.capture.collection).toBe("saved");
    const pendingAfterSave = await core<CaptureList>(library, "capture.list", { view: "pending", limit: 200 });
    expect(pendingAfterSave.records.some(item => item.captureId === record.captureId)).toBe(false);

    await library.locator('.tab[data-view="saved"]').click();
    await expect.poll(() => library.locator(".library-row").count()).toBe(1);
    await selectLibraryRow(library, "ORGANIZATION_FAVORITE_FULL_TEXT_20260919");
    await library.getByRole("button", { name: "重新加入待办" }).click();
    await expect(library.locator("#toast")).toContainText("重新加入待办");
    const inboxDetail = await core<CaptureDetail>(library, "capture.get", { captureId: record.captureId });
    expect(inboxDetail.capture.collection).toBe("inbox");
    expect(inboxDetail.jobs.at(-1)?.status).toBe("pending");
    const pendingAfterRestore = await core<CaptureList>(library, "capture.list", { view: "pending", limit: 200 });
    expect(pendingAfterRestore.records.some(item => item.captureId === record.captureId)).toBe(true);

    // Chromium headless requires a transient user activation for clipboard
    // readText even after grantPermissions. Capture the exact write payload at
    // the Clipboard boundary, while still clicking the real UI button.
    await library.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: (value: string) => {
          sessionStorage.setItem("babel-test-clipboard", value);
          return Promise.resolve();
        },
      });
    });
    await library.getByRole("button", { name: "复制任务说明" }).click();
    await expect(library.locator("#toast")).toContainText("任务说明已复制");
    const clipboardText = await library.evaluate(() => sessionStorage.getItem("babel-test-clipboard") ?? "");
    expect(clipboardText).toContain(record.captureId);
    expect(clipboardText).toContain("组织回归 favorites-copy");
    expect(clipboardText).toContain("https://fixture.invalid/organization/favorites-copy");
    expect(clipboardText).toContain("请先通过 MCP 查询详情");
    expect(clipboardText).toContain("待处理工作项须原子领取");
    expect(clipboardText).toContain("不覆盖历史结果");
    expect(clipboardText).not.toContain("claimToken");
    expect(clipboardText).not.toContain("claim token");
    expect((await core<CaptureDetail>(library, "capture.get", { captureId: record.captureId })).jobs.at(-1)?.status).toBe("pending");
    await library.screenshot({ path: resolve(evidencePath, "organization-favorites-copy.png"), fullPage: true });
    await saveEvidence("organization-favorites-copy.json", {
      fixtureSetup: "The record was created through trusted Core RPC for UI setup; this is not Agent execution.",
      captureId: record.captureId,
      saved: { excludedFromPending: true, collection: savedDetail.capture.collection },
      restored: { collection: inboxDetail.capture.collection, latestJobStatus: inboxDetail.jobs.at(-1)?.status, noAutomaticClaim: true },
      clipboard: {
        harness: "Headless extension permission blocked navigator.clipboard.readText; the test captures the exact writeText payload invoked by the real copy button and does not claim system clipboard read/write acceptance.",
        captureIdIncluded: clipboardText.includes(record.captureId),
        sourceIncluded: clipboardText.includes("https://fixture.invalid/organization/favorites-copy"),
        contentIncluded: clipboardText.includes("组织回归 favorites-copy"),
        explicitAgentBoundaryIncluded: clipboardText.includes("请先通过 MCP 查询详情")
          && clipboardText.includes("待处理工作项须原子领取")
          && clipboardText.includes("不覆盖历史结果"),
        claimTokenAbsent: !clipboardText.includes("claimToken") && !clipboardText.includes("claim token"),
        characterCount: clipboardText.length,
      },
    });
  } finally {
    await run.context.close();
  }
});

test("逐来源清理只删除已处理记录，并让另一打开视图清空已选详情", async () => {
  const run = await launchContext("source-cleanup");
  try {
    const id = await extensionId(run.context);
    const setup = await extensionPage(run.context, id, "library.html");
    const completed = await createFixture(setup, "mixed-source", "ORGANIZATION_SOURCE_COMPLETED");
    const pending = await createFixture(setup, "mixed-source", "ORGANIZATION_SOURCE_PENDING");
    const processing = await createFixture(setup, "mixed-source", "ORGANIZATION_SOURCE_PROCESSING");
    await claimJob(setup, processing.jobId);
    await completeFixture(setup, completed.jobId);

    await setup.reload();
    await setup.waitForLoadState("domcontentloaded");
    await waitRows(setup, 3);
    const secondView = await extensionPage(run.context, id, "library.html");
    await selectLibraryRow(setup, "ORGANIZATION_SOURCE_COMPLETED");
    await expect.poll(() => secondView.locator("#detail").innerText()).toContain("ORGANIZATION_SOURCE_COMPLETED");
    const selected = await core<CaptureDetail>(setup, "capture.get", { captureId: completed.captureId });

    const dialogPromise = setup.waitForEvent("dialog");
    await setup.getByRole("button", { name: "清理同来源已处理" }).click();
    const dialog = await dialogPromise;
    const previewMessage = dialog.message();
    expect(previewMessage).toContain("外部成品文件保留");
    expect(previewMessage).toContain("另有 2 条");
    await dialog.accept();

    await expect.poll(async () => {
      const rows = await listAll(setup);
      return rows.records.filter(item => item.sourceKey === selected.capture.sourceKey).map(item => item.captureId).sort();
    }).toEqual([pending.captureId, processing.captureId].sort());
    await expect.poll(() => secondView.locator("#detail").innerText()).toContain("所选记录已清理");
    const surviving = await core<CaptureList>(secondView, "capture.list", { view: "all", sourceKey: selected.capture.sourceKey, limit: 200 });
    expect(surviving.records.map(item => item.captureId).sort()).toEqual([pending.captureId, processing.captureId].sort());
    expect(surviving.records.find(item => item.captureId === pending.captureId)?.latestJobStatus).toBe("pending");
    expect(surviving.records.find(item => item.captureId === processing.captureId)?.latestJobStatus).toBe("processing");
    expect((await core<CaptureDetail>(secondView, "capture.get", { captureId: pending.captureId })).capture.sourceKey).toBe(selected.capture.sourceKey);
    await setup.screenshot({ path: resolve(evidencePath, "organization-source-cleanup-primary.png"), fullPage: true });
    await secondView.screenshot({ path: resolve(evidencePath, "organization-source-cleanup-refreshed.png"), fullPage: true });
    await saveEvidence("organization-source-cleanup.json", {
      fixtureSetup: "Three same-source records were created through trusted Core RPC; processing was claimed only to establish UI cleanup protection, not to simulate Agent output.",
      sourceKey: selected.capture.sourceKey,
      deletedCaptureIds: [completed.captureId],
      skippedActiveOrPendingCaptureIds: [pending.captureId, processing.captureId],
      previewHadTwoSkipped: previewMessage.includes("另有 2 条"),
      secondViewObservedDeletedSelection: true,
      selectedCaptureId: completed.captureId,
    });
  } finally {
    await run.context.close();
  }
});

test("真实 chrome.alarms 在新采集后重置、自然触发一次提醒且不领取；普通媒体 open 不被提醒结束", async () => {
  test.setTimeout(260_000);
  const run = await launchContext("alarms");
  try {
    const id = await extensionId(run.context);
    const library = await extensionPage(run.context, id, "library.html");
    const sidepanel = await extensionPage(run.context, id, "sidepanel.html");
    const article = await run.context.newPage();
    await article.goto(`${fixtureOrigin}/article.html`);
    await article.waitForLoadState("domcontentloaded");

    await library.locator("#settings").click();
    await expect(library.locator(".settings-form")).toBeVisible();
    await library.locator('.settings-form input[name="reminderMinutes"]').fill("1");
    await library.locator(".settings-form").getByRole("button", { name: "保存设置" }).click();
    await expect(library.locator("#toast")).toContainText("设置已保存");

    const firstText = await selectText(article, "#selection");
    expect(firstText).toContain("正在关注");
    await article.bringToFront();
    await clickPanelAction(sidepanel, "#capture-selection");
    const firstRecords = await listAll(sidepanel);
    const first = firstRecords.records.at(-1);
    if (!first) throw new Error("first alarm capture missing");

    await article.locator("#selection").evaluate(element => { element.textContent = `${element.textContent} 第二次提醒采集`; });
    const secondText = await selectText(article, "#selection");
    expect(secondText).toContain("第二次提醒采集");
    await article.bringToFront();
    await clickPanelAction(sidepanel, "#capture-selection");
    const afterSecond = await listAll(sidepanel);
    const second = afterSecond.records.find(item => item.captureId !== first.captureId);
    if (!second || second.captureId === first.captureId) throw new Error("second alarm capture did not create a distinct record");

    const scheduled = await reminderSnapshot(sidepanel);
    expect(scheduled.alarms).toHaveLength(1);
    expect(scheduled.state).toMatchObject({ captureId: second.captureId, notified: false });
    if (!scheduled.state?.captureTime || scheduled.alarms[0]?.scheduledTime === undefined) throw new Error("reminder state did not persist a time");
    expect(scheduled.alarms[0].scheduledTime).toBeGreaterThanOrEqual(scheduled.state.captureTime + 59_000);

    // Saving the same setting exercises the real settingsChanged listener and
    // must keep one one-shot alarm rather than stacking duplicates.
    await library.locator(".settings-form input[name=\"reminderMinutes\"]").fill("1");
    await library.locator(".settings-form").getByRole("button", { name: "保存设置" }).click();
    await expect(library.locator("#toast")).toContainText("设置已保存");
    await expect.poll(async () => (await reminderSnapshot(sidepanel)).alarms.length, { timeout: 10_000 }).toBe(1);

    await expect.poll(async () => await sidepanel.locator("#reminder-notice").isVisible(), { timeout: 110_000, intervals: [1_000] }).toBe(true);
    const firstNotice = await reminderSnapshot(sidepanel);
    expect(firstNotice.notice?.id).toBe(`${second.captureId}:${firstNotice.state?.captureRevision}`);
    expect(firstNotice.state?.notified).toBe(true);
    expect(firstNotice.alarms).toHaveLength(0);
    expect((await core<CaptureDetail>(sidepanel, "capture.get", { captureId: second.captureId })).jobs.at(-1)?.status).toBe("pending");
    await sidepanel.waitForTimeout(3_000);
    expect((await reminderSnapshot(sidepanel)).notice?.id).toBe(firstNotice.notice?.id);
    await sidepanel.getByRole("button", { name: "关闭提示" }).click();
    await expect(sidepanel.locator("#reminder-notice")).toBeHidden();
    expect((await reminderSnapshot(sidepanel)).notice).toBeUndefined();

    const media = await run.context.newPage();
    await media.goto(`${fixtureOrigin}/media.html`);
    await media.waitForLoadState("domcontentloaded");
    await expect.poll(async () => await media.locator("#main-video").evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThan(0);
    await media.locator("#main-video").evaluate(element => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.volume = 0;
      video.currentTime = 2;
      video.pause();
    });
    await media.bringToFront();
    await clickPanelAction(sidepanel, "#capture-media");
    const openRecords = await listAll(sidepanel);
    const openRecord = [...openRecords.records].reverse().find(item => item.kind === "media_range" && item.state === "open");
    if (!openRecord) throw new Error("ordinary media marker did not leave an open capture");
    await media.waitForTimeout(65_000);
    const stillOpen = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: openRecord.captureId });
    expect(stillOpen.capture.state).toBe("open");
    expect(stillOpen.capture.selection.type).toBe("media");
    expect(stillOpen.capture.selection.endClick).toBeUndefined();
    await saveEvidence("organization-alarms.json", {
      alarmName: reminderAlarm,
      scheduledOneShot: true,
      resetToLatestCapture: second.captureId,
      naturalNotice: true,
      noticeId: firstNotice.notice?.id,
      noClaim: true,
      duplicateSettingsSaveKeptOneAlarm: true,
      dismissClearedNotice: true,
      openMediaCaptureId: openRecord.captureId,
      openAfterReminderThreshold: true,
      openStateHasNoEndClick: true,
    });
    await media.bringToFront();
    await clickPanelAction(sidepanel, "#capture-media");
    await expect.poll(async () => {
      const detail = await core<CaptureDetail>(sidepanel, "capture.get", { captureId: openRecord.captureId });
      return detail.capture.state;
    }, { timeout: 15_000 }).toBe("sealed");
    await media.locator("#main-video").evaluate(element => (element as HTMLVideoElement).pause());
  } finally {
    await run.context.close();
  }
});
