#!/usr/bin/env node
import process from "node:process";
import { startLocalBroker } from "./broker.js";
import { ensureBridgeConfig, loadBridgeConfig, resolveBridgeConfigDirectory } from "./config.js";
import { diagnoseBridge } from "./doctor.js";
import { asBridgeError, ClipperBridgeError } from "./errors.js";
import { ensureBrokerRunning } from "./ensure-broker.js";
import { installNativeHost } from "./installer.js";
import { startMcpStdio } from "./mcp-server.js";
import { runNativeHost } from "./native-host.js";
import { assertProfileId } from "./wire.js";

type Mode = "mcp" | "native-host" | "broker" | "install" | "doctor";

interface ParsedArguments {
  mode: Mode;
  configDirectory?: string;
  profileId?: string;
  extensionId?: string;
  outputRoot?: string;
  manifestDirectory?: string;
  mcpConfigPath?: string;
  cliPath?: string;
  nodePath?: string;
  allowedOrigin?: string;
  nativeOrigin?: string;
  parentWindow?: string;
  overwrite: boolean;
  help: boolean;
}

const valueNames = new Set([
  "mode",
  "config-dir",
  "profile-id",
  "extension-id",
  "output-root",
  "manifest-dir",
  "mcp-config-out",
  "cli-path",
  "node-path",
  "allowed-origin",
  "parent-window",
]);

function usage(): string {
  return [
    "babel-content-clipper --mode=mcp --profile-id PROFILE [--config-dir DIR] [--output-root DIR]",
    "babel-content-clipper --mode=native-host [--config-dir DIR]",
    "babel-content-clipper --mode=broker [--config-dir DIR]",
    "babel-content-clipper --mode=install --extension-id ID [--config-dir DIR] [--manifest-dir DIR] [--output-root DIR] [--profile-id PROFILE --mcp-config-out FILE] [--overwrite]",
    "babel-content-clipper --mode=doctor [--config-dir DIR] [--profile-id PROFILE]",
  ].join("\n");
}

function valueFor(name: string, values: Map<string, string>): string | undefined {
  return values.get(name);
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let overwrite = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (!valueNames.has(name)) {
      throw new ClipperBridgeError("CLI_ARGUMENT_INVALID", "Unknown option --" + name);
    }
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new ClipperBridgeError("CLI_ARGUMENT_INVALID", "Option --" + name + " requires a value.");
    }
    if (values.has(name)) {
      throw new ClipperBridgeError("CLI_ARGUMENT_INVALID", "Option --" + name + " was supplied more than once.");
    }
    values.set(name, value);
  }
  const rawMode = valueFor("mode", values) ?? "mcp";
  if (rawMode !== "mcp" && rawMode !== "native-host" && rawMode !== "broker" &&
    rawMode !== "install" && rawMode !== "doctor") {
    throw new ClipperBridgeError("CLI_ARGUMENT_INVALID", "--mode must be mcp, native-host, broker, install, or doctor.");
  }
  let nativeOrigin: string | undefined;
  if (rawMode === "native-host") {
    for (const value of positional) {
      if (!value.startsWith("chrome-extension://") || nativeOrigin !== undefined) {
        throw new ClipperBridgeError("CLI_ARGUMENT_INVALID", "Native host received an invalid browser origin argument.");
      }
      nativeOrigin = value;
    }
    const allowedOrigin = valueFor("allowed-origin", values);
    if (allowedOrigin !== undefined && !/^chrome-extension:\/\/[a-p]{32}\/$/u.test(allowedOrigin)) {
      throw new ClipperBridgeError(
        "CLI_ARGUMENT_INVALID",
        "--allowed-origin must be a Chromium extension origin with a 32-character a-p id.",
      );
    }
    if (allowedOrigin !== undefined && nativeOrigin !== allowedOrigin) {
      throw new ClipperBridgeError(
        "NATIVE_ORIGIN_FORBIDDEN",
        "The Native Host was not launched by the extension origin authorized by its host manifest.",
      );
    }
  } else if (positional.length > 0) {
    throw new ClipperBridgeError("CLI_ARGUMENT_INVALID", "Unexpected positional argument: " + positional[0]);
  }
  return {
    mode: rawMode,
    ...(valueFor("config-dir", values) === undefined ? {} : { configDirectory: valueFor("config-dir", values) }),
    ...(valueFor("profile-id", values) === undefined ? {} : { profileId: valueFor("profile-id", values) }),
    ...(valueFor("extension-id", values) === undefined ? {} : { extensionId: valueFor("extension-id", values) }),
    ...(valueFor("output-root", values) === undefined ? {} : { outputRoot: valueFor("output-root", values) }),
    ...(valueFor("manifest-dir", values) === undefined ? {} : { manifestDirectory: valueFor("manifest-dir", values) }),
    ...(valueFor("mcp-config-out", values) === undefined ? { mcpConfigPath: undefined } : { mcpConfigPath: valueFor("mcp-config-out", values) }),
    ...(valueFor("cli-path", values) === undefined ? {} : { cliPath: valueFor("cli-path", values) }),
    ...(valueFor("node-path", values) === undefined ? {} : { nodePath: valueFor("node-path", values) }),
    ...(valueFor("allowed-origin", values) === undefined ? {} : { allowedOrigin: valueFor("allowed-origin", values) }),
    ...(nativeOrigin === undefined ? {} : { nativeOrigin }),
    ...(valueFor("parent-window", values) === undefined ? {} : { parentWindow: valueFor("parent-window", values) }),
    overwrite,
    help,
  };
}

