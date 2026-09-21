#!/usr/bin/env node
/**
 * E09 installed-package verifier for two explicitly authorized, separate
 * Captures. It creates one reprocess Job with two local artifacts, proves a
 * terminal ACK can be lost to a closed SDK stdio client and replayed exactly,
 * then records one permitted retry before failing the other pending Job.
 *
 * The verifier never commits a cleanup preview and never writes source text
 * to stdout or its evidence report.
 */
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const INSPECTOR_PACKAGE = "@modelcontextprotocol/inspector@2.7.0";
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
const FIRST_AGENT_ID = "babel-e09-reprocess-reconnect-verifier";
const SECOND_AGENT_ID = "babel-e09-retry-failure-verifier";

function usage() {
  return [
    "node packages/mcp/scripts/verify-mcp-batch-retry-reconnect.mjs --config-dir DIR --profile-id PROFILE --completed-capture-id ID --completed-parent-job-id ID --retry-capture-id ID --retry-job-id ID --untouched-capture-id ID --untouched-job-id ID --task-output-root DIR --protected-parent-output-root DIR --run-id ID --confirm-completed-parent-job ID --confirm-retry-job ID --confirm-untouched-job ID [--cli PATH] [--evidence-out FILE]",
    "",
    "Uses exactly two authorized Capture/Job paths: creates and completes one reprocess Job with two files while deliberately dropping its terminal SDK response before exact replay, then records retryCount=1 and a terminal failure on the other pending Job. Cleanup is preview-only.",
  ].join("\n");
}

function parseArguments(argv) {
  const names = new Set([
    "config-dir", "profile-id", "completed-capture-id", "completed-parent-job-id", "retry-capture-id", "retry-job-id",
    "untouched-capture-id", "untouched-job-id",
    "task-output-root", "protected-parent-output-root", "run-id", "confirm-completed-parent-job", "confirm-retry-job", "confirm-untouched-job",
    "cli", "evidence-out",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("--")) throw new Error("Unexpected positional argument.");
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (!names.has(name)) throw new Error(`Unknown option --${name}`);
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (!value || value.startsWith("--")) throw new Error(`Option --${name} requires a value.`);
    if (values.has(name)) throw new Error(`Option --${name} was supplied more than once.`);
    values.set(name, value);
  }
  const required = [
    "config-dir", "profile-id", "completed-capture-id", "completed-parent-job-id", "retry-capture-id", "retry-job-id",
    "untouched-capture-id", "untouched-job-id", "task-output-root", "protected-parent-output-root", "run-id",
    "confirm-completed-parent-job", "confirm-retry-job", "confirm-untouched-job",
  ];
  if (required.some((name) => !values.has(name))) {
    throw new Error("All target and confirmation options are required.\n\n" + usage());
  }
  const taskOutputRoot = values.get("task-output-root");
  const protectedParentOutputRoot = values.get("protected-parent-output-root");
  if (!isAbsolute(taskOutputRoot) || !isAbsolute(protectedParentOutputRoot)) {
    throw new Error("--task-output-root and --protected-parent-output-root must be absolute local paths.");
  }
  const runId = values.get("run-id");
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(runId)) {
    throw new Error("--run-id must contain only letters, digits, dot, underscore, or dash.");
  }
  const completedParentJobId = values.get("completed-parent-job-id");
  const retryJobId = values.get("retry-job-id");
  const untouchedJobId = values.get("untouched-job-id");
  if (values.get("confirm-completed-parent-job") !== completedParentJobId) {
    throw new Error("--confirm-completed-parent-job must exactly match --completed-parent-job-id.");
  }
  if (values.get("confirm-retry-job") !== retryJobId) {
    throw new Error("--confirm-retry-job must exactly match --retry-job-id.");
  }
  if (values.get("confirm-untouched-job") !== untouchedJobId) {
    throw new Error("--confirm-untouched-job must exactly match --untouched-job-id.");
  }
  const captureIds = [values.get("completed-capture-id"), values.get("retry-capture-id"), values.get("untouched-capture-id")];
  if (new Set(captureIds).size !== captureIds.length) {
    throw new Error("The completed, retry, and untouched Capture ids must be distinct.");
  }
  const evidenceOut = values.get("evidence-out");
  if (evidenceOut !== undefined && !isAbsolute(evidenceOut)) {
    throw new Error("--evidence-out must be an absolute path.");
  }
  return {
    configDirectory: resolve(values.get("config-dir")),
    profileId: values.get("profile-id"),
    completedCaptureId: values.get("completed-capture-id"),
    completedParentJobId,
    retryCaptureId: values.get("retry-capture-id"),
    retryJobId,
    untouchedCaptureId: values.get("untouched-capture-id"),
    untouchedJobId,
    taskOutputRoot: resolve(taskOutputRoot),
    protectedParentOutputRoot: resolve(protectedParentOutputRoot),
    runId,
    cliPath: resolve(values.get("cli") ?? "dist/node/cli.js"),
    ...(evidenceOut === undefined ? {} : { evidenceOut: resolve(evidenceOut) }),
  };
}

