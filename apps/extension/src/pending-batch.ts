import type { CaptureListItem, CaptureListResult } from "../../../packages/core/src/types.js";

export interface PendingBatchItem {
  readonly captureId: string;
  readonly jobId: string;
}

type PendingBatchPage = Pick<CaptureListResult, "records" | "nextCursor">;

export async function collectPendingBatch(
  fetchPage: (cursor?: string) => Promise<PendingBatchPage>,
  matches: (record: CaptureListItem) => boolean = () => true,
): Promise<PendingBatchItem[]> {
  const items = new Map<string, PendingBatchItem>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("Pending batch pagination returned a repeated cursor.");
      seenCursors.add(cursor);
    }
    const page = await fetchPage(cursor);
    for (const record of page.records) {
      if (record.latestJobStatus !== "pending" || !record.latestJobId || !matches(record)) continue;
      const existing = items.get(record.latestJobId);
      if (existing && existing.captureId !== record.captureId) {
        throw new Error("Pending batch returned one Job for multiple Captures.");
      }
      items.set(record.latestJobId, { captureId: record.captureId, jobId: record.latestJobId });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return [...items.values()];
}
