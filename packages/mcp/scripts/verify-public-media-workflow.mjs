#!/usr/bin/env node
/**
 * E03 verifier for one explicitly confirmed, already-closed public-media
 * Capture. It never accepts a media URL from the command line: the URL and
 * both normalized and padded ranges must already be persisted by the browser.
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
const VERIFY_AGENT_ID = "babel-e03-public-media-verifier";
const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
const OUTPUT_FILENAME = "source-media.mp4";
const DURATION_TOLERANCE_SECONDS = 0.25;

function usage() {
  return [
    "node packages/mcp/scripts/verify-public-media-workflow.mjs --config-dir DIR --profile-id PROFILE --capture-id ID --job-id ID --task-output-dir DIR --allowed-source-origin HTTPS_ORIGIN --run-id ID --confirm-disposable-job ID --confirm-source-tab-closed ID [--cli PATH] [--evidence-out FILE]",
    "",
    "Reads the media URL and ranges from an already-persisted closed-tab Capture, claims one pending Job, cuts its persisted output ranges with ffmpeg, checks audio/video with ffprobe, commits a completed agent-reported result, and independently reads history through Inspector.",
  ].join("\n");
}

function parseArguments(argv) {
  const names = new Set([
    "config-dir", "profile-id", "capture-id", "job-id", "task-output-dir", "allowed-source-origin",
    "run-id", "confirm-disposable-job", "confirm-source-tab-closed", "cli", "evidence-out",
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
    "config-dir", "profile-id", "capture-id", "job-id", "task-output-dir", "allowed-source-origin",
    "run-id", "confirm-disposable-job", "confirm-source-tab-closed",
  ];
  if (required.some((name) => !values.has(name))) throw new Error("All target and confirmation options are required.\n\n" + usage());
  const taskOutputDirectory = values.get("task-output-dir");
  if (!isAbsolute(taskOutputDirectory)) throw new Error("--task-output-dir must be an absolute local path.");
  const allowedOrigin = new URL(values.get("allowed-source-origin"));
  if (allowedOrigin.protocol !== "https:" || allowedOrigin.username || allowedOrigin.password || allowedOrigin.pathname !== "/" || allowedOrigin.search || allowedOrigin.hash) {
    throw new Error("--allowed-source-origin must be a credential-free HTTPS origin without a path, query, or fragment.");
  }
  const runId = values.get("run-id");
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(runId)) throw new Error("--run-id must contain only letters, digits, dot, underscore, or dash.");
  const captureId = values.get("capture-id");
  const jobId = values.get("job-id");
  if (values.get("confirm-disposable-job") !== jobId) {
    throw new Error("--confirm-disposable-job must exactly match --job-id.");
  }
  if (values.get("confirm-source-tab-closed") !== captureId) {
    throw new Error("--confirm-source-tab-closed must exactly match --capture-id.");
  }
  const evidenceOut = values.get("evidence-out");
  if (evidenceOut !== undefined && !isAbsolute(evidenceOut)) throw new Error("--evidence-out must be an absolute path.");
  return {
    configDirectory: resolve(values.get("config-dir")),
    profileId: values.get("profile-id"),
    captureId,
    jobId,
    taskOutputDirectory: resolve(taskOutputDirectory),
    allowedSourceOrigin: allowedOrigin.origin,
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
  if (!job) throw new Error("The confirmed disposable job was not found in the confirmed Capture.");
  return job;
}

function rangeList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} is missing or empty.`);
  const ranges = value.map((range) => {
    if (!range || typeof range !== "object" || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) {
      throw new Error(`${label} contains an invalid time range.`);
    }
    return { start: range.start, end: range.end };
  });
  return ranges;
}

function sameRanges(left, right) {
  return left.length === right.length && left.every((range, index) =>
    Math.abs(range.start - right[index].start) < 0.000001 && Math.abs(range.end - right[index].end) < 0.000001,
  );
}

function sourceUrl(detail, allowedOrigin) {
  const raw = detail?.capture?.source?.metadata?.mediaUrl;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192 || /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error("The Capture has no safe persisted media URL.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The Capture has an invalid persisted media URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.origin !== allowedOrigin) {
    throw new Error("The persisted media URL does not satisfy the explicitly allowed public HTTPS origin.");
  }
  for (const [name] of parsed.searchParams) {
    if (/(?:token|cookie|authorization|secret|signature|password)/iu.test(name)) {
      throw new Error("The persisted media URL contains a credential-like query parameter.");
    }
  }
  return parsed.toString();
}

function extractMediaPlan(detail, job, options) {
  const capture = detail?.capture;
  if (!capture || capture.state !== "sealed" || capture.selection?.type !== "media") {
    throw new Error("The confirmed Capture is not a sealed media Capture.");
  }
  if (job.status !== "pending") {
    throw new Error("The confirmed disposable job is not pending; this verifier will not alter it.");
  }
  const normalizedRanges = rangeList(capture.selection.normalizedSegments, "Capture normalized media ranges");
  const paddedRanges = rangeList(capture.plannedAcquisitionRanges, "Capture padded acquisition ranges");
  const execution = job.executionOptions;
  const requestedRanges = rangeList(execution?.requestedAcquisitionRanges, "Job requested acquisition ranges");
  const outputRanges = rangeList(execution?.requestedOutputRanges, "Job requested output ranges");
  return {
    url: sourceUrl(detail, options.allowedSourceOrigin),
    normalizedRanges,
    paddedRanges,
    requestedRanges,
    outputRanges,
  };
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_CAPTURED_OUTPUT_BYTES) return current;
  return (current + chunk).slice(0, MAX_CAPTURED_OUTPUT_BYTES);
}

async function runProcess(command, args, timeoutMs = 60_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk.toString("utf8")); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk.toString("utf8")); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout, stderr }); });
  });
}

async function probeMedia(url, label) {
  const execution = await runProcess("ffprobe", [
    "-v", "error", "-show_entries", "format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate",
    "-of", "json", url,
  ]);
  if (execution.code !== 0) throw new Error(`${label} ffprobe failed; inspect the local child-process log.`);
  let probe;
  try {
    probe = JSON.parse(execution.stdout);
  } catch {
    throw new Error(`${label} ffprobe did not return machine-readable JSON.`);
  }
  const duration = Number(probe?.format?.duration);
  const size = Number(probe?.format?.size);
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`${label} ffprobe returned invalid duration or size.`);
  }
  const types = new Set(streams.map((stream) => stream?.codec_type));
  if (!types.has("video") || !types.has("audio")) {
    throw new Error(`${label} is missing a required video or audio stream.`);
  }
  return {
    durationSeconds: duration,
    sizeBytes: size,
    streams: streams.map((stream) => ({
      index: stream.index,
      codecType: stream.codec_type,
      codecName: stream.codec_name,
      ...(Number.isFinite(stream.width) ? { width: stream.width } : {}),
      ...(Number.isFinite(stream.height) ? { height: stream.height } : {}),
      ...(typeof stream.r_frame_rate === "string" ? { rFrameRate: stream.r_frame_rate } : {}),
    })),
  };
}

function validateRangesWithinSource(ranges, duration) {
  for (const range of ranges) {
    if (range.end > duration + DURATION_TOLERANCE_SECONDS) {
      throw new Error("A persisted output range exceeds the ffprobe source duration.");
    }
  }
}

function expectedDuration(ranges) {
  return ranges.reduce((total, range) => total + (range.end - range.start), 0);
}

function filterGraph(ranges) {
  const segments = [];
  const inputs = [];
  for (const [index, range] of ranges.entries()) {
    segments.push(`[0:v:0]trim=start=${range.start}:end=${range.end},setpts=PTS-STARTPTS[v${index}]`);
    segments.push(`[0:a:0]atrim=start=${range.start}:end=${range.end},asetpts=PTS-STARTPTS[a${index}]`);
    inputs.push(`[v${index}][a${index}]`);
  }
  segments.push(`${inputs.join("")}concat=n=${ranges.length}:v=1:a=1[vout][aout]`);
  return segments.join(";");
}

async function cutPublicMedia(url, ranges, directory) {
  const outputPath = resolve(directory, OUTPUT_FILENAME);
  if (!pathInside(directory, outputPath)) throw new Error("The output media path is outside the claimed output directory.");
  try {
    await lstat(outputPath);
    throw new Error("The dedicated output media path already exists; refusing to overwrite a prior file.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const execution = await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", url,
    "-filter_complex", filterGraph(ranges),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-c:a", "aac", "-movflags", "+faststart", "-n", outputPath,
  ]);
  if (execution.code !== 0) throw new Error("ffmpeg source-media cut failed; inspect the local child-process log.");
  const metadata = await lstat(outputPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new Error("ffmpeg did not produce a regular non-empty media artifact.");
  }
  return outputPath;
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
  const client = new Client({ name: "babel-content-clipper-e03-media-verifier", version: "1.0.0" }, { capabilities: {} });
  const npmCache = await mkdtemp(join(tmpdir(), "babel-clipper-inspector-public-media-"));
  let activeClaim;
  let terminalCommitted = false;
  try {
    await client.connect(transport);
    const detail = successfulResult(toolPayload(await client.callTool({
      name: "babel_clipper_get_record", arguments: { captureId: options.captureId },
    })), "SDK pre-claim read");
    const job = findJob(detail, options.jobId);
    const plan = extractMediaPlan(detail, job, options);
    const sourceProbe = await probeMedia(plan.url, "Source media");
    validateRangesWithinSource(plan.requestedRanges, sourceProbe.durationSeconds);
    validateRangesWithinSource(plan.outputRanges, sourceProbe.durationSeconds);

    const claimed = successfulResult(toolPayload(await client.callTool({
      name: "babel_clipper_claim_records",
      arguments: {
        requestId: `${options.runId}-claim`, agentId: VERIFY_AGENT_ID, jobIds: [options.jobId],
        taskOutputDirectory: options.taskOutputDirectory, requireOutputDirectory: true,
      },
    })), "SDK claim");
    if (claimed.ack?.persisted !== true || !Array.isArray(claimed.items)) {
      throw new Error("SDK claim did not receive an IndexedDB persistence acknowledgement.");
    }
    const accepted = claimed.items.find((item) => item && item.jobId === options.jobId && item.disposition === "accepted");
    if (!accepted || typeof accepted.claimToken !== "string") {
      throw new Error("The confirmed disposable job was not accepted by the SDK claim.");
    }
    activeClaim = { jobId: options.jobId, claimToken: accepted.claimToken };
    const directory = await resolvedClaimDirectory(options.taskOutputDirectory, claimedDirectory(accepted));
    const outputPath = await cutPublicMedia(plan.url, plan.outputRanges, directory);
    const [outputProbe, bytes] = await Promise.all([probeMedia(outputPath, "Output media"), readFile(outputPath)]);
    const expected = expectedDuration(plan.outputRanges);
    if (Math.abs(outputProbe.durationSeconds - expected) > DURATION_TOLERANCE_SECONDS) {
      throw new Error("The ffprobe output duration does not match the persisted output ranges within tolerance.");
    }
    const outputHash = sha256(bytes);
    const completed = successfulResult(toolPayload(await client.callTool({
      name: "babel_clipper_commit_result",
      arguments: {
        requestId: `${options.runId}-complete`, jobId: options.jobId, claimToken: accepted.claimToken,
        outcome: "completed", acquisitionMethod: "source_media",
        requestedRanges: plan.requestedRanges,
        acquiredRanges: [{ start: 0, end: sourceProbe.durationSeconds }],
        outputRanges: plan.outputRanges,
        paddingInFinalOutput: sameRanges(plan.outputRanges, plan.paddedRanges),
        artifacts: [{
          assetId: `e03-source-media-${options.runId}`, kind: "video", mimeType: "video/mp4", fileReference: outputPath,
          byteLength: bytes.byteLength, durationSeconds: outputProbe.durationSeconds, hasVideo: true, hasAudio: true,
          metadata: { sha256: outputHash, reencoded: true, segmentCount: plan.outputRanges.length },
        }],
        verification: {
          level: "agent_reported", fileExists: true, requiredTracksPresent: true, timeCoverageChecked: true, warnings: [],
          metadata: { sourceDurationSeconds: sourceProbe.durationSeconds, outputDurationSeconds: outputProbe.durationSeconds, expectedOutputDurationSeconds: expected, toleranceSeconds: DURATION_TOLERANCE_SECONDS },
        },
      },
    })), "SDK complete");
    if (completed.ack?.persisted !== true || completed.job?.status !== "completed") {
      throw new Error("SDK completion did not receive a completed persisted result acknowledgement.");
    }
    terminalCommitted = true;

    const inspectorDetail = await inspectorGetRecord(options, npmCache);
    const inspectorJob = findJob(inspectorDetail, options.jobId);
    const inspectorResult = Array.isArray(inspectorDetail.results)
      ? inspectorDetail.results.find((result) => result && typeof result === "object" && result.jobId === options.jobId)
      : undefined;
    const inspectorArtifact = Array.isArray(inspectorResult?.artifacts)
      ? inspectorResult.artifacts.find((artifact) => artifact && typeof artifact === "object" && artifact.fileReference === outputPath)
      : undefined;
    const recheckedBytes = await readFile(outputPath);
    if (
      inspectorJob.status !== "completed" || inspectorResult?.status !== "completed" ||
      inspectorResult?.acquisitionMethod !== "source_media" || inspectorArtifact?.byteLength !== bytes.byteLength ||
      inspectorArtifact?.metadata?.sha256 !== outputHash || sha256(recheckedBytes) !== outputHash
    ) {
      throw new Error("Inspector did not observe the expected persisted source-media result.");
    }
    const report = {
      schemaVersion: 1, result: "pass", profile: fingerprint(options.profileId), capture: fingerprint(options.captureId), job: fingerprint(options.jobId), run: fingerprint(options.runId),
      source: { origin: options.allowedSourceOrigin, url: fingerprint(plan.url), durationSeconds: sourceProbe.durationSeconds, streams: sourceProbe.streams },
      ranges: { normalized: plan.normalizedRanges, padded: plan.paddedRanges, requestedAcquisition: plan.requestedRanges, requestedOutput: plan.outputRanges, paddingInFinalOutput: sameRanges(plan.outputRanges, plan.paddedRanges) },
      output: { fileName: OUTPUT_FILENAME, byteLength: bytes.byteLength, sha256: outputHash, durationSeconds: outputProbe.durationSeconds, streams: outputProbe.streams },
      clients: { officialSdk: { package: "@modelcontextprotocol/sdk", version: "1.30.0", claimAckPersisted: true, completeAckPersisted: true, completedStatus: completed.job.status }, officialInspectorCli: { package: INSPECTOR_PACKAGE, readAfterStatus: inspectorJob.status, resultStatus: inspectorResult.status } },
      sourceTabClosure: "Caller explicitly confirmed the original source tab was closed. Browser-test owner must retain its separate closure evidence.",
      scope: "The public source URL and all ranges were read from the persisted Capture/Job. ffprobe checked source and output audio/video; the result remains agent_reported.",
      uiAckStillRequired: "The browser-test owner must separately confirm the extension UI shows the persisted completed source-media result after the original source tab was closed.",
    };
    if (options.evidenceOut !== undefined) await writeEvidence(options.evidenceOut, report);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    if (activeClaim && !terminalCommitted) {
      try {
        await client.callTool({
          name: "babel_clipper_commit_result",
          arguments: {
            requestId: `${options.runId}-failure`, jobId: activeClaim.jobId, claimToken: activeClaim.claimToken, outcome: "failed",
            verification: { level: "agent_reported", warnings: ["E03 verifier stopped after claiming this disposable job; no claim replay was attempted."] },
            failure: { code: "E03_MEDIA_WORKFLOW_FAILED", message: "Public source-media verification did not complete.", stage: "public_media_workflow", retryCount: 0, retryable: true, details: { verificationRun: options.runId } },
          },
        });
      } catch {
        // A transport loss cannot be repaired by claiming again. Leave the original error visible.
      }
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
    await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`E03_PUBLIC_MEDIA_WORKFLOW_VERIFICATION_FAILED: ${error instanceof Error ? error.message : "unexpected failure"}\n`);
  process.exitCode = 1;
});
