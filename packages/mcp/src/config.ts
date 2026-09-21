import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { BRIDGE_CONFIG_FILE, BRIDGE_PROTOCOL_VERSION, NATIVE_HOST_NAME } from "./constants.js";
import { ClipperBridgeError } from "./errors.js";
import { isRecord } from "./wire.js";

export interface BridgeConfig {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  hostName: typeof NATIVE_HOST_NAME;
  socketPath: string;
  secret: string;
  outputRoot?: string;
}

export interface RedactedBridgeConfig {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  hostName: typeof NATIVE_HOST_NAME;
  socketPath: string;
  outputRootConfigured: boolean;
}

export interface BridgeConfigOptions {
  configDirectory?: string;
  outputRoot?: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  tempDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

export function resolveBridgeConfigDirectory(options: BridgeConfigOptions = {}): string {
  if (options.configDirectory) return resolve(options.configDirectory);
  const environment = options.environment ?? process.env;
  if (environment.BABEL_CONTENT_CLIPPER_CONFIG_DIR) return resolve(environment.BABEL_CONTENT_CLIPPER_CONFIG_DIR);
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homedir();
  if (platform === "win32") return join(environment.APPDATA || join(home, "AppData", "Roaming"), "Babel Content Clipper");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Babel Content Clipper");
  return join(environment.XDG_CONFIG_HOME || join(home, ".config"), "babel-content-clipper");
}

export function bridgeConfigPath(options: BridgeConfigOptions = {}): string {
  return join(resolveBridgeConfigDirectory(options), BRIDGE_CONFIG_FILE);
}

function configDigest(configDirectory: string): string {
  return createHash("sha256").update(configDirectory).digest("hex").slice(0, 20);
}

export function defaultSocketPath(options: BridgeConfigOptions = {}): string {
  const directory = resolveBridgeConfigDirectory(options);
  const platform = options.platform ?? process.platform;
  const digest = configDigest(directory);
  if (platform === "win32") return `\\\\.\\pipe\\babel-content-clipper-${digest}`;

  const direct = join(directory, "broker.sock");
  // Most Unix-family systems reserve roughly 104 bytes for a socket path.
  if (Buffer.byteLength(direct) <= 92) return direct;
  return join(options.tempDirectory ?? tmpdir(), `babel-content-clipper-${digest}`, "broker.sock");
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new ClipperBridgeError("CONFIG_PATH_UNSAFE", "The local bridge configuration directory must be a real private directory.");
    }
    const uid = process.getuid?.();
    if (uid !== undefined && before.uid !== uid) {
      throw new ClipperBridgeError("CONFIG_OWNER_INVALID", "The local bridge configuration directory is not owned by the current user.");
    }
    await chmod(path, 0o700);
    const metadata = await stat(path);
    if ((metadata.mode & 0o077) !== 0) {
      throw new ClipperBridgeError("CONFIG_PERMISSION_INVALID", "The bridge configuration directory is accessible by other local users.");
    }
  }
}

async function assertPrivateConfigFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ClipperBridgeError("CONFIG_PATH_UNSAFE", "The local bridge configuration file must be a regular private file.");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new ClipperBridgeError("CONFIG_OWNER_INVALID", "The local bridge configuration file is not owned by the current user.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new ClipperBridgeError("CONFIG_PERMISSION_INVALID", "The local bridge configuration file is accessible by other local users.");
  }
}

function assertConfig(value: unknown): asserts value is BridgeConfig {
  if (!isRecord(value)
    || value.v !== BRIDGE_PROTOCOL_VERSION
    || value.hostName !== NATIVE_HOST_NAME
    || typeof value.socketPath !== "string"
    || !isAbsolute(value.socketPath) && !value.socketPath.startsWith("\\\\.\\pipe\\")
    || typeof value.secret !== "string"
    || !/^[A-Za-z0-9_-]{40,128}$/.test(value.secret)
    || (value.outputRoot !== undefined && typeof value.outputRoot !== "string")) {
    throw new ClipperBridgeError("CONFIG_INVALID", "The local bridge configuration is malformed.");
  }
}

async function writeConfig(path: string, config: BridgeConfig, createOnly = false): Promise<void> {
  await secureDirectory(dirname(path));
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    if (createOnly) {
      // `link` is a create-if-absent commit: two concurrent first starts cannot
      // replace one another's secret with a later rename.
      try {
        await link(temporaryPath, path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") throw error;
        /*
         * Some Windows file systems do not permit hard links. O_EXCL still
         * provides create-if-absent semantics without replacing a concurrently
         * created secret.
         */
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw error;
        await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        if (process.platform !== "win32") await chmod(path, 0o600);
      }
    } else {
      await rename(temporaryPath, path);
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function loadBridgeConfig(options: BridgeConfigOptions = {}): Promise<BridgeConfig> {
  const path = bridgeConfigPath(options);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ClipperBridgeError("BRIDGE_NOT_CONFIGURED", "The local Babel Content Clipper bridge is not configured yet.");
    }
    throw new ClipperBridgeError("CONFIG_READ_FAILED", "The local bridge configuration could not be read.");
  }
  await assertPrivateConfigFile(path);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ClipperBridgeError("CONFIG_INVALID", "The local bridge configuration is not valid JSON.");
  }
  assertConfig(value);
  return value;
}

export async function ensureBridgeConfig(options: BridgeConfigOptions = {}): Promise<BridgeConfig> {
  try {
    return await loadBridgeConfig(options);
  } catch (error) {
    if (!(error instanceof ClipperBridgeError) || error.code !== "BRIDGE_NOT_CONFIGURED") throw error;
  }

  const config: BridgeConfig = {
    v: BRIDGE_PROTOCOL_VERSION,
    hostName: NATIVE_HOST_NAME,
    socketPath: defaultSocketPath(options),
    secret: randomBytes(32).toString("base64url"),
    ...(options.outputRoot ? { outputRoot: resolve(options.outputRoot) } : {}),
  };
  const path = bridgeConfigPath(options);
  try {
    await writeConfig(path, config, true);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadBridgeConfig(options);
    throw error;
  }
}

export async function updateBridgeConfig(
  update: Pick<BridgeConfigOptions, "outputRoot">,
  options: BridgeConfigOptions = {},
): Promise<BridgeConfig> {
  const current = await ensureBridgeConfig(options);
  const next: BridgeConfig = {
    ...current,
    ...(update.outputRoot === undefined ? {} : { outputRoot: resolve(update.outputRoot) }),
  };
  await writeConfig(bridgeConfigPath(options), next);
  return next;
}

export function redactBridgeConfig(config: BridgeConfig): RedactedBridgeConfig {
  return {
    v: config.v,
    hostName: config.hostName,
    socketPath: config.socketPath,
    outputRootConfigured: typeof config.outputRoot === "string",
  };
}

/** Ensure the Unix socket parent is private before the broker binds it. */
export async function prepareSocketDirectory(config: BridgeConfig): Promise<void> {
  if (process.platform === "win32" || config.socketPath.startsWith("\\\\.\\pipe\\")) return;
  await secureDirectory(dirname(config.socketPath));
}
