import { chmod, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  ensureBridgeConfig,
  redactBridgeConfig,
  resolveBridgeConfigDirectory,
  updateBridgeConfig,
  type BridgeConfig,
  type BridgeConfigOptions,
} from "./config.js";
import { EXTENSION_ID_PATTERN, NATIVE_HOST_NAME } from "./constants.js";
import { ClipperBridgeError } from "./errors.js";
import { assertProfileId } from "./wire.js";

export interface NativeHostManifest {
  name: typeof NATIVE_HOST_NAME;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

export interface McpConfigDocument {
  mcpServers: {
    "babel-content-clipper": {
      command: string;
      args: string[];
    };
  };
}

export interface InstallOptions {
  extensionId: string;
  profileId?: string;
  configDirectory?: string;
  outputRoot?: string;
  manifestDirectory?: string;
  mcpConfigPath?: string;
  cliPath?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  overwrite?: boolean;
}

export interface InstallResult {
  config: ReturnType<typeof redactBridgeConfig>;
  nativeHost: {
    manifestPath: string;
    launcherPath: string;
    manifest: NativeHostManifest;
  };
  mcpConfig?: {
    path: string;
    document: McpConfigDocument;
  };
  manualBrowserLocations: string[];
}

function assertExtensionId(value: string): string {
  if (!EXTENSION_ID_PATTERN.test(value)) {
    throw new ClipperBridgeError(
      "EXTENSION_ID_INVALID",
      "extensionId must be exactly 32 lowercase letters in the Chromium a-p alphabet.",
    );
  }
  return value;
}

function quotePosix(value: string): string {
  return "'" + value.replace(/'/g, "'\\\"'\\\"'") + "'";
}

function quoteCmd(value: string): string {
  if (/["\r\n]/u.test(value)) {
    throw new ClipperBridgeError("INSTALL_PATH_INVALID", "Installation paths cannot contain a quote or line break.");
  }
  return "\"" + value + "\"";
}

async function defaultCliPath(): Promise<string> {
  const bundled = fileURLToPath(new URL("./cli.js", import.meta.url));
  try {
    const metadata = await lstat(bundled);
    if (metadata.isFile()) return bundled;
  } catch {
    // A source-tree invocation is useful for isolated tests and development.
  }
  return fileURLToPath(new URL("./cli.ts", import.meta.url));
}

async function writeGeneratedFile(path: string, contents: string, overwrite: boolean | undefined): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!overwrite) {
    try {
      await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ClipperBridgeError(
          "INSTALL_TARGET_EXISTS",
          "The generated installation target already exists. Choose a new isolated path or pass --overwrite.",
        );
      }
      throw error;
    }
  }
  const temporary = path + ".new-" + process.pid + "-" + Date.now();
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function launcherContents(
  platform: NodeJS.Platform,
  nodePath: string,
  cliPath: string,
  configDirectory: string,
  extensionId: string,
): string {
  const sourceTree = cliPath.endsWith(".ts");
  const allowedOrigin = "chrome-extension://" + extensionId + "/";
  if (platform === "win32") {
    const args = sourceTree
      ? " --import tsx " + quoteCmd(cliPath)
      : " " + quoteCmd(cliPath);
    return "@echo off\r\n" + quoteCmd(nodePath) + args +
      " --mode=native-host --config-dir " + quoteCmd(configDirectory) +
      " --allowed-origin " + quoteCmd(allowedOrigin) + " %*\r\n";
  }
  const command = sourceTree
    ? quotePosix(nodePath) + " --import tsx " + quotePosix(cliPath)
    : quotePosix(nodePath) + " " + quotePosix(cliPath);
  return "#!/bin/sh\nexec " + command +
    " --mode=native-host --config-dir " + quotePosix(configDirectory) +
    " --allowed-origin " + quotePosix(allowedOrigin) + " \"$@\"\n";
}

