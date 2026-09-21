import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { MAX_ATTACHMENT_CHUNK_BYTES } from "./constants.js";
import { ClipperBridgeError } from "./errors.js";

export interface AttachmentChunk {
  attachment?: {
    mimeType?: unknown;
    fileReference?: unknown;
  };
  offset?: unknown;
  returnedBytes?: unknown;
  totalBytes?: unknown;
  eof?: unknown;
  dataBase64?: unknown;
}

export interface MaterializedAttachment {
  path: string;
  byteLength: number;
  mimeType?: string;
}

export interface ArtifactFileReference {
  fileReference?: unknown;
  byteLength?: unknown;
}

function pathInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function outputError(code: string, message: string): ClipperBridgeError {
  return new ClipperBridgeError(code, message);
}

/*
 * The root itself must be a real directory. Existing ancestors may include
 * platform-owned aliases such as macOS /var -> /private/var, so creation first
 * resolves the nearest existing ancestor and then creates only missing pieces.
 */
async function ensureRootDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  try {
    const metadata = await lstat(absolute);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw outputError("OUTPUT_PATH_FORBIDDEN", "The controlled output root is not a real directory.");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const missing: string[] = [];
  let ancestor = absolute;
  for (;;) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
    try {
      const metadata = await lstat(ancestor);
      if (!metadata.isDirectory()) {
        throw outputError("OUTPUT_PATH_FORBIDDEN", "The controlled output root has no directory ancestor.");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  let current = await realpath(ancestor);
  for (const part of missing) {
    const target = join(current, part);
    try {
      const metadata = await lstat(target);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw outputError("OUTPUT_PATH_FORBIDDEN", "The controlled output root contains a symlink or non-directory component.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      const metadata = await lstat(target);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw outputError("OUTPUT_PATH_FORBIDDEN", "The controlled output root contains a symlink or non-directory component.");
      }
    }
    current = target;
  }
}

/*
 * Once the real root exists, every requested child is checked before making
 * the next directory. This is the boundary that prevents a symlink within the
 * controlled root from causing an external directory to be created.
 */
async function ensureChildDirectory(root: string, childPath: string): Promise<void> {
  if (childPath === "") return;
  let current = root;
  for (const part of childPath.split(/[\\/]+/u)) {
    if (!part || part === ".") continue;
    const target = join(current, part);
    try {
      const metadata = await lstat(target);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw outputError(
          "OUTPUT_PATH_FORBIDDEN",
          "The requested output directory contains a symlink or non-directory component.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      const metadata = await lstat(target);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw outputError(
          "OUTPUT_PATH_FORBIDDEN",
          "The requested output directory contains a symlink or non-directory component.",
        );
      }
    }
    current = target;
  }
}

export async function validateOutputDirectory(root: string | undefined, requested?: string): Promise<string> {
  if (!root) {
    throw outputError(
      "OUTPUT_ROOT_UNCONFIGURED",
      "No controlled output directory is configured for this MCP connection.",
    );
  }
  if (requested !== undefined && (!requested || !isAbsolute(requested))) {
    throw outputError("OUTPUT_PATH_INVALID", "The requested output directory must be an absolute local path.");
  }
  const rootPath = resolve(root);
  const candidate = requested === undefined ? rootPath : resolve(requested);
  if (!pathInside(rootPath, candidate)) {
    throw outputError(
      "OUTPUT_PATH_FORBIDDEN",
      "The requested output directory is outside the configured controlled output root.",
    );
  }
  await ensureRootDirectory(rootPath);
  const realRoot = await realpath(rootPath);
  const childPath = relative(rootPath, candidate);
  await ensureChildDirectory(realRoot, childPath);
  return childPath === "" ? realRoot : join(realRoot, childPath);
}

function decodedBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw outputError("ATTACHMENT_ENCODING_INVALID", "The extension returned an invalid base64 attachment chunk.");
  }
  return Buffer.from(value, "base64");
}

function extensionForMime(value: unknown): string {
  if (value === "image/png") return ".png";
  if (value === "image/jpeg") return ".jpg";
  if (value === "audio/mpeg") return ".mp3";
  if (value === "audio/mp4") return ".m4a";
  if (value === "video/mp4") return ".mp4";
  if (value === "text/plain") return ".txt";
  return ".bin";
}

function safeAttachmentStem(attachmentId: string): string {
  const normalized = basename(attachmentId)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "");
  if (!normalized || normalized.length > 128) {
    throw outputError("ATTACHMENT_ID_INVALID", "The attachment id cannot be used to create a safe output filename.");
  }
  return normalized;
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && left.equals(right);
}

async function acceptExistingChunk(target: string, bytes: Buffer): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw outputError("ATTACHMENT_OUTPUT_INVALID", "The existing attachment output cannot be inspected.");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== bytes.byteLength) {
    throw outputError(
      "ATTACHMENT_OUTPUT_CONFLICT",
      "A different file already occupies this attachment output path.",
    );
  }
  const current = await readFile(target);
  if (!buffersEqual(current, bytes)) {
    throw outputError(
      "ATTACHMENT_OUTPUT_CONFLICT",
      "A different file already occupies this attachment output path.",
    );
  }
}

