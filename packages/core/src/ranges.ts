import { ClipperError } from "./errors.js";
import type { DirectoryResolution, TimeRange } from "./types.js";

function assertRange(range: TimeRange): void {
  if (
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    throw new ClipperError("VALIDATION_ERROR", "Invalid non-negative time range", {
      start: range.start,
      end: range.end,
    });
  }
}

/**
 * Unions overlaps inside one capture. Raw observation-order segments remain on
 * the Capture; this derived value is the non-repeating source-time plan.
 */
export function normalizeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = ranges.map((range) => {
    assertRange(range);
    return { start: range.start, end: range.end };
  });
  sorted.sort((left, right) => left.start - right.start || left.end - right.end);

  const normalized: TimeRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (previous && range.start <= previous.end) {
      normalized[normalized.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
    } else {
      normalized.push(range);
    }
  }
  return normalized;
}

export function addPadding(
  ranges: readonly TimeRange[],
  beforeSeconds: number,
  afterSeconds: number,
  durationSeconds?: number,
): TimeRange[] {
  if (
    !Number.isFinite(beforeSeconds) ||
    !Number.isFinite(afterSeconds) ||
    beforeSeconds < 0 ||
    afterSeconds < 0
  ) {
    throw new ClipperError("VALIDATION_ERROR", "Padding must be finite and non-negative");
  }
  if (
    durationSeconds !== undefined &&
    (!Number.isFinite(durationSeconds) || durationSeconds < 0)
  ) {
    throw new ClipperError("VALIDATION_ERROR", "Known media duration must be non-negative");
  }

  return normalizeRanges(
    normalizeRanges(ranges).map((range) => ({
      start: Math.max(0, range.start - beforeSeconds),
      end:
        durationSeconds === undefined
          ? range.end + afterSeconds
          : Math.min(durationSeconds, range.end + afterSeconds),
    })),
  );
}

export function validateDirectory(directory: string, source: string): string {
  const normalized = directory.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ClipperError(
      "OUTPUT_DIRECTORY_INVALID",
      `The ${source} output directory is invalid`,
      { source },
    );
  }
  return normalized;
}

export function resolveOutputDirectory(input: {
  readonly task?: string;
  readonly connection?: string;
  readonly global?: string;
}): DirectoryResolution {
  if (input.task !== undefined) {
    return { path: validateDirectory(input.task, "task"), source: "task" };
  }
  if (input.connection !== undefined) {
    return {
      path: validateDirectory(input.connection, "connection"),
      source: "connection",
    };
  }
  if (input.global !== undefined) {
    return { path: validateDirectory(input.global, "global"), source: "global" };
  }
  return { source: "none" };
}

