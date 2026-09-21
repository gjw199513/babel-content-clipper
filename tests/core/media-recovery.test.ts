import { describe, expect, it, vi } from "vitest";

import {
  discardTerminalMediaState,
  isPendingMediaSealNotice,
  PENDING_MEDIA_SEAL_NOTICE,
} from "../../apps/extension/src/media-recovery.js";

describe("media recovery disposition", () => {
  it.each(["sealed", "interrupted"] as const)(
    "stops residual recording before deleting temporary state for %s Core facts",
    async (captureState) => {
      const order: string[] = [];
      const stop = vi.fn(async () => { order.push("stop"); });
      const remove = vi.fn(async () => { order.push("remove"); });

      await expect(discardTerminalMediaState(captureState, stop, remove)).resolves.toBe(true);
      expect(order).toEqual(["stop", "remove"]);
    },
  );

  it("keeps temporary state for a genuinely open Capture", async () => {
    const stop = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    await expect(discardTerminalMediaState("open", stop, remove)).resolves.toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("retains temporary state when recording preservation fails", async () => {
    const stop = vi.fn(async () => { throw new Error("attachment still writing"); });
    const remove = vi.fn(async () => undefined);
    await expect(discardTerminalMediaState("interrupted", stop, remove)).rejects.toThrow("attachment still writing");
    expect(remove).not.toHaveBeenCalled();
  });

  it("recognizes only the stale pending-seal notice", () => {
    expect(isPendingMediaSealNotice({ message: PENDING_MEDIA_SEAL_NOTICE })).toBe(true);
    expect(isPendingMediaSealNotice({ message: "现场音画未启动" })).toBe(false);
    expect(isPendingMediaSealNotice(undefined)).toBe(false);
  });
});
