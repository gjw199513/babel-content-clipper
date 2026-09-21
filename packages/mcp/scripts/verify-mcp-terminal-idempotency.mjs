#!/usr/bin/env node
/**
 * Read/replay verifier for an explicitly confirmed completed Result.
 * It replays the original completion request verbatim from persisted result
 * fields, then sends a different terminal outcome under a new request id and
 * proves the bridge rejects that conflict without changing the old artifact.
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
    "node packages/mcp/scripts/verify-mcp-terminal-idempotency.mjs --config-dir DIR --profile-id PROFILE --capture-id ID --job-id ID --artifact-root DIR --complete-request-id ID --run-id ID --confirm-completed-job ID [--cli PATH] [--evidence-out FILE]",
    "",
    "Replays one confirmed completed MCP result with its original request id, verifies the persisted acknowledgement, then proves a conflicting terminal request is rejected without altering the existing artifact.",
  ].join("\n");
}

function parseArguments(argv) {
  const names = new Set([
    "config-dir", "profile-id", "capture-id", "job-id", "artifact-root", "complete-request-id", "run-id",
    "confirm-completed-job", "cli", "evidence-out",
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
  const required = ["config-dir", "profile-id", "capture-id", "job-id", "artifact-root", "complete-request-id", "run-id", "confirm-completed-job"];
  if (required.some((name) => !values.has(name))) throw new Error("All target and confirmation options are required.\n\n" + usage());
  const artifactRoot = values.get("artifact-root");
  if (!isAbsolute(artifactRoot)) throw new Error("--artifact-root must be an absolute local path.");
  const runId = values.get("run-id");
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(runId)) throw new Error("--run-id must contain only letters, digits, dot, underscore, or dash.");
  const jobId = values.get("job-id");
  if (values.get("confirm-completed-job") !== jobId) {
    throw new Error("--confirm-completed-job must exactly match --job-id.");
  }
  const evidenceOut = values.get("evidence-out");
  if (evidenceOut !== undefined && !isAbsolute(evidenceOut)) throw new Error("--evidence-out must be an absolute path.");
  return {
    configDirectory: resolve(values.get("config-dir")),
    profileId: values.get("profile-id"),
    captureId: values.get("capture-id"),
    jobId,
    artifactRoot: resolve(artifactRoot),
    completeRequestId: values.get("complete-request-id"),
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

function failedCode(payload, operation) {
  if (payload.ok !== false || !payload.error || typeof payload.error.code !== "string") {
    throw new Error(`${operation} did not return a typed rejected MCP payload.`);
  }
  return payload.error.code;
}

function findJob(detail, jobId) {
  const jobs = Array.isArray(detail?.jobs) ? detail.jobs : [];
  const job = jobs.find((candidate) => candidate && typeof candidate === "object" && candidate.jobId === jobId);
  if (!job) throw new Error("The confirmed completed job was not found in the confirmed Capture.");
  return job;
}

function findResult(detail, jobId) {
  const results = Array.isArray(detail?.results) ? detail.results : [];
  const result = results.find((candidate) => candidate && typeof candidate === "object" && candidate.jobId === jobId);
  if (!result) throw new Error("The confirmed completed job has no persisted Result.");
  return result;
}

async function protectedArtifact(result, root) {
  const artifact = Array.isArray(result.artifacts)
    ? result.artifacts.find((candidate) => candidate && typeof candidate === "object" && typeof candidate.fileReference === "string")
    : undefined;
  if (!artifact || typeof artifact.fileReference !== "string") {
    throw new Error("The confirmed Result has no local artifact to protect.");
  }
  const realRoot = await realpath(root);
  const fileReference = resolve(artifact.fileReference);
  const canonicalParent = await realpath(dirname(fileReference));
  const canonicalFile = join(canonicalParent, fileReference.split(/[\\/]/u).at(-1));
  if (!pathInside(realRoot, canonicalFile)) {
    throw new Error("The persisted artifact is outside the explicitly approved artifact root.");
  }
  const [metadata, bytes] = await Promise.all([lstat(fileReference), readFile(fileReference)]);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("The persisted artifact is not a regular file.");
  const hash = sha256(bytes);
  if (artifact.byteLength !== bytes.byteLength || artifact.metadata?.sha256 !== hash) {
    throw new Error("The persisted artifact no longer matches its stored byte-length/hash.");
  }
  return { fileReference, byteLength: bytes.byteLength, sha256: hash };
}

function replayCompletion(result, job, options) {
  const claimToken = job?.claim?.claimToken;
  if (typeof claimToken !== "string") throw new Error("The completed Job has no persisted claim token for idempotency replay.");
  if (result.status !== "completed") throw new Error("This verifier only replays a completed Result.");
  const replay = {
    requestId: options.completeRequestId,
    jobId: options.jobId,
    claimToken,
    outcome: "completed",
    ...(result.acquisitionMethod === undefined ? {} : { acquisitionMethod: result.acquisitionMethod }),
    requestedRanges: result.requestedRanges,
    acquiredRanges: result.acquiredRanges,
    outputRanges: result.outputRanges,
    ...(Object.hasOwn(result, "paddingInFinalOutput") ? { paddingInFinalOutput: result.paddingInFinalOutput } : {}),
    artifacts: result.artifacts,
    verification: result.verification,
  };
  return { replay, claimToken };
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_CAPTURED_OUTPUT_BYTES) return current;
  return (current + chunk).slice(0, MAX_CAPTURED_OUTPUT_BYTES);
}

async function inspectorGetRecord(options, npmCache) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const execution = await new Promise((resolveResult, reject) => {
    const child = spawn(command, [
      "--yes", INSPECTOR_PACKAGE, "--cli", process.execPath, options.cliPath,
      "--mode=mcp", "--config-dir", options.configDirectory, "--profile-id", options.profileId,
      "--", "--method", "tools/call", "--tool-name", "babel_clipper_get_record",
      "--tool-args-json", JSON.stringify({ captureId: options.captureId }), "--format", "json",
    ], {
      cwd: resolve("."),
      env: { ...process.env, npm_config_cache: npmCache, npm_config_update_notifier: "false", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk.toString("utf8")); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk.toString("utf8")); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout, stderr }); });
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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.cliPath, "--mode=mcp", "--config-dir", options.configDirectory, "--profile-id", options.profileId],
    cwd: dirname(options.cliPath), stderr: "pipe",
  });
  const client = new Client({ name: "babel-content-clipper-terminal-idempotency-verifier", version: "1.0.0" }, { capabilities: {} });
  const npmCache = await mkdtemp(join(tmpdir(), "babel-clipper-inspector-terminal-idempotency-"));
  try {
    await client.connect(transport);
    const status = successfulResult(toolPayload(await client.callTool({ name: "babel_clipper_connection_status", arguments: {} })), "SDK connection status");
    if (status?.browser?.browserAvailable !== true || status?.browser?.databaseAvailable !== true) {
      throw new Error("The selected Native browser profile is not ready for this read/replay verification.");
    }
    const beforeDetail = successfulResult(toolPayload(await client.callTool({
      name: "babel_clipper_get_record", arguments: { captureId: options.captureId },
    })), "SDK pre-replay read");
    const job = findJob(beforeDetail, options.jobId);
    const result = findResult(beforeDetail, options.jobId);
    if (job.status !== "completed" || result.status !== "completed") {
      throw new Error("The confirmed job/result is not completed; this verifier will not submit terminal requests.");
    }
    const artifact = await protectedArtifact(result, options.artifactRoot);
    const { replay, claimToken } = replayCompletion(result, job, options);

    const replayed = successfulResult(toolPayload(await client.callTool({ name: "babel_clipper_commit_result", arguments: replay })), "SDK idempotency replay");
    if (replayed.ack?.persisted !== true || replayed.job?.status !== "completed" || replayed.result?.resultId !== result.resultId) {
      throw new Error("The original completion request did not replay its persisted Result acknowledgement.");
    }

    const conflictPayload = toolPayload(await client.callTool({
      name: "babel_clipper_commit_result",
      arguments: {
        requestId: `${options.runId}-terminal-conflict`, jobId: options.jobId, claimToken, outcome: "failed",
        verification: { level: "agent_reported", warnings: ["Deliberate terminal conflict verification; existing result must stay unchanged."] },
        failure: { code: "TERMINAL_CONFLICT_PROBE", message: "A different terminal result must be rejected.", stage: "idempotency_acceptance", retryCount: 0, retryable: false, details: { verificationRun: options.runId } },
      },
    }));
    const conflictCode = failedCode(conflictPayload, "SDK terminal conflict");
    if (conflictCode !== "RESULT_CONFLICT") {
      throw new Error(`Terminal conflict returned ${conflictCode} instead of RESULT_CONFLICT.`);
    }

    const inspectorDetail = await inspectorGetRecord(options, npmCache);
    const inspectorJob = findJob(inspectorDetail, options.jobId);
    const inspectorResult = findResult(inspectorDetail, options.jobId);
    const afterBytes = await readFile(artifact.fileReference);
    if (
      inspectorJob.status !== "completed" || inspectorResult.status !== "completed" ||
      inspectorResult.resultId !== result.resultId || sha256(afterBytes) !== artifact.sha256 || afterBytes.byteLength !== artifact.byteLength
    ) {
      throw new Error("Inspector or local re-read shows that the completed result/artifact changed after terminal conflict rejection.");
    }
    const report = {
      schemaVersion: 1, result: "pass", profile: fingerprint(options.profileId), capture: fingerprint(options.captureId), job: fingerprint(options.jobId), run: fingerprint(options.runId),
      replay: { request: fingerprint(options.completeRequestId), ackPersisted: true, resultUnchanged: true },
      terminalConflict: { rejected: true, code: conflictCode },
      preservedArtifact: { byteLength: artifact.byteLength, sha256: artifact.sha256 },
      inspector: { package: INSPECTOR_PACKAGE, status: inspectorJob.status, resultUnchanged: inspectorResult.resultId === result.resultId },
      scope: "One existing completed result was replayed with its original request id. One distinct terminal outcome was rejected; the existing artifact was read-only and remained unchanged.",
    };
    if (options.evidenceOut !== undefined) await writeEvidence(options.evidenceOut, report);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally {
    await client.close().catch(() => undefined);
    await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`E06_TERMINAL_IDEMPOTENCY_VERIFICATION_FAILED: ${error instanceof Error ? error.message : "unexpected failure"}\n`);
  process.exitCode = 1;
});
