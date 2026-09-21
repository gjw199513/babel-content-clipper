export const DEFAULT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_IMAGE_TIMEOUT_MS = 10_000;

export type ImageBytesErrorCode =
  | "IMAGE_OPTIONS_INVALID"
  | "IMAGE_URL_INVALID"
  | "IMAGE_URL_FORBIDDEN"
  | "IMAGE_FETCH_FAILED"
  | "IMAGE_FETCH_TIMEOUT"
  | "IMAGE_HTTP_STATUS"
  | "IMAGE_CONTENT_TYPE_INVALID"
  | "IMAGE_STREAM_UNAVAILABLE"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_EMPTY";

/** A safe, diagnosable failure that deliberately omits the requested URL. */
export class ImageBytesError extends Error {
  readonly code: ImageBytesErrorCode;

  constructor(code: ImageBytesErrorCode, message: string) {
    super(message);
    this.name = "ImageBytesError";
    this.code = code;
  }
}

export interface FetchImageBytesOptions {
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ImageBytes {
  mimeType: string;
  bytes: Uint8Array;
}

function checkedLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 1_073_741_824) {
    throw new ImageBytesError("IMAGE_OPTIONS_INVALID", `${name} must be a whole number between 1 and 1073741824.`);
  }
  return resolved;
}

function checkedUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ImageBytesError("IMAGE_URL_INVALID", "The image URL is invalid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "data:") {
    throw new ImageBytesError("IMAGE_URL_FORBIDDEN", "The image URL must use http, https, or data.");
  }
  if (parsed.username || parsed.password) {
    throw new ImageBytesError("IMAGE_URL_FORBIDDEN", "The image URL must not contain embedded credentials.");
  }
  return parsed;
}

function imageMimeType(response: Response): string {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!/^image\/[a-z0-9!#$&^_.+-]+$/iu.test(value)) {
    throw new ImageBytesError(
      "IMAGE_CONTENT_TYPE_INVALID",
      "The response did not declare an image content type.",
    );
  }
  return value;
}

function contentLengthAboveLimit(response: Response, maxBytes: number): boolean {
  const header = response.headers.get("content-length");
  if (header === null || !/^\d+$/u.test(header.trim())) return false;
  const length = Number(header);
  return Number.isSafeInteger(length) && length > maxBytes;
}

async function cancel(reader: ReadableStreamDefaultReader<Uint8Array> | undefined): Promise<void> {
  await reader?.cancel().catch(() => undefined);
}

/**
 * Fetch a remote or data-URL image without attaching browser credentials or
 * materializing the response as one Blob/ArrayBuffer before enforcing a limit.
 */
export async function fetchImageBytes(
  url: string,
  options: FetchImageBytesOptions = {},
): Promise<ImageBytes> {
  const maxBytes = checkedLimit(options.maxBytes, DEFAULT_IMAGE_MAX_BYTES, "maxBytes");
  const timeoutMs = checkedLimit(options.timeoutMs, DEFAULT_IMAGE_TIMEOUT_MS, "timeoutMs");
  checkedUrl(url);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ImageBytesError("IMAGE_FETCH_FAILED", "No fetch implementation is available for image retrieval.");
  }

  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      void cancel(reader);
      reject(new ImageBytesError("IMAGE_FETCH_TIMEOUT", "Image retrieval timed out."));
    }, timeoutMs);
  });

  const download = async (): Promise<ImageBytes> => {
    let response: Response;
    try {
      response = await fetchImpl(url, { credentials: "omit", signal: controller.signal });
    } catch (error) {
      if (error instanceof ImageBytesError) throw error;
      if (timedOut || controller.signal.aborted) {
        throw new ImageBytesError("IMAGE_FETCH_TIMEOUT", "Image retrieval timed out.");
      }
      throw new ImageBytesError("IMAGE_FETCH_FAILED", "The image request could not be completed.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ImageBytesError("IMAGE_HTTP_STATUS", "The image request returned a non-success HTTP status.");
    }
    let mimeType: string;
    try {
      mimeType = imageMimeType(response);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (contentLengthAboveLimit(response, maxBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ImageBytesError("IMAGE_TOO_LARGE", "The declared image size exceeds the configured byte limit.");
    }
    if (response.body === null) {
      throw new ImageBytesError("IMAGE_STREAM_UNAVAILABLE", "The image response body is not readable as a stream.");
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        if (chunk.byteLength === 0) continue;
        if (chunk.byteLength > maxBytes - total) {
          await cancel(reader);
          throw new ImageBytesError("IMAGE_TOO_LARGE", "The image exceeds the configured byte limit.");
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    } finally {
      reader.releaseLock();
      reader = undefined;
    }
    if (total === 0) {
      throw new ImageBytesError("IMAGE_EMPTY", "The image response did not contain any bytes.");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { mimeType, bytes };
  };

  try {
    return await Promise.race([download(), timeoutFailure]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
