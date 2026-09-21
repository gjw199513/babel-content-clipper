import { createHash, randomUUID } from "node:crypto";
import { open, link, lstat, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { MAX_ATTACHMENT_CHUNK_BYTES } from "./constants.js";
import { ClipperBridgeError } from "./errors.js";
import { validateOutputDirectory } from "./safe-output.js";
import { isRecord } from "./wire.js";

type BridgeRequest = (method: string, params: unknown) => Promise<unknown>;

interface ExportedFile {
  readonly relativePath: string;
  readonly path: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly reused: boolean;
}

interface MissingAttachment {
  readonly attachmentId: string;
  readonly reason: string;
  readonly fileReference?: string;
}

export interface CaptureExportResult {
  readonly captureId: string;
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly files: readonly ExportedFile[];
  readonly missingAttachments: readonly MissingAttachment[];
  readonly complete: boolean;
}

function captureDirectoryName(captureId: string): string {
  const normalized = basename(captureId).replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "");
  if (!normalized || normalized.length > 256) {
    throw new ClipperBridgeError("CAPTURE_EXPORT_PATH_INVALID", "The capture id cannot be used as a local export directory.");
  }
  return normalized;
}

function extensionForMime(mimeType: unknown): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "audio/mpeg") return ".mp3";
  if (mimeType === "audio/mp4") return ".m4a";
  if (mimeType === "video/mp4") return ".mp4";
  if (mimeType === "video/webm") return ".webm";
  if (mimeType === "text/plain") return ".txt";
  return ".bin";
}

function attachmentFileName(attachmentId: string, mimeType: unknown): string {
  const stem = basename(attachmentId).replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "");
  if (!stem || stem.length > 128) {
    throw new ClipperBridgeError("ATTACHMENT_ID_INVALID", "The attachment id cannot be used as a local export filename.");
  }
  return `${stem}${extensionForMime(mimeType)}`;
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ClipperBridgeError("ATTACHMENT_ENCODING_INVALID", "The extension returned invalid base64 attachment bytes.");
  }
  return Buffer.from(value, "base64");
}

async function hashFile(path: string): Promise<{ byteLength: number; sha256: string }> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ClipperBridgeError("CAPTURE_EXPORT_CONFLICT", "A non-file already occupies the local export path.");
  }
  const hash = createHash("sha256");
  const bytes = await readFile(path);
  hash.update(bytes);
  return { byteLength: bytes.byteLength, sha256: hash.digest("hex") };
}

