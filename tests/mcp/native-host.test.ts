import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerClient } from "../../packages/mcp/src/broker-client.js";
import { startLocalBroker, type LocalBroker } from "../../packages/mcp/src/broker.js";
import type { BridgeConfig } from "../../packages/mcp/src/config.js";
import { MAX_NATIVE_MESSAGE_BYTES } from "../../packages/mcp/src/constants.js";
import { NativeMessageDecoder, encodeNativeMessage } from "../../packages/mcp/src/native-framing.js";
import { runNativeHost } from "../../packages/mcp/src/native-host.js";
import { isWireRequest, isWireResponse, successResponse, type WireMessage } from "../../packages/mcp/src/wire.js";

const brokers: LocalBroker[] = [];
const clients: BrokerClient[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function config(): Promise<BridgeConfig> {
  const directory = await mkdtemp(join(tmpdir(), "babel-clipper-host-"));
  directories.push(directory);
  return {
    v: 1,
    hostName: "com.babel.content_clipper",
    socketPath: join(directory, "broker.sock"),
    secret: "c".repeat(43),
  };
}

function outputQueue(stream: PassThrough): () => Promise<WireMessage> {
  const decoder = new NativeMessageDecoder(MAX_NATIVE_MESSAGE_BYTES);
  const messages: WireMessage[] = [];
  const waiters: Array<(message: WireMessage) => void> = [];
  stream.on("data", (chunk: Buffer) => {
    for (const value of decoder.push(chunk)) {
      const message = value as WireMessage;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  return async () => {
    const existing = messages.shift();
    if (existing) return existing;
    return new Promise<WireMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for Native Host output.")), 1000);
      waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
}

describe("Native Host broker relay", () => {
  it("registers its profile then forwards broker requests and extension responses with the same id", async () => {
    const bridgeConfig = await config();
    const broker = await startLocalBroker({ config: bridgeConfig });
    brokers.push(broker);
    const input = new PassThrough();
    const output = new PassThrough();
    const nextOutput = outputQueue(output);
    const host = runNativeHost({
      config: bridgeConfig,
      input,
      output,
      ensureBroker: async () => undefined,
    });

    input.write(encodeNativeMessage({
      v: 1,
      id: "hello",
      method: "bridge.hello",
      params: { channel: "test" },
      profileId: "profile-host",
    }));
    const hello = await nextOutput();
    expect(isWireResponse(hello) && hello.ok).toBe(true);

    const mcp = await BrokerClient.connect({
      config: bridgeConfig,
      role: "mcp",
      profileId: "profile-host",
    });
    clients.push(mcp);
    const pending = mcp.request("capture.list", { view: "pending" });
    const brokerRequest = await nextOutput();
    expect(isWireRequest(brokerRequest)).toBe(true);
    if (!isWireRequest(brokerRequest)) throw new Error("expected broker request");
    expect(brokerRequest).toMatchObject({
      method: "capture.list",
      profileId: "profile-host",
    });

    input.write(encodeNativeMessage(successResponse(
      brokerRequest.id,
      { records: [], revision: 0 },
      "profile-host",
    )));
    await expect(pending).resolves.toMatchObject({ records: [], revision: 0 });

    input.end();
    await host;
  });
});
