import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureBridgeConfig,
  loadBridgeConfig,
} from "../../packages/mcp/src/config.js";
import {
  materializeAttachmentChunk,
  validateArtifactFileReferences,
  validateOutputDirectory,
} from "../../packages/mcp/src/safe-output.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "babel-clipper-output-"));
  directories.push(directory);
  return directory;
}

describe("private config creation and controlled output", () => {
  it("creates one stable bridge secret when simultaneous first starts race", async () => {
    const directory = await temporaryDirectory();
    const configDirectory = join(directory, "bridge");
    const configs = await Promise.all(
      Array.from({ length: 16 }, () => ensureBridgeConfig({ configDirectory })),
    );
    expect(new Set(configs.map((config) => config.secret)).size).toBe(1);
    const loaded = await loadBridgeConfig({ configDirectory });
    expect(loaded.secret).toBe(configs[0]?.secret);
  });

  it("rejects a symlink traversal before creating a directory outside the approved root", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    const root = join(directory, "output");
    const outside = join(directory, "outside");
    await validateOutputDirectory(root);
    await validateOutputDirectory(outside);
    await symlink(outside, join(root, "escape"));

    await expect(validateOutputDirectory(root, join(root, "escape", "created")))
      .rejects.toMatchObject({ code: "OUTPUT_PATH_FORBIDDEN" });
    await expect(readFile(join(outside, "created", "not-created.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses Core attachment metadata MIME, permits identical retry, and refuses overwrite conflicts", async () => {
    const directory = await temporaryDirectory();
    const output = await validateOutputDirectory(join(directory, "output"));
    const chunk = {
      attachment: { mimeType: "video/mp4" },
      offset: 0,
      returnedBytes: 3,
      totalBytes: 3,
      eof: true,
      dataBase64: "AQID",
    };
    const first = await materializeAttachmentChunk(chunk, "clip-1", output);
    expect(first.path.endsWith(".mp4")).toBe(true);
    await expect(readFile(first.path)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(materializeAttachmentChunk(chunk, "clip-1", output)).resolves.toMatchObject(first);

    await writeFile(first.path, Buffer.from([4, 5, 6]));
    await expect(materializeAttachmentChunk(chunk, "clip-1", output))
      .rejects.toMatchObject({ code: "ATTACHMENT_OUTPUT_CONFLICT" });
  });

  it("requires regular local artifact files below the persisted job directory", async () => {
    const directory = await temporaryDirectory();
    const output = await validateOutputDirectory(join(directory, "job-output"));
    const artifactPath = join(output, "result.mp4");
    await writeFile(artifactPath, Buffer.from([1, 2, 3, 4]));
    await expect(validateArtifactFileReferences(output, [{
      fileReference: artifactPath,
      byteLength: 4,
    }])).resolves.toBeUndefined();
    await expect(validateArtifactFileReferences(output, [{
      fileReference: artifactPath,
      byteLength: 3,
    }])).rejects.toMatchObject({ code: "ARTIFACT_LENGTH_MISMATCH" });
    await expect(validateArtifactFileReferences(output, [{
      fileReference: join(directory, "outside.mp4"),
    }])).rejects.toMatchObject({ code: "ARTIFACT_PATH_FORBIDDEN" });

    if (process.platform !== "win32") {
      const outsideDirectory = join(directory, "outside-directory");
      await validateOutputDirectory(outsideDirectory);
      const escapedArtifact = join(outsideDirectory, "escaped.mp4");
      await writeFile(escapedArtifact, Buffer.from([1]));
      await symlink(outsideDirectory, join(output, "escape"));
      await expect(validateArtifactFileReferences(output, [{
        fileReference: join(output, "escape", "escaped.mp4"),
      }])).rejects.toMatchObject({ code: "ARTIFACT_PATH_FORBIDDEN" });
    }
  });
});
