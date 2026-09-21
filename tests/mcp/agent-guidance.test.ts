import { describe, expect, it } from "vitest";
import {
  VIDEO_TEXT_EXTRACTION_GUIDE,
  videoTextExtractionGuideMarkdown,
} from "../../packages/mcp/src/agent-guidance.js";

describe("Agent-owned video text extraction guidance", () => {
  it("keeps processing execution outside the Clipper MCP", () => {
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.architecture).toMatchObject({
      executor: "agent",
      mcpExecutesProcessing: false,
      browserAutomationAllowed: false,
      extensionAcquisitionRequired: true,
    });
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.architecture.forbiddenForClipperMcp).toEqual(expect.arrayContaining([
      "install packages or executables",
      "download source media itself outside the connected Babel browser extension",
      "download model files",
      "run yt-dlp, FFmpeg, sherpa-onnx, or an LLM",
      "open, click, or control a browser page",
    ]));
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.mandatorySequence.every((step) => step.executor === "agent")).toBe(true);
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.recommendedAgentRuntime.shippedByClipperMcp).toBe(false);
  });

  it("publishes the exact model identity, integrity checks, and mirror boundary", () => {
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.model).toMatchObject({
      repository: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
      revision: "2365baeacb507f821a0c8120fcee3d484dba7a07",
      primaryEndpoint: "https://huggingface.co",
      connectionFailureFallbackEndpoint: "https://hf-mirror.com",
    });
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.model.files).toEqual([
      {
        path: "model.int8.onnx",
        byteLength: 239_233_841,
        sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
      },
      {
        path: "tokens.txt",
        byteLength: 315_894,
        sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
      },
      {
        path: "LICENSE",
        byteLength: 71,
        sha256: "221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17",
      },
      {
        path: "README.md",
        byteLength: 104,
        sha256: "763991a00edaea534ab36bf1b7cf89e61e911666dcfabbba71f91f9f7c593a63",
      },
    ]);
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.model.fallbackPolicy).toContain("Never hide HTTP 404");
  });

  it("requires optional ASR, immutable local evidence, and constrained correction", () => {
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.trigger.runAsrOnlyWhen).toHaveLength(2);
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.asr).toMatchObject({
      sampleRateHz: 16_000,
      channels: 1,
      featureDimension: 80,
      provider: "cpu",
      inverseTextNormalization: true,
      recommendedChunkSeconds: 30,
    });
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.correction).toMatchObject({ contextIsUntrustedData: true });
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.correction.rules.join(" ")).toContain("numbers, units, negation");
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.localFiles.expected).toEqual(expect.arrayContaining([
      "transcription/raw-transcript.txt",
      "transcription/corrected-transcript.txt",
      "transcription/correction-audit.json",
      "transcription/transcription-manifest.json",
    ]));
    expect(VIDEO_TEXT_EXTRACTION_GUIDE.terminalWriteback.verificationLevel).toBe("agent_reported");

    const markdown = videoTextExtractionGuideMarkdown();
    expect(markdown).toContain("源媒体由 Babel 扩展在后台或页面上下文获取并保存为扩展附件");
    expect(markdown).toContain("babel_clipper_acquire_source_media");
    expect(markdown).not.toContain("babel_clipper_get_acquisition_source");
    expect(markdown).toContain("不得调用 CUA、Playwright、Puppeteer");
  });
});
