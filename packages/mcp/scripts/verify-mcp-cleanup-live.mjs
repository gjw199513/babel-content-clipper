#!/usr/bin/env node
/**
 * Explicitly authorized, installed-package cleanup verification.
 *
 * It previews exactly three named test Captures, commits only the sole
 * completed candidate, verifies external artifacts remain byte-identical,
 * and uses the official MCP Inspector CLI to confirm that the failed and
 * pending records remain while the completed record is gone.
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

function usage() {
  return [
    "node packages/mcp/scripts/verify-mcp-cleanup-live.mjs --config-dir DIR --profile-id PROFILE --completed-capture-id ID --failed-capture-id ID --pending-capture-id ID --protected-output-root DIR --run-id ID --confirm-completed-capture ID --confirm-failed-capture ID --confirm-pending-capture ID --evidence-out FILE [--cli PATH]",
    "",
    "This is an explicit cleanup acceptance verifier. It previews only the three supplied Captures with includeFailed=false, commits only the completed candidate, and never claims Jobs or deletes external files.",
  ].join("\n");
}

function parseArguments(argv) {
  const names = new Set([
    "config-dir", "profile-id", "completed-capture-id", "failed-capture-id", "pending-capture-id",
    "protected-output-root", "run-id", "confirm-completed-capture", "confirm-failed-capture",
    "confirm-pending-capture", "evidence-out", "cli",
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
    "config-dir", "profile-id", "completed-capture-id", "failed-capture-id", "pending-capture-id",
    "protected-output-root", "run-id", "confirm-completed-capture", "confirm-failed-capture",
    "confirm-pending-capture", "evidence-out",
  ];
  if (required.some((name) => !values.has(name))) throw new Error("All target and confirmation options are required.\n\n" + usage());
  const captures = [values.get("completed-capture-id"), values.get("failed-capture-id"), values.get("pending-capture-id")];
  if (new Set(captures).size !== captures.length) throw new Error("The completed, failed, and pending Capture ids must be distinct.");
  if (values.get("confirm-completed-capture") !== values.get("completed-capture-id")) {
    throw new Error("--confirm-completed-capture must exactly match --completed-capture-id.");
  }
  if (values.get("confirm-failed-capture") !== values.get("failed-capture-id")) {
    throw new Error("--confirm-failed-capture must exactly match --failed-capture-id.");
  }
  if (values.get("confirm-pending-capture") !== values.get("pending-capture-id")) {
    throw new Error("--confirm-pending-capture must exactly match --pending-capture-id.");
  }
  const protectedOutputRoot = values.get("protected-output-root");
  const evidenceOut = values.get("evidence-out");
  if (!isAbsolute(protectedOutputRoot) || !isAbsolute(evidenceOut)) {
    throw new Error("--protected-output-root and --evidence-out must be absolute local paths.");
  }
  const runId = values.get("run-id");
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(runId)) {
    throw new Error("--run-id must contain only letters, digits, dot, underscore, or dash.");
  }
  return {
    configDirectory: resolve(values.get("config-dir")),
    profileId: values.get("profile-id"),
    completedCaptureId: values.get("completed-capture-id"),
    failedCaptureId: values.get("failed-capture-id"),
    pendingCaptureId: values.get("pending-capture-id"),
    protectedOutputRoot: resolve(protectedOutputRoot),
    runId,
    evidenceOut: resolve(evidenceOut),
    cliPath: resolve(values.get("cli") ?? "dist/node/cli.js"),
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
    throw new Error("MCP tool returned invalid JSON.");
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

async function rawTool(client, name, args) {
  return toolPayload(await client.callTool({ name, arguments: args }));
}

async function callTool(client, name, args, operation) {
  return successfulResult(await rawTool(client, name, args), operation);
}

async function expectToolError(client, name, args, code, operation) {
  const payload = await rawTool(client, name, args);
  if (payload.ok !== false || payload?.error?.code !== code) {
    throw new Error(`${operation} did not return the expected ${code} error.`);
  }
  return payload.error;
}

function recordsFrom(value) {
  return Array.isArray(value?.records) ? value.records.filter((record) => record && typeof record === "object") : [];
}

function listJobs(detail) {
  return Array.isArray(detail?.jobs) ? detail.jobs.filter((job) => job && typeof job === "object") : [];
}

function listResults(detail) {
  return Array.isArray(detail?.results) ? detail.results.filter((result) => result && typeof result === "object") : [];
}

function latestJob(jobs) {
  return [...jobs].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
}

function assertCompletedCandidate(detail) {
  const jobs = listJobs(detail);
  const results = listResults(detail);
  if (jobs.length === 0 || results.length === 0 || jobs.some((job) => job.status !== "completed") || results.some((result) => result.status !== "completed")) {
    throw new Error("The explicitly authorized completed Capture is not a stable completed-only history.");
  }
  return { jobs, results };
}

function assertFailedProtected(detail) {
  const jobs = listJobs(detail);
  const results = listResults(detail);
  if (jobs.length === 0 || latestJob(jobs)?.status !== "failed" || !results.some((result) => result.status === "failed")) {
    throw new Error("The explicitly protected failed Capture is not a terminal failed history.");
  }
  return { jobs, results };
}

function assertPendingProtected(detail) {
  const jobs = listJobs(detail);
  const pending = jobs.filter((job) => job.status === "pending");
  if (pending.length === 0 || pending.some((job) => job.claim !== undefined) || listResults(detail).length !== 0) {
    throw new Error("The explicitly protected pending Capture is not unclaimed pending work.");
  }
  return { jobs, results: listResults(detail) };
}

async function artifactSnapshot(completedDetail, protectedOutputRoot) {
  const root = await realpath(protectedOutputRoot);
  const artifacts = [];
  for (const result of listResults(completedDetail)) {
    const resultArtifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    for (const artifact of resultArtifacts) {
      if (!artifact || typeof artifact !== "object" || typeof artifact.fileReference !== "string") continue;
      const fileReference = artifact.fileReference;
      const canonicalParent = await realpath(dirname(fileReference));
      const canonicalPath = join(canonicalParent, basename(fileReference));
      if (!pathInside(root, canonicalPath)) {
        throw new Error("A completed artifact is outside the explicitly protected local output root.");
      }
      const [metadata, bytes] = await Promise.all([lstat(fileReference), readFile(fileReference)]);
      const hash = sha256(bytes);
      if (!metadata.isFile() || metadata.isSymbolicLink() || artifact.byteLength !== bytes.byteLength || artifact.metadata?.sha256 !== hash) {
        throw new Error("A completed artifact failed pre-cleanup size/hash verification.");
      }
      artifacts.push({
        path: fileReference,
        fileName: basename(fileReference),
        byteLength: bytes.byteLength,
        sha256: hash,
      });
    }
  }
  if (artifacts.length !== 3) {
    throw new Error("The cleanup candidate does not have the expected three persisted external artifacts to protect.");
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

async function assertArtifactsUnchanged(artifacts, protectedOutputRoot) {
  const root = await realpath(protectedOutputRoot);
  for (const artifact of artifacts) {
    const canonicalParent = await realpath(dirname(artifact.path));
    const canonicalPath = join(canonicalParent, basename(artifact.path));
    if (!pathInside(root, canonicalPath)) throw new Error("An external artifact escaped its protected root after cleanup.");
    const [metadata, bytes] = await Promise.all([lstat(artifact.path), readFile(artifact.path)]);
    if (!metadata.isFile() || metadata.isSymbolicLink() || bytes.byteLength !== artifact.byteLength || sha256(bytes) !== artifact.sha256) {
      throw new Error("An external artifact changed while cleanup ran.");
    }
  }
}

function redactedRecords(records) {
  return records
    .map((record) => ({
      capture: typeof record.captureId === "string" ? fingerprint(record.captureId) : "unknown",
      ...(typeof record.latestJobId === "string" ? { latestJob: fingerprint(record.latestJobId) } : {}),
      ...(typeof record.latestJobStatus === "string" ? { latestJobStatus: record.latestJobStatus } : {}),
    }))
    .sort((left, right) => left.capture.localeCompare(right.capture));
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

async function inspectorGetRecordPayload(options, captureId, npmCache) {
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
  let envelope;
  try {
    envelope = JSON.parse(execution.stdout);
  } catch {
    const suffix = execution.code === null ? `signal ${execution.signal ?? "unknown"}` : `exit ${execution.code}`;
    throw new Error(`Inspector read failed (${suffix}) without machine-readable JSON.`);
  }
  const payload = toolPayload(envelope?.result);
  // Inspector exits nonzero for a tool result marked isError. That is the
  // expected transport behavior for the post-commit NOT_FOUND verification.
  if (execution.code !== 0 && payload.ok !== false) {
    const suffix = execution.code === null ? `signal ${execution.signal ?? "unknown"}` : `exit ${execution.code}`;
    throw new Error(`Inspector read failed unexpectedly (${suffix}).`);
  }
  return payload;
}

async function writeEvidence(path, report) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await access(path);
    throw new Error("Evidence target already exists; refusing to overwrite it.");
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
  await Promise.all([access(options.cliPath), access(options.protectedOutputRoot)]);
  const sdk = startClient(options, "babel-content-clipper-cleanup-live-verifier");
  const npmCache = await mkdtemp(join(tmpdir(), "babel-clipper-inspector-cleanup-"));
  try {
    await sdk.client.connect(sdk.transport);
    const status = await callTool(sdk.client, "babel_clipper_connection_status", {}, "SDK connection status");
    if (status?.browser?.browserAvailable !== true || status?.browser?.databaseAvailable !== true) {
      throw new Error("The installed-package browser profile is not ready for cleanup verification.");
    }

    const targets = new Set([options.completedCaptureId, options.failedCaptureId, options.pendingCaptureId]);
    const allBefore = await callTool(sdk.client, "babel_clipper_list_records", { view: "all", limit: 200 }, "SDK initial record list");
    const unrelatedBefore = recordsFrom(allBefore).filter((record) => !targets.has(record.captureId));
    const [completedBefore, failedBefore, pendingBefore] = await Promise.all([
      callTool(sdk.client, "babel_clipper_get_record", { captureId: options.completedCaptureId }, "SDK completed candidate read"),
      callTool(sdk.client, "babel_clipper_get_record", { captureId: options.failedCaptureId }, "SDK failed protection read"),
      callTool(sdk.client, "babel_clipper_get_record", { captureId: options.pendingCaptureId }, "SDK pending protection read"),
    ]);
    const completedRelations = assertCompletedCandidate(completedBefore);
    assertFailedProtected(failedBefore);
    assertPendingProtected(pendingBefore);
    const preservedArtifacts = await artifactSnapshot(completedBefore, options.protectedOutputRoot);

    const preview = await callTool(sdk.client, "babel_clipper_cleanup_preview", {
      requestId: `${options.runId}-preview`,
      scope: "capture_ids",
      captureIds: [options.completedCaptureId, options.failedCaptureId, options.pendingCaptureId],
      includeFailed: false,
    }, "SDK explicit cleanup preview");
    const candidateIds = Array.isArray(preview.candidates) ? preview.candidates.map((candidate) => candidate.captureId) : [];
    const skipped = Array.isArray(preview.skipped) ? preview.skipped : [];
    const skippedReason = (captureId) => skipped.find((item) => item?.captureId === captureId)?.reason;
    if (
      preview.ack?.persisted !== true || preview.externalFilesPreserved !== true ||
      candidateIds.length !== 1 || candidateIds[0] !== options.completedCaptureId ||
      skippedReason(options.failedCaptureId) !== "not_processed" || skippedReason(options.pendingCaptureId) !== "active_job"
    ) {
      throw new Error("The exact cleanup preview did not restrict its candidate and protected skips as authorized.");
    }

    const committed = await callTool(sdk.client, "babel_clipper_cleanup_commit", {
      requestId: `${options.runId}-commit`,
      cleanupToken: preview.cleanupToken,
    }, "SDK explicit cleanup commit");
    if (
      committed.ack?.persisted !== true || committed.externalFilesPreserved !== true ||
      !Array.isArray(committed.deletedCaptureIds) || committed.deletedCaptureIds.length !== 1 ||
      committed.deletedCaptureIds[0] !== options.completedCaptureId ||
      committed.deletedJobCount !== completedRelations.jobs.length || committed.deletedResultCount !== completedRelations.results.length
    ) {
      throw new Error("The cleanup commit did not delete exactly the previewed completed Capture history.");
    }
    await assertArtifactsUnchanged(preservedArtifacts, options.protectedOutputRoot);

    await expectToolError(sdk.client, "babel_clipper_get_record", { captureId: options.completedCaptureId }, "NOT_FOUND", "SDK deleted completed-record read");
    const [failedAfter, pendingAfter] = await Promise.all([
      callTool(sdk.client, "babel_clipper_get_record", { captureId: options.failedCaptureId }, "SDK failed protection reread"),
      callTool(sdk.client, "babel_clipper_get_record", { captureId: options.pendingCaptureId }, "SDK pending protection reread"),
    ]);
    assertFailedProtected(failedAfter);
    assertPendingProtected(pendingAfter);
    const pendingList = await callTool(sdk.client, "babel_clipper_list_records", { view: "pending", limit: 200 }, "SDK pending list after cleanup");
    const pendingRecords = recordsFrom(pendingList);
    if (!pendingRecords.some((record) => record.captureId === options.pendingCaptureId) || pendingRecords.some((record) => record.captureId === options.failedCaptureId)) {
      throw new Error("Cleanup altered protected pending/failed list semantics.");
    }
    const allAfter = await callTool(sdk.client, "babel_clipper_list_records", { view: "all", limit: 200 }, "SDK final record list");
    const afterById = new Map(recordsFrom(allAfter).map((record) => [record.captureId, record]));
    if (afterById.has(options.completedCaptureId) || !afterById.has(options.failedCaptureId) || !afterById.has(options.pendingCaptureId)) {
      throw new Error("SDK final list does not reflect exactly one deleted target Capture.");
    }
    const missingUnrelated = unrelatedBefore.filter((record) => !afterById.has(record.captureId));
    if (missingUnrelated.length > 0) {
      throw new Error("An unrelated Capture disappeared during a scoped cleanup operation.");
    }

    // Keep Inspector transports serial: they share the same native broker but
    // do not need to contend with one another for this read-only verification.
    const inspectorCompleted = await inspectorGetRecordPayload(options, options.completedCaptureId, npmCache);
    const inspectorFailed = await inspectorGetRecordPayload(options, options.failedCaptureId, npmCache);
    const inspectorPending = await inspectorGetRecordPayload(options, options.pendingCaptureId, npmCache);
    if (inspectorCompleted.ok !== false || inspectorCompleted?.error?.code !== "NOT_FOUND") {
      throw new Error("Inspector did not confirm deletion of the completed-only candidate.");
    }
    const inspectorFailedDetail = successfulResult(inspectorFailed, "Inspector failed-record read");
    const inspectorPendingDetail = successfulResult(inspectorPending, "Inspector pending-record read");
    assertFailedProtected(inspectorFailedDetail);
    assertPendingProtected(inspectorPendingDetail);
    await assertArtifactsUnchanged(preservedArtifacts, options.protectedOutputRoot);

    const report = {
      schemaVersion: 1,
      result: "pass",
      authorization: "Root explicitly authorized this one cleanup test after browser UI/history evidence. It was not an automatic side effect of claim or terminal writeback.",
      profile: fingerprint(options.profileId),
      run: fingerprint(options.runId),
      targets: {
        completedCandidate: fingerprint(options.completedCaptureId),
        failedProtected: fingerprint(options.failedCaptureId),
        pendingProtected: fingerprint(options.pendingCaptureId),
      },
      preview: {
        ackPersisted: true,
        includeFailed: false,
        candidateCount: preview.candidates.length,
        candidate: fingerprint(options.completedCaptureId),
        skipped: [
          { capture: fingerprint(options.failedCaptureId), reason: skippedReason(options.failedCaptureId) },
          { capture: fingerprint(options.pendingCaptureId), reason: skippedReason(options.pendingCaptureId) },
        ],
        externalFilesPreserved: true,
      },
      commit: {
        ackPersisted: true,
        deletedCaptureCount: committed.deletedCaptureIds.length,
        deletedJobCount: committed.deletedJobCount,
        deletedResultCount: committed.deletedResultCount,
        deletedEventCount: committed.deletedEventCount,
        deletedAttachmentRecords: committed.deletedAttachmentRecords,
        externalFilesPreserved: true,
      },
      externalArtifacts: preservedArtifacts.map((artifact) => ({
        fileName: artifact.fileName,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
        unchangedAfterCommit: true,
      })),
      protectedRecords: {
        failedStatus: latestJob(listJobs(failedAfter))?.status,
        pendingStatus: latestJob(listJobs(pendingAfter))?.status,
        pendingClaimAbsent: listJobs(pendingAfter).every((job) => job.status !== "pending" || job.claim === undefined),
        pendingResultCount: listResults(pendingAfter).length,
        failedAbsentFromPendingList: true,
      },
      unrelatedRecords: {
        before: redactedRecords(unrelatedBefore),
        allPreexistingRemainAfter: true,
        newRecordsObservedAfter: redactedRecords(recordsFrom(allAfter).filter((record) => !targets.has(record.captureId) && !unrelatedBefore.some((before) => before.captureId === record.captureId))),
      },
      inspector: {
        package: INSPECTOR_PACKAGE,
        completedRead: "NOT_FOUND",
        failedStatus: latestJob(listJobs(inspectorFailedDetail))?.status,
        pendingStatus: latestJob(listJobs(inspectorPendingDetail))?.status,
      },
      scope: "Only the completed Capture was deleted after an exact preview. The failed and pending targets were protected; unrelated Captures were never preview candidates or commit targets.",
    };
    await writeEvidence(options.evidenceOut, report);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally {
    await sdk.client.close().catch(() => undefined);
    await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`MCP_CLEANUP_LIVE_VERIFICATION_FAILED: ${error instanceof Error ? error.message : "unexpected failure"}\n`);
  process.exitCode = 1;
});
