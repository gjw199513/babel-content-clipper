export interface PersistedMediaSegment {
  readonly start: number;
  readonly end: number;
  readonly source: string;
}

export interface ReconciledMediaSegments {
  readonly segments: PersistedMediaSegment[];
  readonly delta: Array<{ start: number; end: number }>;
}

function segmentDelta(
  previous: readonly PersistedMediaSegment[],
  current: readonly PersistedMediaSegment[],
): Array<{ start: number; end: number }> {
  const delta: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < current.length; index += 1) {
    const next = current[index];
    if (!next) continue;
    const before = previous[index];
    if (!before || before.start !== next.start || before.source !== next.source || next.end < before.end) {
      delta.push({ start: next.start, end: next.end });
    } else if (next.end > before.end) {
      delta.push({ start: before.end, end: next.end });
    }
  }
  return delta;
}

/**
 * Once the user has marked the end, later media-time observations describe
 * recording coverage only. They must not extend the selected source ranges.
 */
export function reconcileMediaSegments(
  previous: readonly PersistedMediaSegment[],
  candidate: readonly PersistedMediaSegment[],
  selectionRangeFrozen: boolean,
): ReconciledMediaSegments {
  const segments = (selectionRangeFrozen ? previous : candidate).map((segment) => ({
    ...segment,
  }));
  return {
    segments,
    delta: selectionRangeFrozen ? [] : segmentDelta(previous, segments),
  };
}