function fingerprint(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathInside(root, candidate) {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function safeSegment(value, label) {
  if (!/^[A-Za-z0-9._-]{1,256}$/u.test(value)) throw new Error(`${label} cannot safely name an output directory.`);
  return value;
}

function toolPayload(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
    throw new Error("MCP tool did not return a content payload.");
  }
  const content = result.content.find((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string");
  if (!content) throw new Error("MCP tool did not return a text payload.");
  let payload;
  try {
    payload = JSON.parse(content.text);
  } catch {
    throw new Error("MCP tool returned an invalid JSON payload.");
  }
  if (!payload || typeof payload !== "object") throw new Error("MCP tool returned an invalid payload object.");
  return payload;
}

function successfulResult(payload, operation) {
  if (payload.ok !== true || !payload.result || typeof payload.result !== "object") {
    const code = payload?.error?.code;
    throw new Error(`${operation} failed${typeof code === "string" ? ` (${code})` : ""}.`);
  }
  return payload.result;
}

async function callTool(client, name, args, operation) {
  return successfulResult(toolPayload(await client.callTool({ name, arguments: args })), operation);
}

function findJob(detail, jobId, label = "explicitly authorized") {
  const jobs = Array.isArray(detail?.jobs) ? detail.jobs : [];
  const job = jobs.find((candidate) => candidate && typeof candidate === "object" && candidate.jobId === jobId);
  if (!job) throw new Error(`The ${label} job was not found in its Capture.`);
  return job;
}

function findResult(detail, jobId) {
  const results = Array.isArray(detail?.results) ? detail.results : [];
  return results.find((candidate) => candidate && typeof candidate === "object" && candidate.jobId === jobId);
}

function sourceText(detail) {
  const selection = detail?.capture?.selection;
  const text = selection?.type === "text" && typeof selection.exact === "string" ? selection.exact : undefined;
  if (!text) throw new Error("The completed parent Capture has no non-empty text selection for the authorized reprocess artifact.");
  return text;
}

function recordsFrom(value) {
  return Array.isArray(value?.records) ? value.records.filter((item) => item && typeof item === "object") : [];
}

function unrelatedSnapshot(records, excludedCaptureIds) {
  return records
    .filter((record) => typeof record.captureId === "string" && !excludedCaptureIds.has(record.captureId))
    .map((record) => ({
      captureId: record.captureId,
      latestJobId: typeof record.latestJobId === "string" ? record.latestJobId : undefined,
      latestJobStatus: typeof record.latestJobStatus === "string" ? record.latestJobStatus : undefined,
    }))
    .sort((left, right) => left.captureId.localeCompare(right.captureId));
}

function redactedRecords(records) {
  return records.map((record) => ({
    capture: fingerprint(record.captureId),
    ...(record.latestJobId === undefined ? {} : { latestJob: fingerprint(record.latestJobId) }),
    ...(record.latestJobStatus === undefined ? {} : { latestJobStatus: record.latestJobStatus }),
  }));
}

async function assertFreshOutputRoot(path) {
  try {
    await lstat(path);
    throw new Error("--task-output-root already exists; choose a unique evidence directory so no file can be overwritten.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function protectParentArtifact(detail, parentJobId, root) {
  const result = findResult(detail, parentJobId);
  const artifact = Array.isArray(result?.artifacts)
    ? result.artifacts.find((candidate) => candidate && typeof candidate === "object" && typeof candidate.fileReference === "string")
    : undefined;
  if (!artifact || typeof artifact.fileReference !== "string") {
    throw new Error("The completed parent Result has no persisted external artifact to protect.");
  }
  const realRoot = await realpath(root);
  const fileReference = resolve(artifact.fileReference);
  const canonicalParent = await realpath(dirname(fileReference));
  const canonicalFile = join(canonicalParent, basename(fileReference));
  if (!pathInside(realRoot, canonicalFile)) {
    throw new Error("The completed parent artifact is outside the explicitly protected output root.");
  }
  const [metadata, bytes] = await Promise.all([lstat(fileReference), readFile(fileReference)]);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The completed parent artifact is not a regular local file.");
  }
  const hash = sha256(bytes);
  if (artifact.byteLength !== bytes.byteLength || artifact.metadata?.sha256 !== hash) {
    throw new Error("The completed parent artifact does not match its persisted size/hash.");
  }
  return { fileReference, fileName: basename(fileReference), byteLength: bytes.byteLength, sha256: hash };
}

async function writeExclusive(path, bytes) {
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("A dedicated verifier artifact path already exists; refusing to overwrite it.");
    throw error;
  }
  const [metadata, saved] = await Promise.all([lstat(path), readFile(path)]);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !saved.equals(bytes)) {
    throw new Error("A verifier artifact did not pass byte-for-byte local verification.");
  }
  return { path, fileName: basename(path), byteLength: saved.byteLength, sha256: sha256(saved) };
}

async function writeReprocessArtifacts(directory, text, options) {
  const realDirectory = await realpath(directory);
  const textPath = resolve(realDirectory, "selected-text.txt");
  const manifestPath = resolve(realDirectory, "selection-manifest.json");
  if (!pathInside(realDirectory, textPath) || !pathInside(realDirectory, manifestPath)) {
    throw new Error("A derived reprocess artifact path escaped the persisted job directory.");
  }
  const textBytes = Buffer.from(text, "utf8");
  const textArtifact = await writeExclusive(textPath, textBytes);
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: "text_selection_manifest",
    sourceByteLength: textArtifact.byteLength,
    sourceSha256: textArtifact.sha256,
    verificationRun: options.runId,
    contentStoredSeparately: true,
  }, null, 2) + "\n", "utf8");
  const manifestArtifact = await writeExclusive(manifestPath, manifestBytes);
  return { directory: realDirectory, textArtifact, manifestArtifact };
}

