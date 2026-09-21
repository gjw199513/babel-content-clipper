import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportCaptureBundle } from "../../packages/mcp/src/capture-export.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("complete local capture export", () => {
  it("writes text, HTML, metadata, every attachment byte, and a manifest without private source context", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "babel-capture-export-"));
    directories.push(outputRoot);
    const attachmentBytes = Buffer.from([1, 2, 3, 4, 5]);
    const detail = {
      capture: {
        captureId: "cap_demo",
        source: { title: "Demo", pageUrl: "https://example.test/article", site: "example.test" },
        selection: { type: "text", exact: "本地完整文本", sanitizedHtml: "<p>本地完整文本</p>" },
      },
      jobs: [],
      results: [],
      events: [],
      attachments: [{
        attachmentId: "att_image",
        mimeType: "image/png",
        dataAvailable: true,
        status: "complete",
        byteLength: attachmentBytes.byteLength,
      }],
    };
    const request = async (method: string, params: unknown): Promise<unknown> => {
      if (method === "capture.get") return detail;
      if (method === "attachment.get") {
        const value = params as { offset: number };
        const offset = value.offset;
        const bytes = attachmentBytes.subarray(offset, Math.min(offset + 3, attachmentBytes.length));
        return {
          attachment: detail.attachments[0],
          offset,
          returnedBytes: bytes.byteLength,
          totalBytes: attachmentBytes.byteLength,
          eof: offset + bytes.byteLength >= attachmentBytes.byteLength,
          dataBase64: bytes.toString("base64"),
        };
      }
      throw new Error(`unexpected request ${method}`);
    };

    const first = await exportCaptureBundle({
      request,
      captureId: "cap_demo",
      outputRoot,
      includeAttachmentBytes: true,
    });
    expect(first.complete).toBe(true);
    expect(first.files.map((file) => file.relativePath)).toEqual(expect.arrayContaining([
      "selected-text.txt",
      "selected.html",
      "capture.json",
      "source.json",
      "attachments/att_image.png",
      "manifest.json",
    ]));
    const captureDirectory = join(outputRoot, "captures", "cap_demo");
    await expect(readFile(join(captureDirectory, "selected-text.txt"), "utf8")).resolves.toBe("本地完整文本");
    await expect(readFile(join(captureDirectory, "attachments", "att_image.png"))).resolves.toEqual(attachmentBytes);
    const manifest = JSON.parse(await readFile(join(captureDirectory, "manifest.json"), "utf8")) as {
      complete: boolean;
      files: Array<{ relativePath: string }>;
    };
    expect(manifest.complete).toBe(true);
    expect(manifest.files.some((file) => file.relativePath === "attachments/att_image.png")).toBe(true);
    expect(await readFile(join(captureDirectory, "capture.json"), "utf8")).not.toContain("xsec_token");

    const second = await exportCaptureBundle({
      request,
      captureId: "cap_demo",
      outputRoot,
      includeAttachmentBytes: true,
    });
    expect(second.files.every((file) => file.reused)).toBe(true);
  });

  it("keeps metadata-only attachments as explicit missing facts", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "babel-capture-export-missing-"));
    directories.push(outputRoot);
    const result = await exportCaptureBundle({
      request: async (method) => method === "capture.get"
        ? {
            capture: {
              captureId: "cap_missing",
              source: { title: "Demo", pageUrl: "https://example.test", site: "example.test" },
              selection: { type: "image" },
            },
            jobs: [],
            results: [],
            events: [],
            attachments: [{ attachmentId: "att_missing", mimeType: "video/mp4", dataAvailable: false, byteLength: 10 }],
          }
        : undefined,
      captureId: "cap_missing",
      outputRoot,
      includeAttachmentBytes: true,
    });
    expect(result.complete).toBe(false);
    expect(result.missingAttachments).toEqual([{ attachmentId: "att_missing", reason: "attachment_bytes_unavailable" }]);
  });
});
