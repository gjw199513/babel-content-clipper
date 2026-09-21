import { EXTENSION_CHANNEL, isNativeMethod, type NativeMethod } from "./messages.js";
import { serializeClipperError } from "../../../packages/core/src/errors.js";

export interface WireRequest { v: 1; id: string; method: NativeMethod; params?: unknown; profileId?: string }
export interface WireResponse { v: 1; id: string; ok: boolean; result?: unknown; error?: { code: string; message: string; details?: unknown } }
export interface WireEvent { v: 1; event: string; profileId?: string; payload?: unknown }
type Frame = WireRequest | WireResponse | WireEvent;

const HOST_NAME = "com.babel.content_clipper";
const MAX_FRAME_BYTES = 1 * 1024 * 1024;

function frameBytes(frame: unknown): number { return new TextEncoder().encode(JSON.stringify(frame)).byteLength; }

export class NativeBridge {
  private port?: chrome.runtime.Port;
  private connecting?: Promise<void>;
  private handshaken = false;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private eventListener?: (event: WireEvent) => void;
  private lastError?: { code: string; message: string };

  constructor(private readonly profileId: () => string, private readonly dispatch: (method: NativeMethod, params: unknown, profileId: string) => Promise<unknown>) {}

  onEvent(listener: (event: WireEvent) => void): void { this.eventListener = listener; }

  status(): { connected: boolean; host: string; profileId: string; error?: { code: string; message: string } } {
    return { connected: !!this.port && this.handshaken, host: HOST_NAME, profileId: this.profileId(), ...(this.lastError ? { error: this.lastError } : {}) };
  }

  async connect(): Promise<void> {
    if (this.port && this.handshaken) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let port: chrome.runtime.Port;
      try { port = chrome.runtime.connectNative(HOST_NAME); } catch (error) {
        this.lastError = { code: "BROWSER_UNAVAILABLE", message: error instanceof Error ? error.message : "Native Messaging 不可用。" };
        throw error;
      }
      this.port = port;
      this.handshaken = false;
      this.lastError = undefined;
      port.onMessage.addListener(message => { void this.handle(message as Frame); });
      port.onDisconnect.addListener(() => {
        const message = chrome.runtime.lastError?.message ?? "Native Messaging 主机已断开。";
        this.lastError = { code: "BROWSER_UNAVAILABLE", message };
        this.port = undefined;
        this.handshaken = false;
        for (const request of this.pending.values()) request.reject(new Error(message));
        this.pending.clear();
      });
      const id = crypto.randomUUID();
      const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
      try {
        const hello: WireRequest = { v: 1, id, method: "bridge.hello", params: { channel: EXTENSION_CHANNEL }, profileId: this.profileId() };
        if (frameBytes(hello) > MAX_FRAME_BYTES) throw new Error("Native hello exceeds the bounded frame size.");
        port.postMessage(hello);
        await Promise.race([response, new Promise<never>((_, reject) => globalThis.setTimeout(() => reject(new Error("Native bridge hello timed out.")), 5_000))]);
        this.handshaken = true;
      } catch (error) {
        this.pending.delete(id);
        this.handshaken = false;
        this.port?.disconnect();
        this.port = undefined;
        this.lastError = { code: "BROWSER_UNAVAILABLE", message: error instanceof Error ? error.message : "Native bridge hello failed." };
        throw error;
      }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  disconnect(): void { this.port?.disconnect(); this.port = undefined; this.handshaken = false; }

  notify(event: string, payload?: unknown): void {
    if (!this.port || !this.handshaken) return;
    const frame: WireEvent = { v: 1, event, profileId: this.profileId(), ...(payload === undefined ? {} : { payload }) };
    if (frameBytes(frame) <= MAX_FRAME_BYTES) this.port.postMessage(frame);
  }

  async request(method: NativeMethod, params?: unknown): Promise<unknown> {
    await this.connect();
    if (!this.port) throw new Error("BROWSER_UNAVAILABLE");
    const id = crypto.randomUUID();
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const request: WireRequest = { v: 1, id, method, params, profileId: this.profileId() };
    if (frameBytes(request) > MAX_FRAME_BYTES) { this.pending.delete(id); throw new Error("REQUEST_TOO_LARGE: Native bridge request exceeds the bounded frame size."); }
    try { this.port.postMessage(request); } catch (error) { this.pending.delete(id); throw error; }
    return response;
  }

  private async handle(frame: Frame): Promise<void> {
    if (!frame || typeof frame !== "object" || frame.v !== 1) return;
    if (frameBytes(frame) > MAX_FRAME_BYTES) { this.lastError = { code: "RESPONSE_TOO_LARGE", message: "Native bridge frame exceeds the bounded frame size." }; return; }
    if ("event" in frame && typeof frame.event === "string") {
      this.eventListener?.(frame);
      return;
    }
    if ("ok" in frame && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.result);
      else { const error = frame.error; const failure = new Error(error?.message ?? "Native bridge request failed."); Object.assign(failure, error); pending.reject(failure); }
      return;
    }
    if (!("method" in frame) || typeof frame.id !== "string" || !isNativeMethod(frame.method)) return;
    const profileId = frame.profileId ?? this.profileId();
    const response: WireResponse = { v: 1, id: frame.id, ok: false };
    try {
      if (profileId !== this.profileId()) throw Object.assign(new Error("Native request profile does not match this extension profile."), { code: "PROFILE_MISMATCH" });
      const result = await this.dispatch(frame.method, frame.params, profileId);
      response.ok = true;
      response.result = result;
    } catch (error) {
      response.error = serializeClipperError(error);
    }
    if (frameBytes(response) > MAX_FRAME_BYTES) {
      response.ok = false;
      delete response.result;
      response.error = { code: "RESPONSE_TOO_LARGE", message: "Native bridge response exceeds the bounded frame size." };
    }
    this.port?.postMessage(response);
  }
}