async function verifyRegularArtifact(artifact, directory) {
  const canonicalDirectory = await realpath(directory);
  const canonicalParent = await realpath(dirname(artifact.path));
  const canonicalPath = join(canonicalParent, basename(artifact.path));
  if (!pathInside(canonicalDirectory, canonicalPath)) {
    throw new Error("An external artifact escaped its persisted job directory.");
  }
  const [metadata, bytes] = await Promise.all([lstat(artifact.path), readFile(artifact.path)]);
  if (!metadata.isFile() || metadata.isSymbolicLink() || bytes.byteLength !== artifact.byteLength || sha256(bytes) !== artifact.sha256) {
    throw new Error("An external artifact changed after local verification.");
  }
}

function claimedDirectory(item) {
  const directory = item?.job?.directory?.path;
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw new Error("The accepted claim did not return a persisted absolute output directory.");
  }
  return directory;
}

async function resolvedClaimDirectory(requested, persisted) {
  const [requestedReal, persistedReal] = await Promise.all([realpath(requested), realpath(persisted)]);
  if (requestedReal !== persistedReal) {
    throw new Error("The persisted claim directory does not match the explicitly requested task directory.");
  }
  return persistedReal;
}

function acceptedClaim(result, jobId, operation) {
  if (result.ack?.persisted !== true || !Array.isArray(result.items)) {
    throw new Error(`${operation} did not return an IndexedDB persistence acknowledgement.`);
  }
  const item = result.items.find((candidate) => candidate && candidate.jobId === jobId && candidate.disposition === "accepted");
  if (!item || typeof item.claimToken !== "string") {
    throw new Error(`${operation} did not accept the explicitly authorized pending job.`);
  }
  return item;
}

