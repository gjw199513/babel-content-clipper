import { describe, expect, it } from "vitest";
import {
  fetchImageBytes,
  ImageBytesError,
} from "../../apps/extension/src/image-bytes.js";

function streamedResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = { "content-type": "image/png" },
): { response: Response; wasCancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status: 200, headers }),
    wasCancelled: () => cancelled,
  };
}

describe("bounded image byte retrieval", () => {
  it("streams an allowed image in chunks and omits browser credentials", async () => {
    const fixture = streamedResponse([new Uint8Array([1, 2]), new Uint8Array([3])]);
    let init: RequestInit | undefined;
    const result = await fetchImageBytes("https://images.example.test/cover.png", {
      maxBytes: 4,
      fetchImpl: async (_url, requestInit) => {
        init = requestInit;
        return fixture.response;
      },
    });

    expect(init).toMatchObject({ credentials: "omit" });
    expect(result).toEqual({ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
  });

  it("cancels before reading a response whose declared size exceeds the budget", async () => {
    const fixture = streamedResponse([new Uint8Array([1])], {
      "content-type": "image/png",
      "content-length": "4",
    });

    await expect(fetchImageBytes("https://images.example.test/large.png", {
      maxBytes: 3,
      fetchImpl: async () => fixture.response,
    })).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" satisfies ImageBytesError["code"] });
    expect(fixture.wasCancelled()).toBe(true);
  });

  it("cancels a streamed response as soon as the accumulated bytes cross the budget", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        setTimeout(() => controller.enqueue(new Uint8Array([3, 4])), 5);
      },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "content-type": "image/png" } });

    await expect(fetchImageBytes("https://images.example.test/streamed-large.png", {
      maxBytes: 3,
      fetchImpl: async () => response,
    })).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  it("rejects a successful HTML login page without exposing its URL", async () => {
    let cancellationObserved = false;
    const response = new Response(new ReadableStream({
      cancel() { cancellationObserved = true; },
    }), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

    await expect(fetchImageBytes("https://images.example.test/sign-in?token=not-for-logs", {
      fetchImpl: async () => response,
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof ImageBytesError &&
      error.code === "IMAGE_CONTENT_TYPE_INVALID" &&
      !error.message.includes("not-for-logs"),
    );
    expect(cancellationObserved).toBe(true);
  });

  it("allows data image URLs but rejects unsupported URL schemes", async () => {
    await expect(fetchImageBytes("data:image/png;base64,AQID", { maxBytes: 3 }))
      .resolves.toEqual({ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    await expect(fetchImageBytes("ftp://images.example.test/cover.png"))
      .rejects.toMatchObject({ code: "IMAGE_URL_FORBIDDEN" });
  });

  it("returns a timeout code for a fetch implementation that does not settle", async () => {
    await expect(fetchImageBytes("https://images.example.test/slow.png", {
      timeoutMs: 5,
      fetchImpl: async () => new Promise<Response>(() => undefined),
    })).rejects.toMatchObject({ code: "IMAGE_FETCH_TIMEOUT" });
  });

  it("rejects an empty image response", async () => {
    await expect(fetchImageBytes("https://images.example.test/empty.png", {
      fetchImpl: async () => new Response(new Uint8Array(), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    })).rejects.toMatchObject({ code: "IMAGE_EMPTY" });
  });
});
