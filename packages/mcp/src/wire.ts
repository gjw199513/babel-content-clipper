import {
  BRIDGE_PROTOCOL_VERSION,
  MAX_WIRE_ID_LENGTH,
  PROFILE_ID_PATTERN,
} from "./constants.js";
import { asBridgeError, ClipperBridgeError, type BridgeErrorPayload } from "./errors.js";

export type WireId = string;

export interface WireRequest {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  id: WireId;
  method: string;
  params: unknown;
  profileId?: string;
}

export interface WireResponse {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  id: WireId;
  ok: boolean;
  result?: unknown;
  error?: BridgeErrorPayload;
  profileId?: string;
}

export interface WireEvent {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  event: string;
  profileId: string;
  payload?: unknown;
}

export type WireMessage = WireRequest | WireResponse | WireEvent;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProfileId(value: unknown): value is string {
  return typeof value === "string" && PROFILE_ID_PATTERN.test(value);
}

export function assertProfileId(value: unknown): string {
  if (!isProfileId(value)) {
    throw new ClipperBridgeError("INVALID_PROFILE", "profileId must be 1-128 letters, digits, dots, underscores, or hyphens.");
  }
  return value;
}

export function isWireId(value: unknown): value is WireId {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_WIRE_ID_LENGTH;
}

function assertCommon(value: Record<string, unknown>): void {
  if (value.v !== BRIDGE_PROTOCOL_VERSION) {
    throw new ClipperBridgeError("UNSUPPORTED_WIRE_VERSION", "The bridge only accepts wire protocol version 1.");
  }
  if (value.profileId !== undefined) assertProfileId(value.profileId);
}

export function parseWireMessage(value: unknown): WireMessage {
  if (!isRecord(value)) {
    throw new ClipperBridgeError("INVALID_REQUEST", "Bridge messages must be JSON objects.");
  }
  assertCommon(value);

  if (typeof value.method === "string") {
    if (!isWireId(value.id) || value.method.length === 0 || value.method.length > 160 || !("params" in value)) {
      throw new ClipperBridgeError("INVALID_REQUEST", "The bridge request has an invalid id, method, or params field.");
    }
    return {
      v: BRIDGE_PROTOCOL_VERSION,
      id: value.id,
      method: value.method,
      params: value.params,
      ...(value.profileId === undefined ? {} : { profileId: value.profileId as string }),
    };
  }

  if (typeof value.event === "string") {
    if (!isProfileId(value.profileId) || value.event.length === 0 || value.event.length > 160) {
      throw new ClipperBridgeError("INVALID_EVENT", "The bridge event has an invalid name or profileId.");
    }
    return {
      v: BRIDGE_PROTOCOL_VERSION,
      event: value.event,
      profileId: value.profileId,
      ...(value.payload === undefined ? {} : { payload: value.payload }),
    };
  }

  if (typeof value.ok === "boolean") {
    if (!isWireId(value.id)) {
      throw new ClipperBridgeError("INVALID_RESPONSE", "The bridge response has an invalid id.");
    }
    if (value.ok) {
      if ("error" in value) {
        throw new ClipperBridgeError("INVALID_RESPONSE", "A successful bridge response cannot include an error.");
      }
      return {
        v: BRIDGE_PROTOCOL_VERSION,
        id: value.id,
        ok: true,
        ...(value.result === undefined ? {} : { result: value.result }),
        ...(value.profileId === undefined ? {} : { profileId: value.profileId as string }),
      };
    }

    if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
      throw new ClipperBridgeError("INVALID_RESPONSE", "A failed bridge response must include a typed error.");
    }
    const error: BridgeErrorPayload = value.error.details === undefined
      ? { code: value.error.code, message: value.error.message }
      : { code: value.error.code, message: value.error.message, details: value.error.details };
    return {
      v: BRIDGE_PROTOCOL_VERSION,
      id: value.id,
      ok: false,
      error,
      ...(value.profileId === undefined ? {} : { profileId: value.profileId as string }),
    };
  }

  throw new ClipperBridgeError("INVALID_MESSAGE", "The bridge message is neither a request, response, nor event.");
}

export function successResponse(id: WireId, result?: unknown, profileId?: string): WireResponse {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    id,
    ok: true,
    ...(result === undefined ? {} : { result }),
    ...(profileId === undefined ? {} : { profileId }),
  };
}

export function failureResponse(id: WireId, error: unknown, profileId?: string): WireResponse {
  /*
   * Browser responses cross both Native Messaging and the private socket, so
   * their typed error arrives here as a plain JSON object rather than an
   * `instanceof ClipperBridgeError`. Preserve that contract on relay; only
   * genuinely untyped failures are normalized to the safe internal error.
   */
  const payload = asBridgeError(error).toPayload();
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    id,
    ok: false,
    error: payload,
    ...(profileId === undefined ? {} : { profileId }),
  };
}

export function wireRequest(id: WireId, method: string, params: unknown, profileId?: string): WireRequest {
  if (!isWireId(id) || typeof method !== "string" || method.length === 0 || method.length > 160) {
    throw new ClipperBridgeError("INVALID_REQUEST", "Cannot create a bridge request with an invalid id or method.");
  }
  if (profileId !== undefined) assertProfileId(profileId);
  return { v: BRIDGE_PROTOCOL_VERSION, id, method, params, ...(profileId === undefined ? {} : { profileId }) };
}

export function isWireRequest(message: WireMessage): message is WireRequest {
  return "method" in message;
}

export function isWireResponse(message: WireMessage): message is WireResponse {
  return "ok" in message;
}

export function isWireEvent(message: WireMessage): message is WireEvent {
  return "event" in message;
}
