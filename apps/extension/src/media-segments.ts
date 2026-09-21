export interface ObservedMediaSegment {
  start: number;
  end: number;
  source: string;
}

export interface MediaProgressSample {
  readonly previousMediaSeconds: number;
  readonly currentMediaSeconds: number;
  readonly elapsedWallSeconds: number;
  readonly playbackRate: number;
  readonly source: string;
  /** The exact destination reported by a real `seeking` event. */
  readonly forcedSegmentStart?: number;
  /** Boundary events use false so an unexpected jump cannot create coverage. */
  readonly appendOnDiscontinuity?: boolean;
}

/**
 * Adds one playing sample without fabricating coverage across a seek.
 *
 * Raw revisit segments stay separate here. Core later unions only overlaps
 * inside this Capture when it derives normalized source ranges.
 */
export function observeMediaProgress(
  segments: ObservedMediaSegment[],
  sample: MediaProgressSample,
): { readonly discontinuity: boolean } {
  const elapsed = Math.max(0, sample.elapsedWallSeconds);
  const rate = Number.isFinite(sample.playbackRate) && sample.playbackRate > 0
    ? sample.playbackRate
    : 1;
  const sourceAdvance = sample.currentMediaSeconds - sample.previousMediaSeconds;
  const expectedAdvance = elapsed * rate;
  const forwardJumpTolerance = Math.max(1, expectedAdvance * 0.75);
  const inferredDiscontinuity = sourceAdvance < -0.35
    || sourceAdvance > expectedAdvance + forwardJumpTolerance;
  const forcedStart = sample.forcedSegmentStart;
  const discontinuity = forcedStart !== undefined || inferredDiscontinuity;

  if (discontinuity) {
    if (sample.appendOnDiscontinuity === false) return { discontinuity: true };
    const requestedStart = forcedStart ?? sample.currentMediaSeconds;
    const start = Math.max(0, Math.min(requestedStart, sample.currentMediaSeconds));
    const end = Math.max(start, sample.currentMediaSeconds);
    segments.push({ start, end, source: sample.source });
    return { discontinuity: true };
  }

  const last = segments.at(-1);
  if (
    last
    && last.source === sample.source
    && sample.currentMediaSeconds >= last.end - 0.35
    && sample.currentMediaSeconds >= last.start
  ) {
    last.end = Math.max(last.end, sample.currentMediaSeconds);
  } else {
    segments.push({
      start: Math.max(0, sample.currentMediaSeconds),
      end: Math.max(0, sample.currentMediaSeconds),
      source: sample.source,
    });
  }
  return { discontinuity: false };
}
