import { randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  BRIDGE_METHODS,
  BROKER_METHODS,
  DEFAULT_RPC_TIMEOUT_MS,
  MAX_BROKER_FRAME_BYTES,
} from "./constants.js";
import type { BridgeConfig } from "./config.js";
import { prepareSocketDirectory } from "./config.js";
import { ClipperBridgeError, errorPayload } from "./errors.js";
import { NativeMessageDecoder, encodeNativeMessage } from "./native-framing.js";
import {
  assertProfileId,
  failureResponse,
  isRecord,
  isWireEvent,
  isWireRequest,
  isWireResponse,
  parseWireMessage,
  successResponse,
  type WireMessage,
  type WireRequest,
} from "./wire.js";

type PeerRole = "unauthenticated" | "mcp" | "native";

interface BrokerPeer {
  readonly socket: Socket;
  readonly decoder: NativeMessageDecoder;
  role: PeerRole;
  profileId?: string;
  mcpVersion?: string;
  closed: boolean;
}

interface PendingRelay {
  readonly relayId: string;
  readonly originalId: string;
  readonly mcpPeer: BrokerPeer;
  readonly nativePeer: BrokerPeer;
  readonly profileId: string;
  readonly timer: NodeJS.Timeout;
}

export interface BrokerServerOptions {
  config: BridgeConfig;
  requestTimeoutMs?: number;
}

export interface BrokerStatus {
  listening: boolean;
  socketPath: string;
  connectedProfiles: Array<{ profileId: string; connected: boolean }>;
  mcpClients: number;
  mcpClientVersions: string[];
  pendingRequests: number;
}

function validMcpVersion(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function secretMatches(received: unknown, expected: string): boolean {
  if (typeof received !== "string") return false;
  const actual = Buffer.from(received);
  const wanted = Buffer.from(expected);
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted);
}

function socketError(code: string, message: string): ClipperBridgeError {
  return new ClipperBridgeError(code, message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function staleStartLock(lockPath: string): Promise<boolean> {
  try {
    const [raw, metadata] = await Promise.all([readFile(lockPath, "utf8"), lstat(lockPath)]);
    let pid: unknown;
    try {
      pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    } catch {
      // A just-created lock may not yet have written its owner record.
    }
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return !processIsAlive(pid);
    return Date.now() - metadata.mtimeMs > 1_000;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Serializes Unix stale-socket recovery. Without this lock, two Native Hosts
 * can both decide an old socket is dead, and the later unlink can remove the
 * first broker's newly-bound pathname.
 */
async function acquireUnixStartLock(socketPath: string): Promise<() => Promise<void>> {
  const lockPath = join(dirname(socketPath), ".broker-start.lock");
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid }) + "\n", "utf8");
      } catch (error) {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await staleStartLock(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(20);
    }
  }
  throw socketError("BROKER_START_LOCK_TIMEOUT", "The local broker is still starting in another process.");
}

/**
 * In-memory transport broker. It persists no captures, jobs, results, receipts,
 * or attachments: the extension's IndexedDB remains the only business store.
 */
