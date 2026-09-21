import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import process from "node:process";
import type { BridgeConfig } from "./config.js";
import { ClipperBridgeError } from "./errors.js";

export interface BrokerStarterOptions {
  config: BridgeConfig;
  configDirectory: string;
  cliPath?: string;
  spawnProcess?: typeof spawn;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export async function brokerReachable(socketPath: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function defaultCliPath(): Promise<{ path: string; source: boolean }> {
  const bundled = fileURLToPath(new URL("./cli.js", import.meta.url));
  try {
    await access(bundled);
    return { path: bundled, source: false };
  } catch {
    return { path: fileURLToPath(new URL("./cli.ts", import.meta.url)), source: true };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Native Host processes are short-lived browser children. They never own the
 * broker; they race-safe start a detached daemon when none is listening, then
 * connect to the shared daemon used by every profile and MCP process.
 */
export async function ensureBrokerRunning(options: BrokerStarterOptions): Promise<void> {
  if (await brokerReachable(options.config.socketPath)) return;
  const target = options.cliPath ? { path: options.cliPath, source: options.cliPath.endsWith(".ts") } : await defaultCliPath();
  const spawnProcess = options.spawnProcess ?? spawn;
  const args = target.source
    ? ["--import", "tsx", target.path, "--mode=broker", "--config-dir", options.configDirectory]
    : [target.path, "--mode=broker", "--config-dir", options.configDirectory];
  let child: ChildProcess;
  try {
    child = spawnProcess(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    throw new ClipperBridgeError("BROKER_START_FAILED", "The local Babel Content Clipper broker could not be started.");
  }
  child.unref();

  const attempts = options.maxAttempts ?? 30;
  const retryDelayMs = options.retryDelayMs ?? 50;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await brokerReachable(options.config.socketPath)) return;
    await delay(retryDelayMs);
  }
  throw new ClipperBridgeError("BROKER_START_FAILED", "The local Babel Content Clipper broker did not become available.");
}
