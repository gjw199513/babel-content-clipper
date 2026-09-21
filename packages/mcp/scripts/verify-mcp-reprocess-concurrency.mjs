#!/usr/bin/env node
/**
 * Post-UI-ACK E06/C03/C06 verifier for a deliberately disposable Capture.
 *
 * It creates a new reprocess Job after a confirmed terminal parent, sends two
 * independent SDK stdio clients to claim it at once, writes one simulated
 * failure through the winning claim, then uses Inspector to prove that the
 * original completed Result and its external text artifact remain intact.
 */
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const INSPECTOR_PACKAGE = "@modelcontextprotocol/inspector@2.7.0";
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;

function usage() {
  return [
    "node packages/mcp/scripts/verify-mcp-reprocess-concurrency.mjs --config-dir DIR --profile-id PROFILE --capture-id ID --parent-job-id ID --task-output-root DIR --run-id ID --confirm-disposable-capture ID --confirm-parent-job ID [--cli PATH] [--evidence-out FILE]",
    "",
    "Creates one confirmed reprocess Job, races two independent SDK clients to claim it, completes the winner as a documented simulated failure, and verifies history with Inspector.",
  ].join("\n");
}

function parseArguments(argv) {
  const names = new Set([
    "config-dir", "profile-id", "capture-id", "parent-job-id", "task-output-root", "run-id",
    "confirm-disposable-capture", "confirm-parent-job", "cli", "evidence-out",
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
    "config-dir", "profile-id", "capture-id", "parent-job-id", "task-output-root", "run-id",
    "confirm-disposable-capture", "confirm-parent-job",
  ];
  if (required.some((name) => !values.has(name))) throw new Error("All target and confirmation options are required.\n\n" + usage());
  const taskOutputRoot = values.get("task-output-root");
  if (!isAbsolute(taskOutputRoot)) throw new Error("--task-output-root must be an absolute local path.");
  const runId = values.get("run-id");
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(runId)) throw new Error("--run-id must contain only letters, digits, dot, underscore, or dash.");
  const captureId = values.get("capture-id");
  const parentJobId = values.get("parent-job-id");
  if (values.get("confirm-disposable-capture") !== captureId) {
    throw new Error("--confirm-disposable-capture must exactly match --capture-id.");
  }
  if (values.get("confirm-parent-job") !== parentJobId) {
    throw new Error("--confirm-parent-job must exactly match --parent-job-id.");
  }
  const evidenceOut = values.get("evidence-out");
  if (evidenceOut !== undefined && !isAbsolute(evidenceOut)) throw new Error("--evidence-out must be an absolute path.");
  return {
    configDirectory: resolve(values.get("config-dir")),
    profileId: values.get("profile-id"),
    captureId,
    parentJobId,
    taskOutputRoot: resolve(taskOutputRoot),
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

function findJob(detail, jobId) {
  const jobs = Array.isArray(detail?.jobs) ? detail.jobs : [];
  const job = jobs.find((candidate) => candidate && typeof candidate === "object" && candidate.jobId === jobId);
  if (!job) throw new Error("The confirmed job was not found in the confirmed capture.");
  return job;
}

function findResult(detail, jobId) {
  const results = Array.isArray(detail?.results) ? detail.results : [];
  return results.find((candidate) => candidate && typeof candidate === "object" && candidate.jobId === jobId);
}

function requireSafeJobSegment(jobId) {
  if (!/^[A-Za-z0-9._-]{1,256}$/u.test(jobId)) {
    throw new Error("The reprocess Job id cannot be safely used as an output directory segment.");
  }
  return jobId;
}

async function verifyOriginalArtifact(detail, options) {
  const parentResult = findResult(detail, options.parentJobId);
  const artifact = Array.isArray(parentResult?.artifacts)
    ? parentResult.artifacts.find((candidate) => candidate && typeof candidate === "object" && candidate.kind === "text" && typeof candidate.fileReference === "string")
    : undefined;
  if (!artifact || typeof artifact.fileReference !== "string") {
    throw new Error("The confirmed parent Result has no persisted text artifact to protect.");
  }
  const root = await realpath(options.taskOutputRoot);
  const fileReference = resolve(artifact.fileReference);
  if (!pathInside(root, fileReference)) {
    throw new Error("The parent text artifact is outside the explicitly approved test output root.");
  }
  const [metadata, bytes] = await Promise.all([lstat(fileReference), readFile(fileReference)]);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The parent text artifact is no longer a regular file.");
  }
  const hash = sha256(bytes);
  if (artifact.byteLength !== bytes.byteLength || artifact.metadata?.sha256 !== hash) {
    throw new Error("The parent text artifact does not match its persisted byte-length/hash record.");
  }
  return { fileReference, byteLength: bytes.byteLength, sha256: hash };
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
    const timeout = setTimeout(() => child.kill(), 60_000);
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk.toString("utf8")); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk.toString("utf8")); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timeout); resolveResult({ code, signal, stdout, stderr }); });
  });
}

