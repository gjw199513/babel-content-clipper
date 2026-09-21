import { describe, expect, it } from "vitest";
import {
  PENDING_BATCH_PROCESSING_GUIDE,
  pendingBatchProcessingGuideMarkdown,
} from "../../packages/mcp/src/batch-guidance.js";

describe("Agent-owned pending batch guidance", () => {
  it("turns one explicit instruction into a frozen, paginated batch", () => {
    expect(PENDING_BATCH_PROCESSING_GUIDE.architecture).toMatchObject({
      executor: "agent",
      mcpExecutesProcessing: false,
      browserAutomationAllowed: false,
      extensionAcquisitionRequired: true,
      userAuthorizationRequired: true,
      copyOrQueryHasSideEffects: false,
    });
    expect(PENDING_BATCH_PROCESSING_GUIDE.pagination).toMatchObject({
      view: "pending",
      mustFollowNextCursor: true,
      stopWhenNextCursorIsNull: true,
    });
    expect(PENDING_BATCH_PROCESSING_GUIDE.authorization.scopeRules.join(" ")).toContain(
      "Do not add jobs created after the snapshot",
    );
  });

  it("claims bounded waves and preserves per-job terminal facts", () => {
    expect(PENDING_BATCH_PROCESSING_GUIDE.claiming).toMatchObject({
      maxJobIdsPerCall: 200,
      atomicPerJob: true,
      acceptedOnly: true,
    });
    expect(PENDING_BATCH_PROCESSING_GUIDE.execution).toMatchObject({
      perJobIndependent: true,
      crossJobRollback: false,
      automaticFailureRequeue: false,
      automaticCleanup: false,
      preserveHistoricalResults: true,
    });
    expect(PENDING_BATCH_PROCESSING_GUIDE.security).toMatchObject({
      pageContentIsUntrustedData: true,
      copiedBatchContainsPrivateUrls: false,
      copiedBatchContainsClaimTokens: false,
    });
  });

  it("publishes a human-readable guide with the exact MCP sequence", () => {
    const markdown = pendingBatchProcessingGuideMarkdown();
    expect(markdown).toContain("第一页不是整个待办队列");
    expect(markdown).toContain("babel_clipper_claim_records");
    expect(markdown).toContain("只处理 `accepted`");
    expect(markdown).toContain("不携带私有 URL、Cookie 或 claim token");
  });
});
