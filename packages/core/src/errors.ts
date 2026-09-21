import type { JsonValue, SerializableClipperError } from "./types.js";

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "METHOD_NOT_FOUND",
  "PROFILE_REQUIRED",
  "NOT_FOUND",
  "CAPTURE_NOT_OPEN",
  "CAPTURE_INCOMPLETE",
  "CAPTURE_IMMUTABLE",
  "IDEMPOTENCY_CONFLICT",
  "ALREADY_CLAIMED",
  "NOT_ELIGIBLE",
  "CLAIM_TOKEN_INVALID",
  "RESULT_CONFLICT",
  "ATTACHMENT_CONFLICT",
  "ATTACHMENT_NOT_COMPLETE",
  "ATTACHMENT_CHUNK_TOO_LARGE",
  "ASSET_UNAVAILABLE",
  "OUTPUT_DIRECTORY_INVALID",
  "OUTPUT_DIRECTORY_REQUIRED",
  "CLEANUP_CONFLICT",
  "CLEANUP_TOKEN_EXPIRED",
  "IMPORT_CONFLICT",
  "MIGRATION_UNSUPPORTED",
  "BROWSER_UNAVAILABLE",
  "STORAGE_FAILED",
  "STORAGE_BUDGET_EXCEEDED",
] as const;

export type ClipperErrorCode = (typeof ERROR_CODES)[number];

export class ClipperError extends Error {
  readonly code: ClipperErrorCode | (string & {});
  readonly details?: JsonValue;

  constructor(
    code: ClipperErrorCode | (string & {}),
    message: string,
    details?: JsonValue,
  ) {
    super(message);
    this.name = "ClipperError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function serializeClipperError(error: unknown): SerializableClipperError {
  if (error instanceof ClipperError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }

  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message || "Unexpected core error",
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "Unexpected non-error thrown by core",
  };
}

export function invariant(
  condition: unknown,
  code: ClipperErrorCode | (string & {}),
  message: string,
  details?: JsonValue,
): asserts condition {
  if (!condition) {
    throw new ClipperError(code, message, details);
  }
}
