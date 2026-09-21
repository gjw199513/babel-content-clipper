import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerClient } from "../../packages/mcp/src/broker-client.js";
import { LocalBroker, startLocalBroker } from "../../packages/mcp/src/broker.js";
import type { BridgeConfig } from "../../packages/mcp/src/config.js";
import { successResponse, type WireRequest } from "../../packages/mcp/src/wire.js";

const brokers: LocalBroker[] = [];
const clients: BrokerClient[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function bridgeConfig(): Promise<BridgeConfig> {
  const directory = await mkdtemp(join(tmpdir(), "babel-clipper-broker-"));
  directories.push(directory);
  return {
    v: 1,
    hostName: "com.babel.content_clipper",
    socketPath: join(directory, "broker.sock"),
    secret: "a".repeat(43),
  };
}

async function connected(config: BridgeConfig, role: "mcp" | "native", profileId?: string): Promise<BrokerClient> {
  const client = await BrokerClient.connect({ config, role, ...(profileId === undefined ? {} : { profileId }) });
  clients.push(client);
  return client;
}

async function registerNative(config: BridgeConfig, profileId: string, label: string): Promise<BrokerClient> {
  const native = await connected(config, "native");
  await native.request("bridge.hello", { channel: "extension" }, profileId);
  native.on("request", (request: WireRequest) => {
    native.sendMessage(successResponse(request.id, { servedBy: label, method: request.method }, profileId));
  });
  return native;
}

describe("private local broker", () => {
  it("routes concurrent MCP clients only to their bound profile", async () => {
    const config = await bridgeConfig();
    const broker = await startLocalBroker({ config, requestTimeoutMs: 200 });
    brokers.push(broker);
    const alphaNative = await registerNative(config, "profile-alpha", "alpha");
    await registerNative(config, "profile-beta", "beta");
    const alphaOne = await connected(config, "mcp", "profile-alpha");
    const alphaTwo = await connected(config, "mcp", "profile-alpha");
    const beta = await connected(config, "mcp", "profile-beta");
    expect(broker.status().mcpClientVersions).toHaveLength(3);

    const [one, two, three] = await Promise.all([
      alphaOne.request("capture.list", { view: "pending" }),
      alphaTwo.request("connection.status", {}),
      beta.request("capture.get", { captureId: "capture-beta" }),
    ]);
    expect(one).toMatchObject({ servedBy: "alpha", method: "capture.list" });
    expect(two).toMatchObject({ servedBy: "alpha", method: "connection.status" });
    expect(three).toMatchObject({ servedBy: "beta", method: "capture.get" });
    await expect(alphaNative.request("bridge.hello", { channel: "extension" }, "profile-beta"))
      .rejects.toMatchObject({ code: "PROFILE_ROUTE_FORBIDDEN" });
    await expect(alphaOne.request("capture.list", {}, "profile-beta"))
      .rejects.toMatchObject({ code: "PROFILE_ROUTE_FORBIDDEN" });
  });

  it("returns typed offline and timeout failures without replaying a request", async () => {
    const config = await bridgeConfig();
    const broker = await startLocalBroker({ config, requestTimeoutMs: 25 });
    brokers.push(broker);
    const native = await registerNative(config, "profile-offline", "online");
    const mcp = await connected(config, "mcp", "profile-offline");
    native.close();
    await expect(mcp.request("job.claim", { requestId: "once" }))
      .rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });

    const slow = await connected(config, "native");
    await slow.request("bridge.hello", { channel: "extension" }, "profile-offline");
    let delivered = 0;
    slow.on("request", () => {
      delivered += 1;
    });
    await expect(mcp.request("job.claim", { requestId: "no-replay" }))
      .rejects.toMatchObject({ code: "BROWSER_TIMEOUT" });
    expect(delivered).toBe(1);
  });

  it("preserves a typed extension error after it has crossed JSON transport", async () => {
    const config = await bridgeConfig();
    const broker = await startLocalBroker({ config, requestTimeoutMs: 200 });
    brokers.push(broker);
    const native = await connected(config, "native");
    await native.request("bridge.hello", { channel: "extension" }, "profile-conflict");
    native.on("request", (request: WireRequest) => {
      /* Native Messaging deserializes this as a plain object before relay. */
      native.sendMessage({
        v: 1,
        id: request.id,
        ok: false,
        error: {
          code: "RESULT_CONFLICT",
          message: "A different terminal result is already stored for this job",
          details: { resultId: "result-existing" },
        },
        profileId: "profile-conflict",
      });
    });
    const mcp = await connected(config, "mcp", "profile-conflict");

    await expect(mcp.request("job.complete", { requestId: "conflict" }))
      .rejects.toMatchObject({
        code: "RESULT_CONFLICT",
        message: "A different terminal result is already stored for this job",
        details: { resultId: "result-existing" },
      });
  });

  it("rejects a bad broker secret before a client can route a business request", async () => {
    const config = await bridgeConfig();
    const broker = await startLocalBroker({ config });
    brokers.push(broker);
    await expect(BrokerClient.connect({
      config: { ...config, secret: "b".repeat(43) },
      role: "mcp",
      profileId: "profile-alpha",
    })).rejects.toMatchObject({ code: "BROKER_AUTH_FAILED" });
  });

  it("serializes concurrent stale-socket recovery so a later host cannot unlink a new broker", async () => {
    if (process.platform === "win32") return;
    const config = await bridgeConfig();
    await writeFile(config.socketPath, "stale socket placeholder");
    const first = new LocalBroker({ config });
    const second = new LocalBroker({ config });
    const outcomes = await Promise.allSettled([first.start(), second.start()]);
    const started = [first, second].filter((_, index) => outcomes[index]?.status === "fulfilled");
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(started).toHaveLength(1);
    expect(rejected).toMatchObject({ reason: { code: "BROKER_ALREADY_RUNNING" } });
    brokers.push(started[0]!);

    const client = await connected(config, "mcp", "profile-recovery");
    await expect(client.request("broker.status", {}, "profile-recovery"))
      .resolves.toMatchObject({ listening: true, browserConnected: false });
  });
});
