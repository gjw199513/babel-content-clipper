import { describe, expect, it } from "vitest";

import { observeMediaProgress, type ObservedMediaSegment } from "../../apps/extension/src/media-segments.js";
import { normalizeRanges } from "../../packages/core/src/ranges.js";

describe("media source-time observation", () => {
  it("keeps forward-seek gaps while same-capture revisits normalize by overlap", () => {
    const source = "https://media.example/video.webm";
    const segments: ObservedMediaSegment[] = [{ start: 2, end: 2, source }];

    observeMediaProgress(segments, {
      previousMediaSeconds: 2,
      currentMediaSeconds: 3,
      elapsedWallSeconds: 1,
      playbackRate: 1,
      source,
    });
    observeMediaProgress(segments, {
      previousMediaSeconds: 5,
      currentMediaSeconds: 5.9,
      elapsedWallSeconds: 0.9,
      playbackRate: 1,
      forcedSegmentStart: 5,
      source,
    });
    observeMediaProgress(segments, {
      previousMediaSeconds: 18,
      currentMediaSeconds: 19.8,
      elapsedWallSeconds: 0.9,
      playbackRate: 2,
      forcedSegmentStart: 18,
      source,
    });
    observeMediaProgress(segments, {
      previousMediaSeconds: 5,
      currentMediaSeconds: 6.2,
      elapsedWallSeconds: 0.6,
      playbackRate: 2,
      forcedSegmentStart: 5,
      source,
    });

    expect(segments).toEqual([
      { start: 2, end: 3, source },
      { start: 5, end: 5.9, source },
      { start: 18, end: 19.8, source },
      { start: 5, end: 6.2, source },
    ]);
    expect(normalizeRanges(segments)).toEqual([
      { start: 2, end: 3 },
      { start: 5, end: 6.2 },
      { start: 18, end: 19.8 },
    ]);
  });

  it("does not mistake delayed two-times playback for a seek", () => {
    const source = "https://media.example/video.webm";
    const segments: ObservedMediaSegment[] = [{ start: 18, end: 18, source }];

    const observed = observeMediaProgress(segments, {
      previousMediaSeconds: 18,
      currentMediaSeconds: 22,
      elapsedWallSeconds: 2,
      playbackRate: 2,
      source,
    });

    expect(observed.discontinuity).toBe(false);
    expect(segments).toEqual([{ start: 18, end: 22, source }]);
  });

  it("closes a continuous pause boundary but never fills a jump at that boundary", () => {
    const source = "https://media.example/video.webm";
    const segments: ObservedMediaSegment[] = [{ start: 2, end: 2.934026, source }];

    const pause = observeMediaProgress(segments, {
      previousMediaSeconds: 2.934026,
      currentMediaSeconds: 3.011497,
      elapsedWallSeconds: 0.08,
      playbackRate: 1,
      source,
      appendOnDiscontinuity: false,
    });
    expect(pause.discontinuity).toBe(false);
    expect(segments).toEqual([{ start: 2, end: 3.011497, source }]);

    const seekBoundary = observeMediaProgress(segments, {
      previousMediaSeconds: 3.011497,
      currentMediaSeconds: 18,
      elapsedWallSeconds: 0.1,
      playbackRate: 1,
      source,
      appendOnDiscontinuity: false,
    });
    expect(seekBoundary.discontinuity).toBe(true);
    expect(segments).toEqual([{ start: 2, end: 3.011497, source }]);
  });
});
