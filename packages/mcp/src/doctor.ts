import {
  loadBridgeConfig,
  redactBridgeConfig,
  resolveBridgeConfigDirectory,
  type BridgeConfigOptions,
} from "./config.js";
import { BrokerClient } from "./broker-client.js";
import { brokerReachable } from "./ensure-broker.js";
import { asBridgeError } from "./errors.js";
import { assertProfileId, isRecord } from "./wire.js";

export interface DoctorOptions {
  configDirectory?: string;
  profileId?: string;
}

export interface DoctorReport {
  ready: boolean;
  configDirectory: string;
  config: unknown;
  broker: unknown;
  extension: unknown;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = /(?:token|cookie|authorization|secret|password)/iu.test(key)
      ? "[redacted]"
      : redact(child);
  }
  return result;
}

function errorResult(error: unknown): { ok: false; error: { code: string; message: string; details?: unknown } } {
  return { ok: false, error: asBridgeError(error).toPayload() };
}

/*
 * Read-only installation and routing diagnostics. This never creates a bridge,
 * changes browser configuration, or prints its local socket secret.
 */
export async function diagnoseBridge(options: DoctorOptions = {}): Promise<DoctorReport> {
  const configOptions: BridgeConfigOptions = {
    ...(options.configDirectory === undefined ? {} : { configDirectory: options.configDirectory }),
  };
  const configDirectory = resolveBridgeConfigDirectory(configOptions);
  let config;
  try {
    config = await loadBridgeConfig(configOptions);
  } catch (error) {
    return {
      ready: false,
      configDirectory,
      config: errorResult(error),
      broker: { ok: false, error: { code: "BRIDGE_NOT_CONFIGURED", message: "No readable bridge configuration is available." } },
      extension: { ok: false, error: { code: "BROWSER_UNAVAILABLE", message: "No configured bridge can reach a browser profile." } },
    };
  }

  const reachable = await brokerReachable(config.socketPath);
  if (!reachable) {
    return {
      ready: false,
      configDirectory,
      config: { ok: true, value: redactBridgeConfig(config) },
      broker: { ok: false, error: { code: "BROKER_UNAVAILABLE", message: "The private local broker is not running." } },
      extension: { ok: false, error: { code: "BROWSER_UNAVAILABLE", message: "The browser profile cannot be checked while the broker is offline." } },
    };
  }

  if (options.profileId === undefined) {
    return {
      ready: false,
      configDirectory,
      config: { ok: true, value: redactBridgeConfig(config) },
      broker: { ok: true, reachable: true },
      extension: { ok: false, error: { code: "PROFILE_REQUIRED", message: "Pass --profile-id to diagnose one browser profile." } },
    };
  }

  const profileId = assertProfileId(options.profileId);
  let client: BrokerClient | undefined;
  try {
    client = await BrokerClient.connect({ config, role: "mcp", profileId });
    const local = await client.request("broker.status", {}, profileId);
    if (!isRecord(local) || local.browserConnected !== true) {
      return {
        ready: false,
        configDirectory,
        config: { ok: true, value: redactBridgeConfig(config) },
        broker: { ok: true, value: redact(local) },
        extension: { ok: false, error: { code: "BROWSER_UNAVAILABLE", message: "The selected browser profile is not connected." } },
      };
    }
    try {
      const [status, diagnostics] = await Promise.all([
        client.request("connection.status", {}, profileId),
        client.request("diagnostics.get", {}, profileId),
      ]);
      const statusObject = isRecord(status) ? status : {};
      const extensionReady =
        statusObject.browserAvailable === true && statusObject.databaseAvailable === true;
      return {
        ready: extensionReady,
        configDirectory,
        config: { ok: true, value: redactBridgeConfig(config) },
        broker: { ok: true, value: redact(local) },
        extension: { ok: true, connection: redact(status), diagnostics: redact(diagnostics) },
      };
    } catch (error) {
      return {
        ready: false,
        configDirectory,
        config: { ok: true, value: redactBridgeConfig(config) },
        broker: { ok: true, value: redact(local) },
        extension: errorResult(error),
      };
    }
  } catch (error) {
    return {
      ready: false,
      configDirectory,
      config: { ok: true, value: redactBridgeConfig(config) },
      broker: errorResult(error),
      extension: { ok: false, error: { code: "BROWSER_UNAVAILABLE", message: "The selected browser profile cannot be reached." } },
    };
  } finally {
    client?.close();
  }
}