async function installBytesWithoutOverwrite(
  path: string,
  bytes: Buffer,
  mimeType: string,
  relativePath: string,
): Promise<ExportedFile> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    const existing = await hashFile(path);
    if (existing.byteLength !== bytes.byteLength || existing.sha256 !== sha256) {
      throw new ClipperBridgeError("CAPTURE_EXPORT_CONFLICT", `A different local file already occupies ${relativePath}.`);
    }
    return { relativePath, path, mimeType, byteLength: existing.byteLength, sha256, reused: true };
  } catch (error) {
    if (error instanceof ClipperBridgeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = `${path}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await hashFile(path);
      if (existing.byteLength !== bytes.byteLength || existing.sha256 !== sha256) {
        throw new ClipperBridgeError("CAPTURE_EXPORT_CONFLICT", `A different local file already occupies ${relativePath}.`);
      }
      return { relativePath, path, mimeType, byteLength: existing.byteLength, sha256, reused: true };
    }
    return { relativePath, path, mimeType, byteLength: bytes.byteLength, sha256, reused: false };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function installAttachmentWithoutOverwrite(
  request: BridgeRequest,
  attachmentId: string,
  totalBytes: number,
  mimeType: string,
  path: string,
  relativePath: string,
): Promise<ExportedFile> {
  try {
    const existing = await hashFile(path);
    if (existing.byteLength !== totalBytes) {
      throw new ClipperBridgeError("CAPTURE_EXPORT_CONFLICT", `A different local file already occupies ${relativePath}.`);
    }
    return {
      relativePath,
      path,
      mimeType,
      byteLength: existing.byteLength,
      sha256: existing.sha256,
      reused: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = `${path}.${randomUUID()}.part`;
  const output = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  let offset = 0;
  try {
    while (offset < totalBytes) {
      const chunkValue = await request("attachment.get", {
        attachmentId,
        offset,
        maxBytes: MAX_ATTACHMENT_CHUNK_BYTES,
        encoding: "base64",
      });
      if (!isRecord(chunkValue)) {
        throw new ClipperBridgeError("ATTACHMENT_EXPORT_INVALID", "The extension returned an invalid attachment chunk.");
      }
      if (chunkValue.offset !== offset || typeof chunkValue.returnedBytes !== "number" ||
        chunkValue.returnedBytes < 0 || typeof chunkValue.totalBytes !== "number" ||
        chunkValue.totalBytes !== totalBytes) {
        throw new ClipperBridgeError("ATTACHMENT_EXPORT_INVALID", "The attachment chunk offsets do not match the persisted attachment.");
      }
      const bytes = decodeBase64(chunkValue.dataBase64);
      if (bytes.byteLength !== chunkValue.returnedBytes || bytes.byteLength === 0 || offset + bytes.byteLength > totalBytes) {
        throw new ClipperBridgeError("ATTACHMENT_EXPORT_INVALID", "The attachment chunk length is invalid.");
      }
      await output.write(bytes);
      hash.update(bytes);
      offset += bytes.byteLength;
      if (chunkValue.eof !== true && offset >= totalBytes) {
        throw new ClipperBridgeError("ATTACHMENT_EXPORT_INVALID", "The attachment did not mark its final chunk.");
      }
      if (chunkValue.eof === true && offset < totalBytes) {
        throw new ClipperBridgeError("ATTACHMENT_EXPORT_INCOMPLETE", "The attachment ended before all persisted bytes were exported.");
      }
    }
    await output.sync();
    await output.close();
    const sha256 = hash.digest("hex");
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await hashFile(path);
      if (existing.byteLength !== totalBytes || existing.sha256 !== sha256) {
        throw new ClipperBridgeError("CAPTURE_EXPORT_CONFLICT", `A different local file already occupies ${relativePath}.`);
      }
      return { relativePath, path, mimeType, byteLength: existing.byteLength, sha256, reused: true };
    }
    return { relativePath, path, mimeType, byteLength: totalBytes, sha256, reused: false };
  } finally {
    await output.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function textSelection(capture: Record<string, unknown>): string | undefined {
  const selection = isRecord(capture.selection) ? capture.selection : undefined;
  if (!selection) return undefined;
  if (selection.type === "text" && typeof selection.exact === "string") return selection.exact;
  if (selection.type === "clipboard" && typeof selection.text === "string") return selection.text;
  return undefined;
}

export async function exportCaptureBundle(options: {
  readonly request: BridgeRequest;
  readonly captureId: string;
  readonly outputRoot: string;
  readonly includeAttachmentBytes: boolean;
}): Promise<CaptureExportResult> {
  const detailValue = await options.request("capture.get", { captureId: options.captureId });
  if (!isRecord(detailValue) || !isRecord(detailValue.capture)) {
    throw new ClipperBridgeError("CAPTURE_EXPORT_INVALID", "The extension returned an invalid capture detail.");
  }
  const capture = detailValue.capture;
  const captureDirectory = await validateOutputDirectory(
    options.outputRoot,
    join(options.outputRoot, "captures", captureDirectoryName(options.captureId)),
  );
  const attachmentsDirectory = await validateOutputDirectory(
    captureDirectory,
    join(captureDirectory, "attachments"),
  );
  const files: ExportedFile[] = [];
  const text = textSelection(capture);
  if (text !== undefined) {
    files.push(await installBytesWithoutOverwrite(
      join(captureDirectory, "selected-text.txt"),
      Buffer.from(text, "utf8"),
      "text/plain; charset=utf-8",
      "selected-text.txt",
    ));
  }
  const selection = isRecord(capture.selection) ? capture.selection : undefined;
  if (typeof selection?.sanitizedHtml === "string") {
    files.push(await installBytesWithoutOverwrite(
      join(captureDirectory, "selected.html"),
      Buffer.from(selection.sanitizedHtml, "utf8"),
      "text/html; charset=utf-8",
      "selected.html",
    ));
  }
  files.push(await installBytesWithoutOverwrite(
    join(captureDirectory, "capture.json"),
    jsonBytes(detailValue),
    "application/json",
    "capture.json",
  ));
  files.push(await installBytesWithoutOverwrite(
    join(captureDirectory, "source.json"),
    jsonBytes(capture.source ?? {}),
    "application/json",
    "source.json",
  ));
  const missingAttachments: MissingAttachment[] = [];
  const attachments = Array.isArray(detailValue.attachments) ? detailValue.attachments.filter(isRecord) : [];
  for (const attachment of attachments) {
    const attachmentId = typeof attachment.attachmentId === "string" ? attachment.attachmentId : undefined;
    if (!attachmentId) continue;
    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType : "application/octet-stream";
    const byteLength = typeof attachment.byteLength === "number" && Number.isInteger(attachment.byteLength) && attachment.byteLength >= 0
      ? attachment.byteLength
      : undefined;
    if (!options.includeAttachmentBytes || attachment.dataAvailable !== true || byteLength === undefined) {
      missingAttachments.push({
        attachmentId,
        reason: !options.includeAttachmentBytes
          ? "attachment_bytes_not_requested"
          : attachment.dataAvailable !== true
            ? "attachment_bytes_unavailable"
            : "attachment_byte_length_invalid",
        ...(typeof attachment.fileReference === "string" ? { fileReference: attachment.fileReference } : {}),
      });
      continue;
    }
    const relativePath = `attachments/${attachmentFileName(attachmentId, mimeType)}`;
    files.push(await installAttachmentWithoutOverwrite(
      options.request,
      attachmentId,
      byteLength,
      mimeType,
      join(attachmentsDirectory, attachmentFileName(attachmentId, mimeType)),
      relativePath,
    ));
  }
  const manifest = {
    schemaVersion: 1,
    captureId: options.captureId,
    contentPolicy: "public capture detail plus locally materialized attachment bytes; private acquisition URLs and cookies are excluded",
    files: files.map(({ relativePath, mimeType, byteLength, sha256 }) => ({ relativePath, mimeType, byteLength, sha256 })),
    missingAttachments,
    complete: missingAttachments.length === 0,
  };
  const manifestFile = await installBytesWithoutOverwrite(
    join(captureDirectory, "manifest.json"),
    jsonBytes(manifest),
    "application/json",
    "manifest.json",
  );
  files.push(manifestFile);
  return {
    captureId: options.captureId,
    outputDirectory: captureDirectory,
    manifestPath: manifestFile.path,
    files,
    missingAttachments,
    complete: missingAttachments.length === 0,
  };
}