function manualBrowserLocations(platform: NodeJS.Platform): string[] {
  const home = homedir();
  if (platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      join(home, "Library", "Application Support", "Google", "ChromeForTesting", "NativeMessagingHosts"),
      join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
      join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"),
    ];
  }
  if (platform === "win32") {
    return [
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + NATIVE_HOST_NAME,
      "HKCU\\Software\\Chromium\\NativeMessagingHosts\\" + NATIVE_HOST_NAME,
      "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + NATIVE_HOST_NAME,
    ];
  }
  return [
    join(home, ".config", "google-chrome", "NativeMessagingHosts"),
    join(home, ".config", "google-chrome-for-testing", "NativeMessagingHosts"),
    join(home, ".config", "chromium", "NativeMessagingHosts"),
    join(home, ".config", "microsoft-edge", "NativeMessagingHosts"),
  ];
}

export function createNativeHostManifest(extensionId: string, launcherPath: string): NativeHostManifest {
  const checkedId = assertExtensionId(extensionId);
  return {
    name: NATIVE_HOST_NAME,
    description: "Babel Content Clipper private local Native Messaging bridge",
    path: resolve(launcherPath),
    type: "stdio",
    allowed_origins: ["chrome-extension://" + checkedId + "/"],
  };
}

export function createMcpConfig(cliPath: string, configDirectory: string, profileId: string): McpConfigDocument {
  const checkedProfileId = assertProfileId(profileId);
  const sourceTree = cliPath.endsWith(".ts");
  return {
    mcpServers: {
      "babel-content-clipper": {
        command: process.execPath,
        args: [
          ...(sourceTree ? ["--import", "tsx"] : []),
          resolve(cliPath),
          "--mode=mcp",
          "--config-dir",
          resolve(configDirectory),
          "--profile-id",
          checkedProfileId,
        ],
      },
    },
  };
}

export async function installNativeHost(options: InstallOptions): Promise<InstallResult> {
  const extensionId = assertExtensionId(options.extensionId);
  const profileId = options.profileId;
  if (options.mcpConfigPath !== undefined && profileId === undefined) {
    throw new ClipperBridgeError(
      "PROFILE_REQUIRED",
      "--profile-id is required when generating an MCP config.",
    );
  }
  const platform = options.platform ?? process.platform;
  const configOptions: BridgeConfigOptions = {
    ...(options.configDirectory === undefined ? {} : { configDirectory: options.configDirectory }),
  };
  let config: BridgeConfig = await ensureBridgeConfig(configOptions);
  if (options.outputRoot !== undefined) {
    config = await updateBridgeConfig({ outputRoot: options.outputRoot }, configOptions);
  }
  const configDirectory = resolveBridgeConfigDirectory(configOptions);
  const cliPath = resolve(options.cliPath ?? await defaultCliPath());
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const targetDirectory = resolve(
    options.manifestDirectory ?? join(configDirectory, "native-messaging-hosts"),
  );
  const launcherDirectory = join(targetDirectory, "native-host");
  const launcherPath = join(
    launcherDirectory,
    platform === "win32" ? "babel-content-clipper-native-host.cmd" : "babel-content-clipper-native-host",
  );
  await writeGeneratedFile(
    launcherPath,
    launcherContents(platform, nodePath, cliPath, configDirectory, extensionId),
    options.overwrite,
  );
  if (platform !== "win32") await chmod(launcherPath, 0o700);
  const manifest = createNativeHostManifest(extensionId, launcherPath);
  const manifestPath = join(targetDirectory, NATIVE_HOST_NAME + ".json");
  await writeGeneratedFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    options.overwrite,
  );

  let mcpConfig: InstallResult["mcpConfig"];
  if (options.mcpConfigPath !== undefined) {
    /* The guard above establishes this for config generation. */
    if (profileId === undefined) throw new ClipperBridgeError("PROFILE_REQUIRED", "A profile id is required for an MCP config.");
    const document = createMcpConfig(cliPath, configDirectory, profileId);
    const path = resolve(options.mcpConfigPath);
    await writeGeneratedFile(path, JSON.stringify(document, null, 2) + "\n", options.overwrite);
    mcpConfig = { path, document };
  }
  return {
    config: redactBridgeConfig(config),
    nativeHost: { manifestPath, launcherPath, manifest },
    ...(mcpConfig === undefined ? {} : { mcpConfig }),
    manualBrowserLocations: manualBrowserLocations(platform),
  };
}
