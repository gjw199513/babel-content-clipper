#!/usr/bin/env node
/**
 * Mutating E06 verification for one explicitly-confirmed disposable job.
 * The normal verify-mcp-clients helper is read-only; this script is separate
 * so it cannot claim or complete a real job without all target identifiers.
 */
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const INSPECTOR_PACKAGE = "@modelcontextprotocol/inspector@2.7.0";
const VERIFY_AGENT_ID = "babel-e06-sdk-verifier";
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;

function usage() {
  return [
    "node packages/mcp/scripts/verify-mcp-writeback.mjs --config-dir DIR --profile-id PROFILE --capture-id ID --job-id ID --task-output-dir DIR --run-id ID --confirm-disposable-job ID [--cli PATH] [--evidence-out FILE]",
    "",
    "Claims and completes exactly one disposable job with a documented failed test outcome, then verifies persisted history through the official Inspector CLI.",
  ].join("\n");
}

function parseArguments(argv) {
  const names = new Set([
    "config-dir", "profile-id", "capture-id", "job-id", "task-output-dir", "run-id",
    "confirm-disposable-job", "cli", "evidence-out",
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
  const required = ["config-dir", "profile-id", "capture-id", "job-id", "task-output-dir", "run-id", "confirm-disposable-job"];
  if (required.some((name) => !values.has(name))) throw new Error("All target and confirmation options are required.\n\n" + usage());
  const taskOutputDirectory = values.get("task-output-dir");
  if (!isAbsolute(taskOutputDirectory)) throw new Error("--task-output-dir must be an absolute local path.");
  const runId = values.get("run-id");
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(runId)) throw new Error("--run-id must contain only letters, digits, dot, underscore, or dash.");
  const jobId = values.get("job-id");
  if (values.get("confirm-disposable-job") !== jobId) {
    throw new Error("--confirm-disposable-job must exactly match --job-id.");
  }
  const evidenceOut = values.get("evidence-out");
  if (evidenceOut !== undefined && !isAbsolute(evidenceOut)) throw new Error("--evidence-out must be an absolute path.");
  return {
    configDirectory: resolve(values.get("config-dir")),
    profileId: values.get("profile-id"),
    captureId: values.get("capture-id"),
    jobId,
    taskOutputDirectory: resolve(taskOutputDirectory),
    runId,
    cliPath: resolve(values.get("cli") ?? "dist/node/cli.js"),
    ...(evidenceOut === undefined ? {} : { evidenceOut: resolve(evidenceOut) }),
  };
}

function fingerprint(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex").slice(0, 12);
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
  if (!job) throw new Error("The confirmed disposable job was not found in the confirmed capture.");
  return job;
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
  const claimRequestId = `${options.runId}-claim`;
  const completeRequestId = `${options.runId}-complete`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.cliPath, "--mode=mcp", "--config-dir", options.configDirectory, "--profile-id", options.profileId],
    cwd: dirname(options.cliPath),
    stderr: "pipe",
  });
  const client = new Client({ name: "babel-content-clipper-e06-writeback", version: "1.0.0" }, { capabilities: {} });
  const npmCache = await mkdtemp(join(tmpdir(), "babel-clipper-inspector-writeback-"));
  try {
    await client.connect(transport);
    const beforeDetail = successfulResult(toolPayload(await client.callTool({
      name: "babel_clipper_get_record",
      arguments: { captureId: options.captureId },
    })), "SDK pre-claim read");
    const beforeJob = findJob(beforeDetail, options.jobId);
    if (beforeJob.status !== "pending") {
      throw new Error("The confirmed disposable job is not pending; this verifier will not alter it.");
    }

    const claimed = successfulResult(toolPayload(await client.callTool({
      name: "babel_clipper_claim_records",
      arguments: {
        requestId: claimRequestId,
        agentId: VERIFY_AGENT_ID,
        jobIds: [options.jobId],
        taskOutputDirectory: options.taskOutputDirectory,
        requireOutputDirectory: true,
      },
    })), "SDK claim");
    if (claimed.ack?.persisted !== true || !Array.isArray(claimed.items)) {
      throw new Error("SDK claim did not receive an IndexedDB persistence acknowledgement.");
    }
    const accepted = claimed.items.find((item) => item && item.jobId === options.jobId && item.disposition === "accepted");
    if (!accepted || typeof accepted.claimToken !== "string") {
      throw new Error("The confirmed disposable job was not accepted by the SDK claim.");
    }

    const completed = successfulResult(toolPayload(await client.callTool({
      name: "babel_clipper_commit_result",
      arguments: {
        requestId: completeRequestId,
        jobId: options.jobId,
        claimToken: accepted.claimToken,
        outcome: "failed",
        verification: {
          level: "agent_reported",
          warnings: ["Dedicated E06 bridge verification; no media artifact was produced."],
        },
        failure: {
          code: "E06_DISPOSABLE_TEST",
          message: "Dedicated MCP bridge persistence verification job.",
          stage: "integration_verification",
          retryCount: 0,
          retryable: false,
          details: { verificationRun: options.runId },
        },
      },
    })), "SDK complete");
    if (completed.ack?.persisted !== true || completed.job?.status !== "failed") {
      throw new Error("SDK completion did not receive a failed persisted result acknowledgement.");
    }

    const inspectorDetail = await inspectorGetRecord(options, npmCache);
    const inspectorJob = findJob(inspectorDetail, options.jobId);
    if (inspectorJob.status !== "failed" || inspectorJob.failure?.code !== "E06_DISPOSABLE_TEST") {
      throw new Error("Inspector did not observe the expected persisted disposable test result.");
    }

    const report = {
      schemaVersion: 1,
      result: "pass",
      profile: fingerprint(options.profileId),
      capture: fingerprint(options.captureId),
      job: fingerprint(options.jobId),
      run: fingerprint(options.runId),
      clients: {
        officialSdk: {
          package: "@modelcontextprotocol/sdk",
          version: "1.30.0",
          readBeforeStatus: beforeJob.status,
          claimAckPersisted: true,
          claimDirectorySource: accepted.job?.directory?.source ?? "unknown",
          completeAckPersisted: true,
          completedStatus: completed.job.status,
        },
        officialInspectorCli: {
          package: INSPECTOR_PACKAGE,
          readAfterStatus: inspectorJob.status,
          failureCode: inspectorJob.failure.code,
        },
      },
      scope: "A deliberately confirmed disposable job was claimed and completed as failed; no attachment or external media artifact was created.",
      uiAckStillRequired: "The browser-test owner must separately confirm the extension UI reflects this persisted job status and revision.",
    };
    if (options.evidenceOut !== undefined) await writeEvidence(options.evidenceOut, report);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally {
    await client.close().catch(() => undefined);
    await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`E06_MCP_WRITEBACK_VERIFICATION_FAILED: ${error instanceof Error ? error.message : "unexpected failure"}\n`);
  process.exitCode = 1;
});