function errorText(error: unknown): string {
  const normalized = asBridgeError(error);
  return normalized.code + ": " + normalized.message;
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function waitForTermination(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      void close().finally(resolve);
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  if (args.help) {
    process.stdout.write(usage() + "\n");
    return;
  }
  const configOptions = args.configDirectory === undefined ? {} : { configDirectory: args.configDirectory };
  const configDirectory = resolveBridgeConfigDirectory(configOptions);

  if (args.mode === "install") {
    if (args.extensionId === undefined) {
      throw new ClipperBridgeError("EXTENSION_ID_REQUIRED", "--extension-id is required for installation.");
    }
    const result = await installNativeHost({
      extensionId: args.extensionId,
      ...(args.profileId === undefined ? {} : { profileId: args.profileId }),
      ...(args.configDirectory === undefined ? {} : { configDirectory: args.configDirectory }),
      ...(args.outputRoot === undefined ? {} : { outputRoot: args.outputRoot }),
      ...(args.manifestDirectory === undefined ? {} : { manifestDirectory: args.manifestDirectory }),
      ...(args.mcpConfigPath === undefined ? {} : { mcpConfigPath: args.mcpConfigPath }),
      ...(args.cliPath === undefined ? {} : { cliPath: args.cliPath }),
      ...(args.nodePath === undefined ? {} : { nodePath: args.nodePath }),
      overwrite: args.overwrite,
    });
    writeJson(result);
    return;
  }

  if (args.mode === "doctor") {
    const report = await diagnoseBridge({
      ...(args.configDirectory === undefined ? {} : { configDirectory: args.configDirectory }),
      ...(args.profileId === undefined ? {} : { profileId: args.profileId }),
    });
    writeJson(report);
    if (!report.ready) process.exitCode = 1;
    return;
  }

  if (args.mode === "native-host") {
    if (args.allowedOrigin !== undefined && args.nativeOrigin !== args.allowedOrigin) {
      throw new ClipperBridgeError(
        "NATIVE_ORIGIN_FORBIDDEN",
        "The Native Host was not launched by the extension origin authorized by its host manifest.",
      );
    }
    await runNativeHost({ configOptions });
    return;
  }

  if (args.mode === "broker") {
    const config = await ensureBridgeConfig(configOptions);
    const broker = await startLocalBroker({ config });
    await waitForTermination(() => broker.close());
    return;
  }

  if (args.profileId === undefined) {
    throw new ClipperBridgeError("PROFILE_REQUIRED", "--profile-id is required in MCP mode.");
  }
  const profileId = assertProfileId(args.profileId);
  const config = await loadBridgeConfig(configOptions);
  await ensureBrokerRunning({ config, configDirectory });
  await startMcpStdio({
    config,
    profileId,
    ...(args.outputRoot === undefined ? {} : { outputRoot: args.outputRoot }),
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  void runCli().catch((error) => {
    process.stderr.write(errorText(error) + "\n");
    process.exitCode = 1;
  });
}
