import { describe, expect, it } from "vitest";
import type { CaptureListItem } from "../../packages/core/src/types.js";
import { collectPendingBatch } from "../../apps/extension/src/pending-batch.js";

function record(
  captureId: string,
  latestJobStatus: CaptureListItem["latestJobStatus"],
  latestJobId = `job-${captureId}`,
): CaptureListItem {
  return {
    captureId,
    sourceKey: "source",
    kind: "text_selection",
    title: captureId,
    site: "fixture.invalid",
    preview: captureId,
    state: "sealed",
    collection: "inbox",
    assetsState: "saved",
    createdAt: "2026-09-21T00:00:00.000Z",
    latestJobId,
    latestJobStatus,
  };
}

describe("pending batch snapshot collection", () => {
  it("walks every cursor, keeps only matching pending Jobs, and deduplicates stable IDs", async () => {
    const cursors: Array<string | undefined> = [];
    const items = await collectPendingBatch(async (cursor) => {
      cursors.push(cursor);
      if (!cursor) {
        return {
          records: [record("cap-first", "pending"), record("cap-completed", "completed")],
          nextCursor: "page-2",
        };
      }
      return {
        records: [record("cap-first", "pending"), record("cap-second", "pending"), record("cap-processing", "processing")],
        nextCursor: null,
      };
    }, (item) => item.captureId !== "cap-first");

    expect(cursors).toEqual([undefined, "page-2"]);
    expect(items).toEqual([{ captureId: "cap-second", jobId: "job-cap-second" }]);
  });

  it("fails closed when pagination repeats a cursor", async () => {
    await expect(collectPendingBatch(async () => ({
      records: [],
      nextCursor: "same-page",
    }))).rejects.toThrow("repeated cursor");
  });

  it("fails closed when one Job ID points at multiple Captures", async () => {
    await expect(collectPendingBatch(async () => ({
      records: [record("cap-a", "pending", "job-shared"), record("cap-b", "pending", "job-shared")],
      nextCursor: null,
    }))).rejects.toThrow("multiple Captures");
  });
});