async function installChunkWithoutOverwrite(target: string, bytes: Buffer): Promise<void> {
  const temporary = target + "." + randomBytes(8).toString("hex") + ".part";
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        await acceptExistingChunk(target, bytes);
      } else if (code === "EPERM" || code === "EXDEV" || code === "ENOTSUP") {
        try {
          await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
        } catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
          await acceptExistingChunk(target, bytes);
        }
      } else {
        throw error;
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/*
 * Materializes exactly one bounded Core AttachmentGetResult chunk. Callers
 * request sequential offsets; neither this bridge nor the host loads a whole
 * recording into memory.
 */
export async function materializeAttachmentChunk(
  chunk: AttachmentChunk,
  attachmentId: string,
  outputDirectory: string,
): Promise<MaterializedAttachment> {
  if (typeof chunk.dataBase64 !== "string") {
    throw outputError(
      "ATTACHMENT_CONTENT_UNAVAILABLE",
      "The extension did not return inline attachment bytes for this request.",
    );
  }
  const bytes = decodedBase64(chunk.dataBase64);
  if (bytes.byteLength > MAX_ATTACHMENT_CHUNK_BYTES) {
    throw outputError(
      "ATTACHMENT_TOO_LARGE",
      "The extension returned an attachment chunk above the 512 KiB limit.",
    );
  }
  if (typeof chunk.returnedBytes !== "number" || !Number.isInteger(chunk.returnedBytes) ||
    chunk.returnedBytes < 0 || chunk.returnedBytes !== bytes.byteLength) {
    throw outputError(
      "ATTACHMENT_LENGTH_MISMATCH",
      "The attachment chunk length does not match its declared byte count.",
    );
  }
  const mimeType = typeof chunk.attachment?.mimeType === "string" ? chunk.attachment.mimeType : undefined;
  const extension = extensionForMime(mimeType);
  const offset = typeof chunk.offset === "number" && Number.isInteger(chunk.offset) && chunk.offset >= 0
    ? chunk.offset
    : 0;
  const fileName = safeAttachmentStem(attachmentId) + "-" + offset + extension;
  const target = resolve(outputDirectory, fileName);
  if (!pathInside(outputDirectory, target)) {
    throw outputError("OUTPUT_PATH_FORBIDDEN", "The attachment output path is outside the approved directory.");
  }
  await installChunkWithoutOverwrite(target, bytes);
  return { path: target, byteLength: bytes.byteLength, ...(mimeType ? { mimeType } : {}) };
}

/*
 * Job results can name externally produced artifacts. For MCP-originating
 * commits, only real regular files below this connection's output root are
 * accepted. The checks verify existence and declared size only; callers must
 * remain agent_reported for tracks/ranges/playback.
 */
export async function validateArtifactFileReferences(
  root: string | undefined,
  artifacts: readonly ArtifactFileReference[],
): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.fileReference === undefined) continue;
    if (typeof artifact.fileReference !== "string" || !isAbsolute(artifact.fileReference)) {
      throw outputError(
        "ARTIFACT_PATH_INVALID",
        "Artifact fileReference must be an absolute local path beneath the controlled output root.",
      );
    }
    const target = resolve(artifact.fileReference);
    /*
     * Artifact validation never creates a directory. Resolve the approved
     * root first, then compare the existing file's canonical path. This keeps
     * macOS system aliases such as /var -> /private/var usable while still
    * rejecting a symlinked parent that escapes a claimed Job directory.
     */
    const directory = await validateOutputDirectory(root);
    try {
      const canonicalParent = await realpath(dirname(target));
      if (!pathInside(directory, join(canonicalParent, basename(target)))) {
        throw outputError(
          "ARTIFACT_PATH_FORBIDDEN",
          "Artifact fileReference is outside the approved output directory.",
        );
      }
    } catch (error) {
      if (error instanceof ClipperBridgeError) throw error;
      /* A missing parent cannot be made during validation; lstat reports it below. */
      if (!pathInside(directory, target)) {
        throw outputError(
          "ARTIFACT_PATH_FORBIDDEN",
          "Artifact fileReference is outside the approved output directory.",
        );
      }
    }
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw outputError("ARTIFACT_FILE_MISSING", "Artifact fileReference does not exist.");
      }
      throw outputError("ARTIFACT_PATH_INVALID", "Artifact fileReference cannot be inspected.");
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw outputError("ARTIFACT_PATH_INVALID", "Artifact fileReference must name a regular local file.");
    }
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(target);
    } catch {
      throw outputError("ARTIFACT_PATH_INVALID", "Artifact fileReference cannot be resolved safely.");
    }
    if (!pathInside(directory, canonicalTarget)) {
      throw outputError(
        "ARTIFACT_PATH_FORBIDDEN",
        "Artifact fileReference is outside the approved output directory.",
      );
    }
    if (typeof artifact.byteLength === "number" && artifact.byteLength !== metadata.size) {
      throw outputError(
        "ARTIFACT_LENGTH_MISMATCH",
        "Artifact byteLength does not match the local file size.",
      );
    }
    await stat(target);
  }
}