function startClient(options, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.cliPath, "--mode=mcp", "--config-dir", options.configDirectory, "--profile-id", options.profileId],
    cwd: dirname(options.cliPath),
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  return { client, transport };
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolveResult(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isResponseFor(message, id) {
  return message && typeof message === "object" && message.id === id &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
}

/**
 * Sends the actual terminal tools/call over the official SDK stdio transport.
 * Once its JSON-RPC response reaches the client transport, intercept it before
 * Client can receive it and close stdin. A later transport replays the exact
 * same requestId/payload and must receive the persisted ACK.
 */
async function submitTerminalAndDropResponse(client, transport, payload) {
  const originalSend = transport.send.bind(transport);
  const originalOnMessage = transport.onmessage;
  let terminalRequestId;
  let resolveDropped;
  let rejectDropped;
  const dropped = new Promise((resolveResult, reject) => {
    resolveDropped = resolveResult;
    rejectDropped = reject;
  });
  transport.send = (message, sendOptions) => {
    if (message?.method === "tools/call" && message?.params?.name === "babel_clipper_commit_result") {
      if (terminalRequestId !== undefined) throw new Error("The ACK-loss verifier attempted more than one terminal tools/call on its first transport.");
      terminalRequestId = message.id;
    }
    return originalSend(message, sendOptions);
  };
  transport.onmessage = (message, extra) => {
    if (terminalRequestId !== undefined && isResponseFor(message, terminalRequestId)) {
      // Intentionally do not parse or forward this terminal ACK to Client.
      resolveDropped({ requestId: terminalRequestId, responseObserved: true, responseDropped: true });
      return;
    }
    originalOnMessage?.(message, extra);
  };
  const pending = client.callTool({ name: "babel_clipper_commit_result", arguments: payload });
  pending.catch(() => undefined);
  try {
    return await withTimeout(dropped, 30_000, "The terminal response to drop");
  } catch (error) {
    rejectDropped?.(error);
    throw error;
  } finally {
    await transport.close().catch(() => undefined);
  }
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_CAPTURED_OUTPUT_BYTES) return current;
  return (current + chunk).slice(0, MAX_CAPTURED_OUTPUT_BYTES);
}

async function runProcess(command, args, environment) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: resolve("."),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk.toString("utf8")); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk.toString("utf8")); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout, stderr }); });
  });
}

async function inspectorGetRecord(options, captureId, npmCache) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const execution = await runProcess(command, [
    "--yes", INSPECTOR_PACKAGE, "--cli", process.execPath, options.cliPath,
    "--mode=mcp", "--config-dir", options.configDirectory, "--profile-id", options.profileId,
    "--", "--method", "tools/call", "--tool-name", "babel_clipper_get_record",
    "--tool-args-json", JSON.stringify({ captureId }), "--format", "json",
  ], {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false",
    NO_COLOR: "1",
  });
  if (execution.code !== 0) {
    const suffix = execution.code === null ? `signal ${execution.signal ?? "unknown"}` : `exit ${execution.code}`;
    throw new Error(`Inspector persisted-record read failed (${suffix}); see isolated process stderr locally.`);
  }
  let envelope;
  try {
    envelope = JSON.parse(execution.stdout);
  } catch {
    throw new Error("Inspector did not return machine-readable JSON.");
  }
  return successfulResult(toolPayload(envelope?.result), "Inspector persisted-record read");
}

