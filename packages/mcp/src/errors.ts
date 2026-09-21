export interface BridgeErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * A stable, serializable error for transport and local-installation failures.
 * Its message intentionally excludes credentials, cookies, raw payloads, and
 * local configuration secrets.
 */
export class ClipperBridgeError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ClipperBridgeError";
    this.code = code;
    this.details = details;
  }

  toPayload(): BridgeErrorPayload {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function asBridgeError(error: unknown, fallbackCode = "INTERNAL_ERROR"): ClipperBridgeError {
  if (error instanceof ClipperBridgeError) return error;
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof value.code === "string" && typeof value.message === "string") {
      return new ClipperBridgeError(value.code, value.message, value.details);
    }
  }
  return new ClipperBridgeError(fallbackCode, "The local Babel Content Clipper bridge encountered an unexpected error.");
}

export function errorPayload(error: unknown, fallbackCode?: string): BridgeErrorPayload {
  return asBridgeError(error, fallbackCode).toPayload();
}