export class LocalBroker {
  private readonly server = net.createServer((socket) => this.accept(socket));
  private readonly peers = new Set<BrokerPeer>();
  private readonly profiles = new Map<string, BrokerPeer>();
  private readonly pending = new Map<string, PendingRelay>();
  private started = false;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: BrokerServerOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await prepareSocketDirectory(this.options.config);
    const releaseStartLock = this.isNamedPipe()
      ? undefined
      : await acquireUnixStartLock(this.options.config.socketPath);
    try {
      try {
        await this.listen();
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "EADDRINUSE" || this.isNamedPipe()) throw error;
        const active = await isSocketReachable(this.options.config.socketPath);
        if (active) throw socketError("BROKER_ALREADY_RUNNING", "A Babel Content Clipper broker is already using this private endpoint.");
        await unlink(this.options.config.socketPath).catch(() => undefined);
        await this.listen();
      }
      this.started = true;
    } finally {
      await releaseStartLock?.();
    }
  }

  async close(): Promise<void> {
    for (const peer of [...this.peers]) peer.socket.destroy();
    for (const relay of this.pending.values()) clearTimeout(relay.timer);
    this.pending.clear();
    this.profiles.clear();
    if (this.started) {
      await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    }
    this.started = false;
    if (!this.isNamedPipe()) await unlink(this.options.config.socketPath).catch(() => undefined);
  }

  status(): BrokerStatus {
    return {
      listening: this.started,
      socketPath: this.options.config.socketPath,
      connectedProfiles: [...this.profiles.entries()].map(([profileId, peer]) => ({ profileId, connected: !peer.closed })),
      mcpClients: [...this.peers].filter((peer) => peer.role === "mcp" && !peer.closed).length,
      mcpClientVersions: [...this.peers]
        .filter((peer) => peer.role === "mcp" && !peer.closed && peer.mcpVersion !== undefined)
        .map((peer) => peer.mcpVersion!),
      pendingRequests: this.pending.size,
    };
  }

  private isNamedPipe(): boolean {
    return process.platform === "win32" || this.options.config.socketPath.startsWith("\\\\.\\pipe\\");
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.config.socketPath);
    });
  }

  private accept(socket: Socket): void {
    const peer: BrokerPeer = {
      socket,
      decoder: new NativeMessageDecoder(MAX_BROKER_FRAME_BYTES),
      role: "unauthenticated",
      closed: false,
    };
    this.peers.add(peer);
    socket.on("data", (chunk: Buffer) => this.handleChunk(peer, chunk));
    socket.on("error", () => this.disconnect(peer));
    socket.on("close", () => this.disconnect(peer));
  }

  private handleChunk(peer: BrokerPeer, chunk: Buffer): void {
    let values: unknown[];
    try {
      values = peer.decoder.push(chunk);
    } catch (error) {
      this.send(peer, failureResponse("invalid-frame", error));
      peer.socket.destroy();
      return;
    }
    for (const value of values) this.handleValue(peer, value);
  }

  private handleValue(peer: BrokerPeer, value: unknown): void {
    let message: WireMessage;
    try {
      message = parseWireMessage(value);
    } catch (error) {
      const maybeId = isRecord(value) && typeof value.id === "string" ? value.id : "invalid-message";
      this.send(peer, failureResponse(maybeId, error));
      return;
    }

    if (peer.role === "unauthenticated") {
      if (!isWireRequest(message) || message.method !== BROKER_METHODS.connect) {
        if (isWireRequest(message)) this.send(peer, failureResponse(message.id, socketError("AUTH_REQUIRED", "Connect to the local broker before sending bridge requests.")));
        peer.socket.destroy();
        return;
      }
      this.authenticate(peer, message);
      return;
    }

    if (peer.role === "mcp") {
      if (!isWireRequest(message)) {
        peer.socket.destroy();
        return;
      }
      this.handleMcpRequest(peer, message);
      return;
    }

    this.handleNativeMessage(peer, message);
  }

  private authenticate(peer: BrokerPeer, request: WireRequest): void {
    try {
      if (!isRecord(request.params)) throw socketError("INVALID_REQUEST", "broker.connect requires an object params field.");
      const role = request.params.role;
      if ((role !== "mcp" && role !== "native") || !secretMatches(request.params.secret, this.options.config.secret)) {
        throw socketError("BROKER_AUTH_FAILED", "The local broker rejected this connection.");
      }
      if (role === "mcp") {
        const profileId = assertProfileId(request.profileId ?? request.params.profileId);
        const mcpVersion = request.params.mcp_version;
        if (!validMcpVersion(mcpVersion)) throw socketError("MCP_VERSION_REQUIRED", "An MCP client must identify its package version.");
        peer.role = "mcp";
        peer.profileId = profileId;
        peer.mcpVersion = mcpVersion;
        this.send(peer, successResponse(request.id, { connected: true, role, profileId, mcp_version: mcpVersion }, profileId));
        return;
      }
      if (request.profileId !== undefined) throw socketError("INVALID_REQUEST", "A native host establishes its profile through bridge.hello.");
      peer.role = "native";
      this.send(peer, successResponse(request.id, { connected: true, role }));
    } catch (error) {
      this.send(peer, failureResponse(request.id, error));
      peer.socket.destroy();
    }
  }

  private handleMcpRequest(peer: BrokerPeer, request: WireRequest): void {
    const profileId = peer.profileId;
    if (!profileId) {
      this.send(peer, failureResponse(request.id, socketError("PROFILE_REQUIRED", "This MCP connection has no configured browser profile.")));
      return;
    }
    if (request.profileId !== undefined && request.profileId !== profileId) {
      this.send(peer, failureResponse(request.id, socketError("PROFILE_ROUTE_FORBIDDEN", "An MCP process may only access its configured browser profile."), profileId));
      return;
    }
    if (request.method === BROKER_METHODS.status) {
      const profile = this.profiles.get(profileId);
      this.send(peer, successResponse(request.id, {
        ...this.status(),
        profileId,
        browserConnected: Boolean(profile && !profile.closed),
      }, profileId));
      return;
    }
    if (request.method === BROKER_METHODS.connect || request.method === BRIDGE_METHODS.hello) {
      this.send(peer, failureResponse(request.id, socketError("METHOD_FORBIDDEN", "This bridge method is not available to MCP clients."), profileId));
      return;
    }

    const nativePeer = this.profiles.get(profileId);
    if (!nativePeer || nativePeer.closed) {
      this.send(peer, failureResponse(request.id, socketError("BROWSER_UNAVAILABLE", "The selected browser profile is not connected to the Babel Content Clipper extension."), profileId));
      return;
    }
    const relayId = randomUUID();
    const timer = setTimeout(() => {
      const relay = this.pending.get(relayId);
      if (!relay) return;
      this.pending.delete(relayId);
      this.send(relay.mcpPeer, failureResponse(relay.originalId, socketError("BROWSER_TIMEOUT", "The connected browser profile did not answer before the local bridge timeout."), relay.profileId));
    }, this.requestTimeoutMs);
    timer.unref();
    const relay: PendingRelay = { relayId, originalId: request.id, mcpPeer: peer, nativePeer, profileId, timer };
    this.pending.set(relayId, relay);
    try {
      this.send(nativePeer, {
        v: 1,
        id: relayId,
        method: request.method,
        params: request.params,
        profileId,
      });
    } catch (error) {
      this.finishRelay(relayId, failureResponse(request.id, socketError("BROWSER_UNAVAILABLE", "The selected browser profile disconnected before it received this request."), profileId));
    }
  }

  private handleNativeMessage(peer: BrokerPeer, message: WireMessage): void {
    if (isWireRequest(message) && message.method === BRIDGE_METHODS.hello) {
      this.registerProfile(peer, message);
      return;
    }
    if (isWireResponse(message)) {
      const relay = this.pending.get(message.id);
      if (!relay || relay.nativePeer !== peer) return; // Late/unknown replies are never replayed.
      if (message.profileId !== undefined && message.profileId !== relay.profileId) {
        this.finishRelay(message.id, failureResponse(relay.originalId, socketError("PROFILE_MISMATCH", "The browser returned a response for the wrong profile."), relay.profileId));
        return;
      }
      const response = message.ok
        ? successResponse(relay.originalId, message.result, relay.profileId)
        : failureResponse(relay.originalId, message.error ?? socketError("BROWSER_ERROR", "The browser extension rejected this request."), relay.profileId);
      this.finishRelay(message.id, response);
      return;
    }
    if (isWireEvent(message)) {
      if (this.profiles.get(message.profileId) !== peer) return;
      for (const target of this.peers) {
        if (target.role === "mcp" && target.profileId === message.profileId && !target.closed) this.send(target, message);
      }
      return;
    }
    if (isWireRequest(message)) {
      this.send(peer, failureResponse(message.id, socketError("METHOD_FORBIDDEN", "The native host may only register a profile or reply to broker requests."), message.profileId));
      return;
    }
    peer.socket.destroy();
  }

  private registerProfile(peer: BrokerPeer, request: WireRequest): void {
    try {
      const profileId = assertProfileId(request.profileId ?? (isRecord(request.params) ? request.params.profileId : undefined));
      if (peer.profileId !== undefined && peer.profileId !== profileId) {
        throw socketError(
          "PROFILE_ROUTE_FORBIDDEN",
          "A Native Host connection may only register one browser profile.",
        );
      }
      const previous = this.profiles.get(profileId);
      if (previous && previous !== peer) {
        this.profiles.delete(profileId);
        this.rejectProfilePending(profileId, "BROWSER_RECONNECTED", "The browser profile reconnected before an earlier request completed.");
        previous.socket.destroy();
      }
      peer.profileId = profileId;
      this.profiles.set(profileId, peer);
      this.send(peer, successResponse(request.id, { connected: true, profileId }, profileId));
    } catch (error) {
      this.send(peer, failureResponse(request.id, error));
    }
  }

  private finishRelay(relayId: string, response: ReturnType<typeof successResponse> | ReturnType<typeof failureResponse>): void {
    const relay = this.pending.get(relayId);
    if (!relay) return;
    this.pending.delete(relayId);
    clearTimeout(relay.timer);
    if (!relay.mcpPeer.closed) this.send(relay.mcpPeer, response);
  }

  private rejectProfilePending(profileId: string, code: string, message: string): void {
    for (const [relayId, relay] of this.pending) {
      if (relay.profileId !== profileId) continue;
      this.finishRelay(relayId, failureResponse(relay.originalId, socketError(code, message), profileId));
    }
  }

  private disconnect(peer: BrokerPeer): void {
    if (peer.closed) return;
    peer.closed = true;
    this.peers.delete(peer);
    if (peer.role === "native" && peer.profileId && this.profiles.get(peer.profileId) === peer) {
      this.profiles.delete(peer.profileId);
      // Never retain or replay a claim/commit after browser loss. The extension
      // can still finish its own IndexedDB transaction, but the caller receives
      // a typed lack-of-ack outcome and must inspect state on a later query.
      this.rejectProfilePending(peer.profileId, "BROWSER_UNAVAILABLE", "The browser profile disconnected before the extension transaction acknowledged this request.");
    }
    if (peer.role === "mcp") {
      for (const [relayId, relay] of this.pending) {
        if (relay.mcpPeer !== peer) continue;
        clearTimeout(relay.timer);
        this.pending.delete(relayId);
      }
    }
  }

  private send(peer: BrokerPeer, message: WireMessage): void {
    if (peer.closed || peer.socket.destroyed) return;
    const frame = encodeNativeMessage(message, MAX_BROKER_FRAME_BYTES);
    const accepted = peer.socket.write(frame);
    if (!accepted) peer.socket.once("drain", () => undefined);
  }
}

async function isSocketReachable(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path);
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function startLocalBroker(options: BrokerServerOptions): Promise<LocalBroker> {
  const broker = new LocalBroker(options);
  await broker.start();
  return broker;
}

export function brokerErrorPayload(error: unknown): { code: string; message: string; details?: unknown } {
  return errorPayload(error);
}