async function writeEvidence(path, report) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await access(path);
    throw new Error("Evidence target already exists; choose a new path to avoid overwriting prior evidence.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return;
  }
  await Promise.all([access(options.cliPath), assertFreshOutputRoot(options.taskOutputRoot)]);

  const first = startClient(options, "babel-content-clipper-e09-first-transport");
  const npmCache = await mkdtemp(join(tmpdir(), "babel-clipper-inspector-batch-retry-"));
  let reconnect;
  try {
    await first.client.connect(first.transport);
    const status = await callTool(first.client, "babel_clipper_connection_status", {}, "SDK connection status");
    if (status?.browser?.browserAvailable !== true || status?.browser?.databaseAvailable !== true) {
      throw new Error("The selected installed-package browser profile is not ready for this verifier.");
    }

    const allBefore = await callTool(first.client, "babel_clipper_list_records", { view: "all", limit: 200 }, "SDK initial record snapshot");
    const excludedCaptureIds = new Set([options.completedCaptureId, options.retryCaptureId]);
    const unrelatedBefore = unrelatedSnapshot(recordsFrom(allBefore), excludedCaptureIds);

    const parentDetail = await callTool(first.client, "babel_clipper_get_record", { captureId: options.completedCaptureId }, "SDK completed parent read");
    const retryDetailBefore = await callTool(first.client, "babel_clipper_get_record", { captureId: options.retryCaptureId }, "SDK retry target read");
    const untouchedDetailBefore = await callTool(first.client, "babel_clipper_get_record", { captureId: options.untouchedCaptureId }, "SDK untouched third-record read");
    const parentJob = findJob(parentDetail, options.completedParentJobId, "completed parent");
    const parentResult = findResult(parentDetail, options.completedParentJobId);
    const retryJobBefore = findJob(retryDetailBefore, options.retryJobId, "retry target");
    const untouchedJobBefore = findJob(untouchedDetailBefore, options.untouchedJobId, "protected third");
    if (parentJob.status !== "completed" || parentResult?.status !== "completed") {
      throw new Error("The authorized E09 parent job/result is not completed; no reprocess Job will be created.");
    }
    if (retryJobBefore.status !== "pending" || findResult(retryDetailBefore, options.retryJobId) !== undefined) {
      throw new Error("The authorized retry target job is not an untouched pending job.");
    }
    if (untouchedJobBefore.status !== "pending" || untouchedJobBefore.claim !== undefined || findResult(untouchedDetailBefore, options.untouchedJobId) !== undefined) {
      throw new Error("The explicitly protected third job is not an untouched pending job.");
    }
    const parentArtifact = await protectParentArtifact(parentDetail, options.completedParentJobId, options.protectedParentOutputRoot);
    const capturedText = sourceText(parentDetail);

    const reprocess = await callTool(first.client, "babel_clipper_reprocess_record", {
      requestId: `${options.runId}-reprocess`,
      captureId: options.completedCaptureId,
      parentJobId: options.completedParentJobId,
    }, "SDK reprocess creation");
    if (reprocess.ack?.persisted !== true || !reprocess.value || typeof reprocess.value.jobId !== "string" || reprocess.value.status !== "pending") {
      throw new Error("SDK reprocess did not return a persisted pending job.");
    }
    const reprocessJobId = reprocess.value.jobId;
    if (reprocessJobId === options.completedParentJobId || reprocessJobId === options.retryJobId) {
      throw new Error("The new reprocess Job id is not independent from the authorized existing jobs.");
    }
    const reprocessDirectory = resolve(options.taskOutputRoot, safeSegment(reprocessJobId, "Reprocess job id"));
    if (!pathInside(options.taskOutputRoot, reprocessDirectory)) throw new Error("The reprocess output directory escaped its dedicated evidence root.");
    const reprocessClaim = await callTool(first.client, "babel_clipper_claim_records", {
      requestId: `${options.runId}-reprocess-claim`,
      agentId: FIRST_AGENT_ID,
      jobIds: [reprocessJobId],
      taskOutputDirectory: reprocessDirectory,
      requireOutputDirectory: true,
    }, "SDK reprocess claim");
    const reprocessClaimItem = acceptedClaim(reprocessClaim, reprocessJobId, "SDK reprocess claim");
    const persistedReprocessDirectory = await resolvedClaimDirectory(reprocessDirectory, claimedDirectory(reprocessClaimItem));
    const reprocessArtifacts = await writeReprocessArtifacts(persistedReprocessDirectory, capturedText, options);

    const reprocessCompletePayload = {
      requestId: `${options.runId}-reprocess-complete`,
      jobId: reprocessJobId,
      claimToken: reprocessClaimItem.claimToken,
      outcome: "completed",
      acquisitionMethod: "saved_text",
      artifacts: [
        {
          assetId: `e09-reprocess-text-${options.runId}`,
          kind: "text",
          mimeType: "text/plain",
          fileReference: reprocessArtifacts.textArtifact.path,
          byteLength: reprocessArtifacts.textArtifact.byteLength,
          metadata: { sha256: reprocessArtifacts.textArtifact.sha256, encoding: "utf-8" },
        },
        {
          assetId: `e09-reprocess-manifest-${options.runId}`,
          kind: "manifest",
          mimeType: "application/json",
          fileReference: reprocessArtifacts.manifestArtifact.path,
          byteLength: reprocessArtifacts.manifestArtifact.byteLength,
          metadata: { sha256: reprocessArtifacts.manifestArtifact.sha256, schemaVersion: 1 },
        },
      ],
      verification: {
        level: "agent_reported",
        fileExists: true,
        warnings: ["The verifier wrote and byte-checked two local artifacts; semantic text equivalence remains agent-reported."],
        metadata: {
          textSha256: reprocessArtifacts.textArtifact.sha256,
          manifestSha256: reprocessArtifacts.manifestArtifact.sha256,
        },
      },
    };
    const droppedAck = await submitTerminalAndDropResponse(first.client, first.transport, reprocessCompletePayload);

    reconnect = startClient(options, "babel-content-clipper-e09-reconnect-transport");
    await reconnect.client.connect(reconnect.transport);
    const afterDropDetail = await callTool(reconnect.client, "babel_clipper_get_record", { captureId: options.completedCaptureId }, "SDK post-disconnect reprocess read");
    const reprocessAfterDrop = findJob(afterDropDetail, reprocessJobId, "new reprocess");
    const reprocessResultAfterDrop = findResult(afterDropDetail, reprocessJobId);
    if (reprocessAfterDrop.status !== "completed" || reprocessResultAfterDrop?.status !== "completed") {
      throw new Error("The terminal response was dropped but the actual browser record is not completed; no synthetic ACK claim is made.");
    }
    const replay = await callTool(reconnect.client, "babel_clipper_commit_result", reprocessCompletePayload, "SDK terminal replay after dropped ACK");
    if (
      replay.ack?.persisted !== true || replay.job?.status !== "completed" ||
      replay.result?.resultId !== reprocessResultAfterDrop.resultId
    ) {
      throw new Error("The reconnect client did not receive the persisted idempotent terminal replay acknowledgement.");
    }
    await Promise.all([
      verifyRegularArtifact(reprocessArtifacts.textArtifact, persistedReprocessDirectory),
      verifyRegularArtifact(reprocessArtifacts.manifestArtifact, persistedReprocessDirectory),
    ]);

    const retryDirectory = resolve(options.taskOutputRoot, safeSegment(options.retryJobId, "Retry job id"));
    if (!pathInside(options.taskOutputRoot, retryDirectory)) throw new Error("The retry output directory escaped its dedicated evidence root.");
    const retryClaim = await callTool(reconnect.client, "babel_clipper_claim_records", {
      requestId: `${options.runId}-retry-claim`,
      agentId: SECOND_AGENT_ID,
      jobIds: [options.retryJobId],
      taskOutputDirectory: retryDirectory,
      requireOutputDirectory: true,
    }, "SDK retry target claim");
    const retryClaimItem = acceptedClaim(retryClaim, options.retryJobId, "SDK retry target claim");
    await resolvedClaimDirectory(retryDirectory, claimedDirectory(retryClaimItem));
    const retryHeartbeat = await callTool(reconnect.client, "babel_clipper_heartbeat_job", {
      requestId: `${options.runId}-retry-heartbeat`,
      jobId: options.retryJobId,
      claimToken: retryClaimItem.claimToken,
      stage: "temporary_retry",
      retryCount: 1,
      state: "active",
      message: "One permitted transient retry was recorded for this dedicated acceptance job.",
    }, "SDK permitted retry heartbeat");
    if (retryHeartbeat.ack?.persisted !== true || retryHeartbeat.value?.status !== "processing" || retryHeartbeat.value?.claim?.claimToken !== retryClaimItem.claimToken) {
      throw new Error("The permitted retry heartbeat did not persist while retaining the original claim.");
    }
    const retryFailure = await callTool(reconnect.client, "babel_clipper_commit_result", {
      requestId: `${options.runId}-retry-failed`,
      jobId: options.retryJobId,
      claimToken: retryClaimItem.claimToken,
      outcome: "failed",
      verification: {
        level: "agent_reported",
        warnings: ["Dedicated acceptance job recorded one permitted transient retry before its final simulated failure."],
      },
      failure: {
        code: "ACCEPTANCE_TRANSIENT_RETRY_EXHAUSTED",
        message: "The dedicated retry acceptance job ended after its permitted transient retry.",
        stage: "temporary_retry",
        retryCount: 1,
        retryable: false,
        details: { verificationRun: options.runId },
      },
    }, "SDK terminal retry failure");
    if (
      retryFailure.ack?.persisted !== true || retryFailure.job?.status !== "failed" ||
      retryFailure.result?.failure?.code !== "ACCEPTANCE_TRANSIENT_RETRY_EXHAUSTED" ||
      retryFailure.result?.failure?.retryCount !== 1
    ) {
      throw new Error("The retry target did not persist the expected terminal failure after retryCount=1.");
    }

    const cleanupPreview = await callTool(reconnect.client, "babel_clipper_cleanup_preview", {
      requestId: `${options.runId}-cleanup-preview-only`,
      scope: "capture_ids",
      captureIds: [options.retryCaptureId],
      includeFailed: true,
    }, "SDK cleanup preview");
    if (
      cleanupPreview.ack?.persisted !== true || cleanupPreview.externalFilesPreserved !== true ||
      !Array.isArray(cleanupPreview.candidates) || !cleanupPreview.candidates.some((candidate) => candidate.captureId === options.retryCaptureId)
    ) {
      throw new Error("The cleanup preview did not return the failed dedicated Capture without an external-file preservation guarantee.");
    }
    // Deliberately no babel_clipper_cleanup_commit call: main UI history remains intact for Luna's review.

    const allAfter = await callTool(reconnect.client, "babel_clipper_list_records", { view: "all", limit: 200 }, "SDK final record snapshot");
    const unrelatedAfter = unrelatedSnapshot(recordsFrom(allAfter), excludedCaptureIds);
    const priorUnrelatedIds = new Set(unrelatedBefore.map((record) => record.captureId));
    const appearedDuringRun = unrelatedAfter.filter((record) => !priorUnrelatedIds.has(record.captureId));
    const pendingAfter = await callTool(reconnect.client, "babel_clipper_list_records", { view: "pending", limit: 200 }, "SDK pending-record read after failure");
    if (recordsFrom(pendingAfter).some((record) => record.captureId === options.retryCaptureId)) {
      throw new Error("The terminal failed retry Capture is still exposed as pending work.");
    }
    const untouchedDetailAfter = await callTool(reconnect.client, "babel_clipper_get_record", { captureId: options.untouchedCaptureId }, "SDK final untouched third-record read");
    const untouchedJobAfter = findJob(untouchedDetailAfter, options.untouchedJobId, "protected third");
    if (
      untouchedJobAfter.status !== "pending" || untouchedJobAfter.claim !== undefined ||
      findResult(untouchedDetailAfter, options.untouchedJobId) !== undefined ||
      !recordsFrom(pendingAfter).some((record) => record.captureId === options.untouchedCaptureId && record.latestJobId === options.untouchedJobId && record.latestJobStatus === "pending")
    ) {
      throw new Error("The explicitly protected third pending job changed or was no longer exposed as pending work.");
    }

    const [inspectorParent, inspectorRetry] = [
      await inspectorGetRecord(options, options.completedCaptureId, npmCache),
      await inspectorGetRecord(options, options.retryCaptureId, npmCache),
    ];
    const inspectorParentJob = findJob(inspectorParent, options.completedParentJobId, "Inspector completed parent");
    const inspectorParentResult = findResult(inspectorParent, options.completedParentJobId);
    const inspectorReprocessJob = findJob(inspectorParent, reprocessJobId, "Inspector reprocess");
    const inspectorReprocessResult = findResult(inspectorParent, reprocessJobId);
    const inspectorRetryJob = findJob(inspectorRetry, options.retryJobId, "Inspector retry target");
    const inspectorRetryResult = findResult(inspectorRetry, options.retryJobId);
    const inspectorParentArtifact = Array.isArray(inspectorParentResult?.artifacts)
      ? inspectorParentResult.artifacts.find((artifact) => artifact && typeof artifact === "object" && artifact.fileReference === parentArtifact.fileReference)
      : undefined;
    const inspectorTextArtifact = Array.isArray(inspectorReprocessResult?.artifacts)
      ? inspectorReprocessResult.artifacts.find((artifact) => artifact && typeof artifact === "object" && artifact.fileReference === reprocessArtifacts.textArtifact.path)
      : undefined;
    const inspectorManifestArtifact = Array.isArray(inspectorReprocessResult?.artifacts)
      ? inspectorReprocessResult.artifacts.find((artifact) => artifact && typeof artifact === "object" && artifact.fileReference === reprocessArtifacts.manifestArtifact.path)
      : undefined;
    const retryEvent = Array.isArray(inspectorRetry?.events)
      ? inspectorRetry.events.find((event) => event && typeof event === "object" && event.jobId === options.retryJobId && event.type === "retry" && event.retryCount === 1)
      : undefined;
    const parentBytesAfter = await readFile(parentArtifact.fileReference);
    if (
      inspectorParentJob.status !== "completed" || inspectorParentResult?.status !== "completed" ||
      inspectorParentArtifact?.byteLength !== parentArtifact.byteLength || inspectorParentArtifact?.metadata?.sha256 !== parentArtifact.sha256 ||
      sha256(parentBytesAfter) !== parentArtifact.sha256 ||
      inspectorReprocessJob.status !== "completed" || inspectorReprocessResult?.status !== "completed" ||
      inspectorReprocessResult?.resultId !== replay.result?.resultId ||
      inspectorTextArtifact?.metadata?.sha256 !== reprocessArtifacts.textArtifact.sha256 ||
      inspectorManifestArtifact?.metadata?.sha256 !== reprocessArtifacts.manifestArtifact.sha256 ||
      inspectorRetryJob.status !== "failed" || inspectorRetryResult?.status !== "failed" ||
      inspectorRetryResult?.failure?.retryCount !== 1 || inspectorRetryJob?.claim?.claimToken !== retryClaimItem.claimToken ||
      !retryEvent
    ) {
      throw new Error("Inspector did not confirm independent completed and failed histories with preserved external artifacts and retry ownership.");
    }

    const report = {
      schemaVersion: 1,
      result: "pass",
      profile: fingerprint(options.profileId),
      run: fingerprint(options.runId),
      targets: {
        completedCapture: fingerprint(options.completedCaptureId),
        completedParentJob: fingerprint(options.completedParentJobId),
        reprocessJob: fingerprint(reprocessJobId),
        retryCapture: fingerprint(options.retryCaptureId),
        retryJob: fingerprint(options.retryJobId),
        untouchedCapture: fingerprint(options.untouchedCaptureId),
        untouchedJob: fingerprint(options.untouchedJobId),
      },
      preservedParent: {
        fileName: parentArtifact.fileName,
        byteLength: parentArtifact.byteLength,
        sha256: parentArtifact.sha256,
        status: inspectorParentJob.status,
      },
      reprocessCompletion: {
        creationAckPersisted: true,
        claimAckPersisted: true,
        droppedTerminalResponse: { transport: "official_sdk_stdio", ...droppedAck },
        replayAckPersisted: true,
        status: replay.job.status,
        result: fingerprint(replay.result.resultId),
        artifacts: [
          { fileName: reprocessArtifacts.textArtifact.fileName, byteLength: reprocessArtifacts.textArtifact.byteLength, sha256: reprocessArtifacts.textArtifact.sha256 },
          { fileName: reprocessArtifacts.manifestArtifact.fileName, byteLength: reprocessArtifacts.manifestArtifact.byteLength, sha256: reprocessArtifacts.manifestArtifact.sha256 },
        ],
      },
      retryFailure: {
        claimAckPersisted: true,
        heartbeatAckPersisted: true,
        retryCount: 1,
        originalClaimRetained: true,
        completeAckPersisted: true,
        status: retryFailure.job.status,
        failureCode: retryFailure.result.failure.code,
        failedNotPending: true,
      },
      cleanupPreview: {
        ackPersisted: true,
        candidateCount: cleanupPreview.candidates.length,
        externalFilesPreserved: cleanupPreview.externalFilesPreserved,
        commitDeferred: true,
      },
      protectedThirdPending: {
        readBeforeStatus: untouchedJobBefore.status,
        readAfterStatus: untouchedJobAfter.status,
        claimAbsentBeforeAndAfter: true,
        resultAbsentBeforeAndAfter: true,
        pendingListRetained: true,
      },
      unrelatedRecords: {
        snapshottedBefore: redactedRecords(unrelatedBefore),
        observedAfter: redactedRecords(unrelatedAfter),
        appearedDuringRunUntouched: redactedRecords(appearedDuringRun),
      },
      inspector: {
        package: INSPECTOR_PACKAGE,
        parentStatus: inspectorParentJob.status,
        reprocessStatus: inspectorReprocessJob.status,
        retryStatus: inspectorRetryJob.status,
        retryEventPersisted: true,
      },
      scope: "Exactly two explicitly authorized Capture/Job paths were claimed. A third-party Capture, if present, was only snapshotted. No cleanup commit was sent.",
      uiAckStillRequired: "The browser-test owner must separately confirm the extension UI preserves the original E09 completed history, shows the independent reprocess completion, and shows the retry failure diagnostic.",
    };
    if (options.evidenceOut !== undefined) await writeEvidence(options.evidenceOut, report);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally {
    await Promise.allSettled([
      first.client.close(),
      reconnect?.client.close(),
    ]);
    await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`E09_MCP_BATCH_RETRY_RECONNECT_VERIFICATION_FAILED: ${error instanceof Error ? error.message : "unexpected failure"}\n`);
  process.exitCode = 1;
});
