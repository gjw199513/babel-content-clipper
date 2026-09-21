import "fake-indexeddb/auto";

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createClipperService,
  deleteClipperDatabase,
  type CaptureCreateResult,
  type CoreService,
} from "../../packages/core/src/index.js";
import { BrokerClient } from "../../packages/mcp/src/broker-client.js";
import { startLocalBroker, type LocalBroker } from "../../packages/mcp/src/broker.js";
import { ensureBridgeConfig, type BridgeConfig } from "../../packages/mcp/src/config.js";
import { failureResponse, successResponse, type WireRequest } from "../../packages/mcp/src/wire.js";

const services: CoreService[] = [];
const brokers: LocalBroker[] = [];
const clients: BrokerClient[] = [];
const directories: string[] = [];
const databases: string[] = [];
const transports: StdioClientTransport[] = [];

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((transport) => transport.close()));
  for (const client of clients.splice(0)) client.close();
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.allSettled(databases.splice(0).map((database) => deleteClipperDatabase(database)));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface FixtureOptions {
  invalidConnectionOutputRoot?: boolean;
  globalOutputDirectory?: boolean;
  mcpOutputRoot?: boolean;
}

async function fixture(options: FixtureOptions = {}): Promise<{
  profileId: string;
  captureId: string;
  jobId: string;
  taskOutputDirectory: string;
  globalOutputDirectory?: string;
  mcpOutputRoot?: string;
  configDirectory: string;
  config: BridgeConfig;
  broker: LocalBroker;
  transport: StdioClientTransport;
}> {
  const directory = await mkdtemp(join(tmpdir(), "babel-clipper-mcp-"));
  directories.push(directory);
  const profileId = "profile-mcp";
  const configDirectory = join(directory, "config");
  const connectionOutputRoot = join(directory, "connection-output");
  if (options.invalidConnectionOutputRoot) {
    await writeFile(connectionOutputRoot, "not a directory");
  }
  const config = await ensureBridgeConfig({
    configDirectory,
    ...(options.invalidConnectionOutputRoot ? { outputRoot: connectionOutputRoot } : {}),
  });
  const broker = await startLocalBroker({ config, requestTimeoutMs: 500 });
  brokers.push(broker);

  const databaseName = "mcp-" + crypto.randomUUID();
  databases.push(databaseName);
  const service = createClipperService({ databaseName });
  services.push(service);
  const globalOutputDirectory = options.globalOutputDirectory
    ? join(directory, "global-output")
    : undefined;
  const mcpOutputRoot = options.mcpOutputRoot
    ? join(directory, "mcp-process-output")
    : undefined;
  if (globalOutputDirectory !== undefined) {
    await mkdir(globalOutputDirectory, { recursive: true });
    await service.handle("settings.update", {
      requestId: "set-global-output",
      patch: { globalOutputDirectory },
    }, { profileId });
  }
  const created = await service.handle("capture.create", {
    requestId: "seed-capture",
    input: {
      kind: "text_selection",
      state: "sealed",
      source: {
        title: "MCP fixture",
        pageUrl: "https://example.test/mcp",
        site: "example.test",
      },
      selection: { type: "text", exact: "A captured sentence." },
      captureMethod: "selection",
      assetsState: "saved",
      integrity: { status: "complete_selection", missing: [] },
    },
  }, { profileId }) as CaptureCreateResult;
  const jobId = created.value.job?.jobId;
  if (jobId === undefined) throw new Error("seed capture did not create an initial job");

  const native = await BrokerClient.connect({ config, role: "native" });
  clients.push(native);
  await native.request("bridge.hello", { channel: "test-extension" }, profileId);
  native.on("request", async (request: WireRequest) => {
    try {
      const result = request.method === "capture.acquireMedia"
        ? {
            captureId: (request.params as { captureId: string }).captureId,
            jobId: (request.params as { jobId: string }).jobId,
            attachmentId: "asset-extension-source",
            mimeType: "video/mp4",
            byteLength: 42,
            acquisition: "extension_background_fetch",
            browserPlugin: "babel_content_clipper",
          }
        : await service.handle(request.method, request.params, { profileId: request.profileId });
      native.sendMessage(successResponse(request.id, result, request.profileId));
    } catch (error) {
      const value = error as { code?: unknown; message?: unknown; details?: unknown };
      native.sendMessage(failureResponse(
        request.id,
        {
          code: typeof value.code === "string" ? value.code : "EXTENSION_ERROR",
          message: typeof value.message === "string" ? value.message : "The test extension rejected the request.",
          ...(value.details === undefined ? {} : { details: value.details }),
        },
        request.profileId,
      ));
    }
  });

  const cliPath = resolve("packages/mcp/src/cli.ts");
  const taskOutputDirectory = join(directory, "task-output");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      cliPath,
      "--mode=mcp",
      "--config-dir",
      configDirectory,
      "--profile-id",
      profileId,
      ...(mcpOutputRoot === undefined ? [] : ["--output-root", mcpOutputRoot]),
    ],
    cwd: resolve("."),
    stderr: "pipe",
  });
  transports.push(transport);
  return {
    profileId,
    captureId: created.value.capture.captureId,
    jobId,
    taskOutputDirectory,
    ...(globalOutputDirectory === undefined ? {} : { globalOutputDirectory }),
    ...(mcpOutputRoot === undefined ? {} : { mcpOutputRoot }),
    configDirectory,
    config,
    broker,
    transport,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the expected broker state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function childExit(child: ReturnType<typeof spawn>, timeoutMs = 1_500): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP child did not exit after stdin EOF."));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

function toolPayload(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("MCP tool did not return a direct content result");
  }
  const text = result.content
    .find((item) => item && typeof item === "object" && "type" in item && item.type === "text" &&
      "text" in item && typeof item.text === "string") as { text?: string } | undefined;
  if (text?.text === undefined) throw new Error("MCP tool did not return text content");
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe("standard MCP stdio server", () => {
  it("performs the official stdio handshake and forwards exact Core-shaped tools to a fake IndexedDB extension", async () => {
    const { captureId, jobId, taskOutputDirectory, transport } = await fixture();
    const client = new Client({ name: "mcp-stdio-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain("update_mcp");
    expect(toolNames).toContain("babel_clipper_claim_records");
    expect(toolNames).toContain("babel_clipper_get_processing_guide");
    expect(toolNames).toContain("babel_clipper_acquire_source_media");
    expect(toolNames).toContain("babel_clipper_export_capture");
    expect(toolNames).toContain("babel_clipper_commit_result");
    expect(toolNames).not.toContain("babel_clipper_get_acquisition_source");
    expect(toolNames).not.toContain("babel_clipper_download_media");
    expect(toolNames).not.toContain("babel_clipper_prepare_processing_runtime");
    expect(toolNames).not.toContain("babel_clipper_transcribe_media");
    expect(toolNames).not.toContain("babel_clipper_save_corrected_transcript");

    const update = await client.callTool({ name: "update_mcp", arguments: {} });
    expect(toolPayload(update)).toMatchObject({ ok: true, result: { updated: false, update_required: true, action: "restart_mcp_host" } });

    const guide = await client.callTool({
      name: "babel_clipper_get_processing_guide",
      arguments: { topic: "video_text_extraction" },
    });
    expect(toolPayload(guide)).toMatchObject({
      ok: true,
      result: {
        topic: "video_text_extraction",
        architecture: {
          executor: "agent",
          mcpExecutesProcessing: false,
          browserAutomationAllowed: false,
          extensionAcquisitionRequired: true,
        },
      },
    });

    const batchGuide = await client.callTool({
      name: "babel_clipper_get_processing_guide",
      arguments: { topic: "pending_batch_processing" },
    });
    expect(toolPayload(batchGuide)).toMatchObject({
      ok: true,
      result: {
        topic: "pending_batch_processing",
        architecture: {
          executor: "agent",
          mcpExecutesProcessing: false,
          userAuthorizationRequired: true,
          copyOrQueryHasSideEffects: false,
        },
        pagination: { mustFollowNextCursor: true },
        claiming: { maxJobIdsPerCall: 200, acceptedOnly: true },
      },
    });

    const resources = await client.listResources();
    const guideResource = resources.resources.find((resource) => resource.name === "video-text-extraction-guide");
    expect(guideResource?.uri).toContain("/guides/video-text-extraction");
    const guideDocument = await client.readResource({ uri: guideResource?.uri as string });
    expect(guideDocument.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect("text" in guideDocument.contents[0]! ? guideDocument.contents[0]!.text : "")
      .toContain("源媒体由 Babel 扩展在后台或页面上下文获取并保存为扩展附件");
    const batchGuideResource = resources.resources.find((resource) => resource.name === "pending-batch-processing-guide");
    expect(batchGuideResource?.uri).toContain("/guides/pending-batch-processing");
    const batchGuideDocument = await client.readResource({ uri: batchGuideResource?.uri as string });
    expect(batchGuideDocument.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect("text" in batchGuideDocument.contents[0]! ? batchGuideDocument.contents[0]!.text : "")
      .toContain("Agent 可以一次完成整个批次");

    const invalidList = await client.callTool({
      name: "babel_clipper_list_records",
      arguments: { status: "pending" },
    });
    expect("isError" in invalidList && invalidList.isError).toBe(true);

    const listed = await client.callTool({
      name: "babel_clipper_list_records",
      arguments: { view: "pending", limit: 10 },
    });
    expect(toolPayload(listed)).toMatchObject({
      ok: true,
      result: { records: [{ latestJobId: jobId }] },
    });

    const claimed = await client.callTool({
      name: "babel_clipper_claim_records",
      arguments: {
        requestId: "claim-from-mcp",
        agentId: "agent-mcp",
        jobIds: [jobId],
        taskOutputDirectory,
        requireOutputDirectory: true,
      },
    });
    const claimPayload = toolPayload(claimed);
    const claimResult = claimPayload.result as {
      items: Array<{ jobId: string; claimToken?: string }>;
      ack: { persisted: boolean };
    };
    expect(claimResult.ack.persisted).toBe(true);
    expect(claimResult.items[0]).toMatchObject({
      job: { directory: { source: "task", path: expect.stringContaining("task-output") } },
    });
    const claimToken = claimResult.items[0]?.claimToken;
    expect(claimToken).toEqual(expect.any(String));

    const acquired = await client.callTool({
      name: "babel_clipper_acquire_source_media",
      arguments: { requestId: "acquire-from-extension", captureId, jobId, claimToken },
    });
    expect(toolPayload(acquired)).toMatchObject({
      ok: true,
      result: {
        captureId,
        jobId,
        attachmentId: "asset-extension-source",
        acquisition: "extension_background_fetch",
        browserPlugin: "babel_content_clipper",
      },
    });

    const rejectedVerification = await client.callTool({
      name: "babel_clipper_commit_result",
      arguments: {
        requestId: "bad-verification",
        jobId,
        claimToken,
        outcome: "completed",
        verification: { level: "bridge_verified", warnings: [] },
      },
    });
    expect(rejectedVerification.isError).toBe(true);
    expect(toolPayload(rejectedVerification)).toMatchObject({
      ok: false,
      error: { code: "VERIFICATION_SCOPE_FORBIDDEN" },
    });

    const artifactPath = join(taskOutputDirectory, "processed.mp4");
    await writeFile(artifactPath, Buffer.from([0, 1, 2, 3]));
    const completed = await client.callTool({
      name: "babel_clipper_commit_result",
      arguments: {
        requestId: "complete-from-mcp",
        jobId,
        claimToken,
        outcome: "completed",
        artifacts: [{
          assetId: "asset-processed-video",
          kind: "video",
          mimeType: "video/mp4",
          fileReference: artifactPath,
          byteLength: 4,
        }],
        verification: { level: "agent_reported", warnings: [] },
      },
    });
    expect(toolPayload(completed)).toMatchObject({
      ok: true,
      result: { ack: { persisted: true }, result: { status: "completed" } },
    });
  });

  it("uses a valid task output directory even when a lower-priority connection default is invalid", async () => {
    const { jobId, taskOutputDirectory, transport } = await fixture({ invalidConnectionOutputRoot: true });
    const client = new Client({ name: "mcp-task-priority-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const claimed = await client.callTool({
      name: "babel_clipper_claim_records",
      arguments: {
        requestId: "claim-explicit-task-directory",
        agentId: "agent-task-priority",
        jobIds: [jobId],
        taskOutputDirectory,
        requireOutputDirectory: true,
      },
    });
    expect(toolPayload(claimed)).toMatchObject({
      ok: true,
      result: {
        ack: { persisted: true },
        items: [{
          jobId,
          disposition: "accepted",
          job: { directory: { source: "task", path: expect.stringContaining("task-output") } },
        }],
      },
    });
  });

  it("exports a complete text capture to the persisted local output root", async () => {
    const { captureId, globalOutputDirectory, transport } = await fixture({ globalOutputDirectory: true });
    const client = new Client({ name: "mcp-export-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const exported = await client.callTool({
      name: "babel_clipper_export_capture",
      arguments: { captureId },
    });
    expect(toolPayload(exported)).toMatchObject({
      ok: true,
      result: { captureId, complete: true },
    });
    const captureDirectory = join(globalOutputDirectory as string, "captures", captureId);
    await expect(readFile(join(captureDirectory, "selected-text.txt"), "utf8"))
      .resolves.toBe("A captured sentence.");
    await expect(readFile(join(captureDirectory, "manifest.json"), "utf8"))
      .resolves.toContain('"complete": true');
  });

  it("uses the persisted global output directory when no task or MCP root is configured", async () => {
    const { jobId, globalOutputDirectory, transport } = await fixture({ globalOutputDirectory: true });
    const client = new Client({ name: "mcp-global-output-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const claimed = await client.callTool({
      name: "babel_clipper_claim_records",
      arguments: {
        requestId: "claim-global-output-directory",
        agentId: "agent-global-output",
        jobIds: [jobId],
        requireOutputDirectory: true,
      },
    });
    expect(globalOutputDirectory).toEqual(expect.any(String));
    expect(toolPayload(claimed)).toMatchObject({
      ok: true,
      result: {
        ack: { persisted: true },
        items: [{ jobId, disposition: "accepted", job: { directory: { source: "global", path: globalOutputDirectory } } }],
      },
    });
  });

  it("uses an explicit MCP process output root without changing or trusting a lower-priority shared default", async () => {
    const { jobId, mcpOutputRoot, transport } = await fixture({
      invalidConnectionOutputRoot: true,
      mcpOutputRoot: true,
    });
    const client = new Client({ name: "mcp-process-output-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const claimed = await client.callTool({
      name: "babel_clipper_claim_records",
      arguments: {
        requestId: "claim-mcp-process-output-directory",
        agentId: "agent-mcp-process-output",
        jobIds: [jobId],
        requireOutputDirectory: true,
      },
    });
    expect(mcpOutputRoot).toEqual(expect.any(String));
    expect(toolPayload(claimed)).toMatchObject({
      ok: true,
      result: {
        ack: { persisted: true },
        items: [{
          jobId,
          disposition: "accepted",
          job: { directory: { source: "connection", path: expect.stringContaining("mcp-process-output") } },
        }],
      },
    });
  });

  it("releases only its BrokerClient and exits when a stdio client closes stdin", async () => {
    const { config, configDirectory, broker, profileId } = await fixture();
    const otherProfileNative = await BrokerClient.connect({ config, role: "native" });
    clients.push(otherProfileNative);
    await otherProfileNative.request("bridge.hello", { channel: "other-test-extension" }, "profile-other");

    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      resolve("packages/mcp/src/cli.ts"),
      "--mode=mcp",
      "--config-dir",
      configDirectory,
      "--profile-id",
      profileId,
    ], {
      cwd: resolve("."),
      stdio: ["pipe", "ignore", "pipe"],
    });
    await waitFor(() => broker.status().mcpClients === 1);
    child.stdin?.end();
    await expect(childExit(child)).resolves.toBe(0);

    await waitFor(() => broker.status().mcpClients === 0);
    expect(broker.status()).toMatchObject({
      listening: true,
      connectedProfiles: expect.arrayContaining([
        { profileId, connected: true },
        { profileId: "profile-other", connected: true },
      ]),
    });
    const otherProfileMcp = await BrokerClient.connect({ config, role: "mcp", profileId: "profile-other" });
    clients.push(otherProfileMcp);
    await expect(otherProfileMcp.request("broker.status", {}, "profile-other"))
      .resolves.toMatchObject({ browserConnected: true });
  });
});
