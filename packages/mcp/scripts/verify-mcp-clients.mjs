#!/usr/bin/env node
/**
 * E06 live-bridge evidence helper.
 *
 * It keeps one official SDK Client connected while the official MCP Inspector
 * CLI opens its own stdio sessions against the same profile-bound command.
 * It neither opens the Inspector web UI nor reads/writes a desktop MCP catalog.
 */
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
const INSPECTOR_PACKAGE = "@modelcontextprotocol/inspector@2.7.0";
const STATUS_TOOL = "babel_clipper_connection_status";
const REQUIRED_TOOLS = [
  "babel_clipper_list_records",
  "babel_clipper_claim_records",
  "babel_clipper_commit_result",
  STATUS_TOOL,
];

function usage() {
  return [
    "node packages/mcp/scripts/verify-mcp-clients.mjs --config-dir DIR --profile-id PROFILE [--cli PATH] [--evidence-out FILE]",
    "",
    "Runs an official SDK stdio client and the official MCP Inspector CLI against one already-connected browser profile.",
    "It does not launch Inspector's web UI or modify a user MCP/browser configuration.",
  ].join("\n");
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument: ${argument}`);
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (!["config-dir", "profile-id", "cli", "evidence-out"].includes(name)) {
      throw new Error(`Unknown option --${name}`);
    }
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (!value || value.startsWith("--")) throw new Error(`Option --${name} requires a value.`);
    if (values.has(name)) throw new Error(`Option --${name} was supplied more than once.`);
    values.set(name, value);
  }
  const configDirectory = values.get("config-dir");
  const profileId = values.get("profile-id");
  if (!configDirectory || !profileId) {
    throw new Error("--config-dir and --profile-id are required.\n\n" + usage());
  }
  if (/[\u0000-\u001f\u007f]/u.test(profileId) || profileId.length > 256) {
    throw new Error("--profile-id must be a non-empty safe profile identifier.");
  }
  const evidenceOut = values.get("evidence-out");
  if (evidenceOut !== undefined && !isAbsolute(evidenceOut)) {
    throw new Error("--evidence-out must be an absolute path.");
  }
  return {
    configDirectory: resolve(configDirectory),
    profileId,
    cliPath: resolve(values.get("cli") ?? "dist/node/cli.js"),
    ...(evidenceOut === undefined ? {} : { evidenceOut: resolve(evidenceOut) }),
  };
}

function profileFingerprint(profileId) {
  return "sha256:" + createHash("sha256").update(profileId).digest("hex").slice(0, 12);
}

function toolPayload(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
    throw new Error("MCP tool returned no content payload.");
  }
  const text = result.content.find((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string");
  if (!text) throw new Error("MCP tool returned no text payload.");
  let parsed;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    throw new Error("MCP tool returned an invalid JSON payload.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("MCP tool returned an invalid payload object.");
  return parsed;
}

function statusSummary(payload, clientName) {
  if (payload.ok !== true || !payload.result || typeof payload.result !== "object") {
    const code = payload?.error?.code;
    throw new Error(`${clientName} received a failed connection-status result${typeof code === "string" ? ` (${code})` : ""}.`);
  }
  const result = payload.result;
  const browser = result.browser;
  if (!browser || typeof browser !== "object" || browser.connected === false) {
    throw new Error(`${clientName} could not reach the selected browser profile.`);
  }
  if (browser.browserAvailable !== true || browser.databaseAvailable !== true) {
    throw new Error(`${clientName} reached the bridge, but the extension database is not ready.`);
  }
  return {
    brokerListening: result.listening === true,
    brokerBrowserConnected: result.browserConnected === true,
    extensionBrowserAvailable: true,
    extensionDatabaseAvailable: true,
    revision: typeof browser.revision === "number" ? browser.revision : undefined,
  };
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
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}

function parseInspectorEnvelope(stdout, label) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not produce machine-readable JSON.`);
  }
  if (!envelope || typeof envelope !== "object" || !("result" in envelope)) {
    throw new Error(`${label} returned an invalid Inspector response.`);
  }
  return envelope.result;
}

function inspectorFailure(label, execution) {
  /* Inspector stderr may include child process paths. Do not echo it into evidence. */
  const suffix = execution.code === null ? `signal ${execution.signal ?? "unknown"}` : `exit ${execution.code}`;
  return new Error(`${label} failed (${suffix}); see its isolated process stderr locally.`);
}

