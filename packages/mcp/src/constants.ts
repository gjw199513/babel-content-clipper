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

export const MCP_SERVER_VERSION = "0.1.0-alpha.1";

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

