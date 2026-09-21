import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export const NATIVE_HOST_NAME = "com.babel.content_clipper";

/** Chrome Native Messaging has a 1 MiB host-to-browser limit. */
export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

/** Keep the local broker frame limit equal to the native bridge limit. */
export const MAX_BROKER_FRAME_BYTES = MAX_NATIVE_MESSAGE_BYTES;

/** Core serves attachments in bounded 512 KiB raw chunks. */
export const MAX_ATTACHMENT_CHUNK_BYTES = 512 * 1024;

export const DEFAULT_RPC_TIMEOUT_MS = 15_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;

export const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export const MAX_WIRE_ID_LENGTH = 128;

export const BRIDGE_CONFIG_FILE = "bridge.json";

export const MCP_SERVER_NAME = "babel-content-clipper";

/* Keep the MCP identity on the package version so a release cannot silently
 * ship a new extension with an old hard-coded MCP version. */
import packageJson from "../../../package.json" with { type: "json" };

export const MCP_SERVER_VERSION = packageJson.version;
export const VERSION_CONTROL_SCHEMA = "babel.content-clipper.version.v1" as const;

/** Capabilities required before the MCP can safely request source media. */
export const REQUIRED_EXTENSION_CAPABILITIES = ["capture.acquireMedia"] as const;

function readInstalledVersion(path: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof value.version === "string" && value.version.trim().length > 0 ? value.version : undefined;
  } catch {
    return undefined;
  }
}

/** Read the package currently installed on disk, even if this MCP host started before an update. */
export function installedMcpServerVersion(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const installed = [
    join(moduleDirectory, "../../../package.json"),
    join(moduleDirectory, "../../package.json"),
    join(moduleDirectory, "../package.json"),
  ].filter(existsSync).map(readInstalledVersion).find((value): value is string => value !== undefined);
  return installed ?? MCP_SERVER_VERSION;
}

/**
 * These are transport-local methods, never forwarded to the extension's
 * IndexedDB service. Every business method is forwarded unchanged.
 */
export const BROKER_METHODS = {
  connect: "broker.connect",
  status: "broker.status",
} as const;

export const BRIDGE_METHODS = {
  hello: "bridge.hello",
} as const;