async function runInspector(cliPath, configDirectory, profileId, npmCache, inspectorArguments) {
  const target = [
    "--yes",
    INSPECTOR_PACKAGE,
    "--cli",
    process.execPath,
    cliPath,
    "--mode=mcp",
    "--config-dir",
    configDirectory,
    "--profile-id",
    profileId,
    "--",
    ...inspectorArguments,
  ];
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  return runProcess(command, target, {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false",
    NO_COLOR: "1",
  });
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

  const targetArgs = [
    options.cliPath,
    "--mode=mcp",
    "--config-dir",
    options.configDirectory,
    "--profile-id",
    options.profileId,
  ];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: targetArgs,
    cwd: dirname(options.cliPath),
    stderr: "pipe",
  });
  const sdk = new Client(
    { name: "babel-content-clipper-e06-sdk", version: "1.0.0" },
    { capabilities: {} },
  );
  const npmCache = await mkdtemp(join(tmpdir(), "babel-clipper-inspector-cache-"));

  try {
    await sdk.connect(transport);
    const sdkTools = await sdk.listTools();
    const sdkToolNames = sdkTools.tools.map((tool) => tool.name).sort();
    for (const required of REQUIRED_TOOLS) {
      if (!sdkToolNames.includes(required)) throw new Error(`Official SDK client did not receive required tool ${required}.`);
    }
    const sdkResources = await sdk.listResources();
    const sdkStatusResult = await sdk.callTool({ name: STATUS_TOOL, arguments: {} });
    const sdkStatus = statusSummary(toolPayload(sdkStatusResult), "Official SDK client");

    /*
     * Inspector CLI v2 takes every target argument (including the MCP CLI
     * flags) before `--`; its own method flags follow it. It never starts the
     * web Inspector and no catalog/config file is passed or created.
     */
    const inspectorTools = await runInspector(
      options.cliPath,
      options.configDirectory,
      options.profileId,
      npmCache,
      ["--method", "tools/list", "--format", "json"],
    );
    if (inspectorTools.code !== 0) throw inspectorFailure("Inspector tools/list", inspectorTools);
    const listed = parseInspectorEnvelope(inspectorTools.stdout, "Inspector tools/list");
    const inspectorToolNames = Array.isArray(listed?.tools)
      ? listed.tools.map((tool) => tool?.name).filter((name) => typeof name === "string").sort()
      : [];
    for (const required of REQUIRED_TOOLS) {
      if (!inspectorToolNames.includes(required)) throw new Error(`Inspector did not receive required tool ${required}.`);
    }

    const inspectorStatus = await runInspector(
      options.cliPath,
      options.configDirectory,
      options.profileId,
      npmCache,
      [
        "--method",
        "tools/call",
        "--tool-name",
        STATUS_TOOL,
        "--tool-args-json",
        "{}",
        "--format",
        "json",
      ],
    );
    if (inspectorStatus.code !== 0) throw inspectorFailure("Inspector connection-status", inspectorStatus);
    const inspectorCall = parseInspectorEnvelope(inspectorStatus.stdout, "Inspector connection-status");
    const inspectorConnection = statusSummary(toolPayload(inspectorCall), "Inspector CLI");

    const report = {
      schemaVersion: 1,
      profile: profileFingerprint(options.profileId),
      result: "pass",
      clients: {
        officialSdk: {
          transport: "stdio",
          toolCount: sdkToolNames.length,
          requiredTools: REQUIRED_TOOLS,
          resourceCount: sdkResources.resources.length,
          connection: sdkStatus,
        },
        officialInspectorCli: {
          transport: "stdio",
          toolsListToolCount: inspectorToolNames.length,
          connection: inspectorConnection,
          invocation: "npx " + INSPECTOR_PACKAGE + " --cli (no web UI; isolated npm cache)",
        },
      },
      limitations: [
        "This demonstrates two MCP client implementations against one profile-bound bridge.",
        "The Inspector CLI connects, performs one request, and disconnects by design; it is not evidence of two desktop Agent products.",
      ],
    };
    if (options.evidenceOut !== undefined) await writeEvidence(options.evidenceOut, report);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally {
    await sdk.close().catch(() => undefined);
    await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  /* No diagnostics from a profile, extension, or child stdio server are echoed. */
  process.stderr.write(`E06_MCP_CLIENT_VERIFICATION_FAILED: ${error instanceof Error ? error.message : "unexpected failure"}\n`);
  process.exitCode = 1;
});