async function inspectorGetRecord(options, npmCache) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const execution = await runProcess(command, [
    "--yes", INSPECTOR_PACKAGE, "--cli", process.execPath, options.cliPath,
    "--mode=mcp", "--config-dir", options.configDirectory, "--profile-id", options.profileId,
    "--", "--method", "tools/call", "--tool-name", "babel_clipper_get_record",
    "--tool-args-json", JSON.stringify({ captureId: options.captureId }), "--format", "json",
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
  await access(options.cliPath);
  const first = startClient(options, "babel-content-clipper-e06-claim-a");
  const second = startClient(options, "babel-content-clipper-e06-claim-b");
  const npmCache = await mkdtemp(join(tmpdir(), "babel-clipper-inspector-reprocess-"));
  try {
    await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);
    const beforeDetail = successfulResult(toolPayload(await first.client.callTool({
      name: "babel_clipper_get_record",
      arguments: { captureId: options.captureId },
    })), "SDK parent read");
    const parentJob = findJob(beforeDetail, options.parentJobId);
    if (parentJob.status !== "completed") {
      throw new Error("The confirmed parent job is not completed; this verifier will not create a reprocess Job.");
    }
    const originalArtifact = await verifyOriginalArtifact(beforeDetail, options);

    const reprocess = successfulResult(toolPayload(await first.client.callTool({
      name: "babel_clipper_reprocess_record",
      arguments: {
        requestId: `${options.runId}-reprocess`,
        captureId: options.captureId,
        parentJobId: options.parentJobId,
      },
    })), "SDK reprocess");
    if (reprocess.ack?.persisted !== true || !reprocess.value || typeof reprocess.value.jobId !== "string" || reprocess.value.status !== "pending") {
      throw new Error("SDK reprocess did not return a new persisted pending job.");
    }
    const reprocessJobId = reprocess.value.jobId;
    const reprocessDirectory = resolve(options.taskOutputRoot, requireSafeJobSegment(reprocessJobId));
    if (!pathInside(options.taskOutputRoot, reprocessDirectory)) {
      throw new Error("The derived reprocess output directory is outside the approved root.");
    }

    const requestClaim = (client, label) => client.callTool({
      name: "babel_clipper_claim_records",
      arguments: {
        requestId: `${options.runId}-claim-${label}`,
        agentId: `babel-e06-concurrent-${label}`,
        jobIds: [reprocessJobId],
        taskOutputDirectory: reprocessDirectory,
        requireOutputDirectory: true,
      },
    }).then((result) => successfulResult(toolPayload(result), `SDK concurrent claim ${label}`));
    const [claimA, claimB] = await Promise.all([
      requestClaim(first.client, "a"),
      requestClaim(second.client, "b"),
    ]);
    if (claimA.ack?.persisted !== true || claimB.ack?.persisted !== true) {
      throw new Error("A concurrent claim did not receive an IndexedDB persistence acknowledgement.");
    }
    const outcomes = [
      { label: "a", client: first.client, item: Array.isArray(claimA.items) ? claimA.items[0] : undefined },
      { label: "b", client: second.client, item: Array.isArray(claimB.items) ? claimB.items[0] : undefined },
    ];
    const winners = outcomes.filter((outcome) => outcome.item?.disposition === "accepted" && typeof outcome.item.claimToken === "string");
    if (winners.length !== 1) {
      throw new Error("Concurrent SDK claims did not produce exactly one accepted owner.");
    }
    const winner = winners[0];
    const loser = outcomes.find((outcome) => outcome !== winner);
    if (loser?.item?.disposition !== "already_claimed") {
      throw new Error("The non-winning concurrent SDK claim did not report already_claimed.");
    }

    const completed = successfulResult(toolPayload(await winner.client.callTool({
      name: "babel_clipper_commit_result",
      arguments: {
        requestId: `${options.runId}-complete-${winner.label}`,
        jobId: reprocessJobId,
        claimToken: winner.item.claimToken,
        outcome: "failed",
        verification: {
          level: "agent_reported",
          warnings: ["Dedicated acceptance failure after a concurrent claim race; no original artifact was changed."],
        },
        failure: {
          code: "ACCEPTANCE_SIMULATED_FAILURE",
          message: "Dedicated reprocess acceptance verification failure.",
          stage: "concurrent_claim_acceptance",
          retryCount: 1,
          retryable: false,
          details: { verificationRun: options.runId },
        },
      },
    })), "SDK winning failure completion");
    if (completed.ack?.persisted !== true || completed.job?.status !== "failed" || completed.result?.failure?.code !== "ACCEPTANCE_SIMULATED_FAILURE") {
      throw new Error("The winning SDK client did not persist the expected failed reprocess result.");
    }

    const inspectorDetail = await inspectorGetRecord(options, npmCache);
    const inspectorParentJob = findJob(inspectorDetail, options.parentJobId);
    const inspectorReprocessJob = findJob(inspectorDetail, reprocessJobId);
    const inspectorParentResult = findResult(inspectorDetail, options.parentJobId);
    const inspectorReprocessResult = findResult(inspectorDetail, reprocessJobId);
    const inspectorArtifact = Array.isArray(inspectorParentResult?.artifacts)
      ? inspectorParentResult.artifacts.find((candidate) => candidate && typeof candidate === "object" && candidate.fileReference === originalArtifact.fileReference)
      : undefined;
    const preservedBytes = await readFile(originalArtifact.fileReference);
    if (
      inspectorParentJob.status !== "completed" ||
      inspectorReprocessJob.status !== "failed" ||
      inspectorReprocessResult?.failure?.code !== "ACCEPTANCE_SIMULATED_FAILURE" ||
      inspectorArtifact?.byteLength !== originalArtifact.byteLength ||
      inspectorArtifact?.metadata?.sha256 !== originalArtifact.sha256 ||
      sha256(preservedBytes) !== originalArtifact.sha256
    ) {
      throw new Error("Inspector did not observe preserved completed history plus the expected failed reprocess result.");
    }

    const report = {
      schemaVersion: 1,
      result: "pass",
      profile: fingerprint(options.profileId),
      capture: fingerprint(options.captureId),
      parentJob: fingerprint(options.parentJobId),
      reprocessJob: fingerprint(reprocessJobId),
      run: fingerprint(options.runId),
      concurrentClaims: {
        clients: 2,
        accepted: 1,
        alreadyClaimed: 1,
        winner: winner.label,
      },
      reprocess: {
        creationAckPersisted: true,
        completionAckPersisted: true,
        status: completed.job.status,
        failureCode: completed.result.failure.code,
        retryCount: completed.result.failure.retryCount,
      },
      preservedOriginal: {
        byteLength: originalArtifact.byteLength,
        sha256: originalArtifact.sha256,
        resultStatus: inspectorParentResult.status,
      },
      inspector: {
        package: INSPECTOR_PACKAGE,
        parentStatus: inspectorParentJob.status,
        reprocessStatus: inspectorReprocessJob.status,
        reprocessFailureCode: inspectorReprocessResult.failure.code,
      },
      scope: "A new reprocess job was used for one deliberate failed acceptance result. The completed parent result and original text artifact were only read and remain preserved.",
      uiAckStillRequired: "The browser-test owner must separately confirm the extension UI shows the failed reprocess diagnostic while retaining the completed parent history.",
    };
    if (options.evidenceOut !== undefined) await writeEvidence(options.evidenceOut, report);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally {
    await Promise.allSettled([first.client.close(), second.client.close()]);
    await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`E06_MCP_REPROCESS_CONCURRENCY_VERIFICATION_FAILED: ${error instanceof Error ? error.message : "unexpected failure"}\n`);
  process.exitCode = 1;
});
