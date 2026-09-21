import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net, { type Socket } from "node:net";
import {
  BROKER_METHODS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  MAX_BROKER_FRAME_BYTES,
} from "./constants.js";
import type { BridgeConfig } from "./config.js";
import { ClipperBridgeError } from "./errors.js";
import { NativeMessageDecoder, encodeNativeMessage } from "./native-framing.js";
import {
  isWireEvent,
  isWireRequest,
  isWireResponse,
  parseWireMessage,
  wireRequest,
  type WireEvent,
  type WireMessage,
  type WireRequest,
} from "./wire.js";

export type BrokerClientRole = "mcp" | "native";

export interface BrokerClientOptions {
  config: BridgeConfig;
  role: BrokerClientRole;
  profileId?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

/** A framed private-socket client used by MCP processes and Native Host proxies. */
export class BrokerClient extends EventEmitter {
  private readonly decoder = new NativeMessageDecoder(MAX_BROKER_FRAME_BYTES);
  private readonly pending = new Map<string, PendingRequest>();
  private socket?: Socket;
  private closed = false;

  private constructor(private readonly options: BrokerClientOptions) {
    super();
  }

  static async connect(options: BrokerClientOptions): Promise<BrokerClient> {
    const client = new BrokerClient(options);
    await client.open();
    await client.request(BROKER_METHODS.connect, {
      role: options.role,
      secret: options.config.secret,
      ...(options.profileId === undefined ? {} : { profileId: options.profileId }),
    }, options.profileId, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    return client;
  }

  async request(method: string, params: unknown, profileId = this.options.profileId, timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS): Promise<unknown> {
    if (!this.socket || this.closed || this.socket.destroyed) {
      throw new ClipperBridgeError("BROKER_UNAVAILABLE", "The local Babel Content Clipper broker is not available.");
    }
    const id = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ClipperBridgeError("BROKER_TIMEOUT", "The local Babel Content Clipper broker did not answer before the timeout."));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.write(wireRequest(id, method, params, profileId));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      }
    }
    return response;
  }

  send(method: string, params: unknown, profileId = this.options.profileId): void {
    this.write(wireRequest(randomUUID(), method, params, profileId));
  }

  /**
   * Native Host uses this to forward an extension response/event unchanged.
   * It deliberately does not create a retry queue or store a business receipt.
   */
  sendMessage(message: WireMessage): void {
    this.write(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.rejectAll(new ClipperBridgeError("BROKER_DISCONNECTED", "The local Babel Content Clipper broker connection closed."));
  }

  private async open(): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const socket = net.createConnection(this.options.config.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ClipperBridgeError("BROKER_UNAVAILABLE", "The local Babel Content Clipper broker is not available."));
      }, timeoutMs);
      timer.unref();
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new ClipperBridgeError("BROKER_UNAVAILABLE", "The local Babel Content Clipper broker is not available."));
      });
    });
    this.socket.on("data", (chunk: Buffer) => this.onChunk(chunk));
    this.socket.on("close", () => this.onClose());
    this.socket.on("error", () => this.onClose());
  }

  private onChunk(chunk: Buffer): void {
    try {
      for (const raw of this.decoder.push(chunk)) {
        const message = parseWireMessage(raw);
        this.onMessage(message);
      }
    } catch (error) {
      this.rejectAll(error);
      this.socket?.destroy();
    }
  }

  private onMessage(message: WireMessage): void {
    if (isWireEvent(message)) {
      this.emit("event", message satisfies WireEvent);
      return;
    }
    if (isWireRequest(message)) {
      /*
       * Only a registered Native Host ever receives broker-originated
       * business requests. It forwards the exact wire request to the browser
       * extension and later uses sendMessage for its response.
       */
      if (this.options.role !== "native") {
        this.socket?.destroy();
        return;
      }
      this.emit("request", message satisfies WireRequest);
      return;
    }
    if (!isWireResponse(message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new ClipperBridgeError(message.error?.code ?? "BROKER_ERROR", message.error?.message ?? "The local broker rejected the request.", message.error?.details));
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new ClipperBridgeError("BROKER_DISCONNECTED", "The local Babel Content Clipper broker connection closed."));
    this.emit("close");
  }

  private rejectAll(error: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private write(message: WireMessage): void {
    if (!this.socket || this.closed || this.socket.destroyed) {
      throw new ClipperBridgeError("BROKER_UNAVAILABLE", "The local Babel Content Clipper broker is not available.");
    }
    this.socket.write(encodeNativeMessage(message, MAX_BROKER_FRAME_BYTES));
  }
}
