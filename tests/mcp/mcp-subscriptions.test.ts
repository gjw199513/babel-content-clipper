import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createClipperMcpServer,
  recordResourceUri,
  type McpBridgeClient,
} from "../../packages/mcp/src/mcp-server.js";
import type { WireEvent } from "../../packages/mcp/src/wire.js";

class EventBridge extends EventEmitter implements McpBridgeClient {
  async request(method: string): Promise<unknown> {
    if (method === "capture.list") return { records: [], revision: 0 };
    if (method === "connection.status") return { browserAvailable: true, databaseAvailable: true, revision: 0 };
    return {};
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP resource update notification.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("MCP record resource subscriptions", () => {
  it("conservatively invalidates every subscribed record when an extension event lacks captureId", async () => {
    const profileId = "profile-subscriptions";
    const bridge = new EventBridge();
    const handle = createClipperMcpServer({ profileId, bridge });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "subscription-test", version: "1.0.0" }, { capabilities: {} });
    const notifications: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      notifications.push(notification.params.uri);
    });

    try {
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      const first = recordResourceUri(profileId, "capture-one");
      const second = recordResourceUri(profileId, "capture-two");
      await client.subscribeResource({ uri: first });
      await client.subscribeResource({ uri: second });

      bridge.emit("event", {
        v: 1,
        event: "resource.changed",
        profileId,
        payload: { revision: 7, method: "job.complete" },
      } satisfies WireEvent);
      await waitFor(() => notifications.length === 2);
      expect(notifications.sort()).toEqual([first, second].sort());

      notifications.length = 0;
      bridge.emit("event", {
        v: 1,
        event: "resource.changed",
        profileId,
        payload: { revision: 8, method: "job.complete", captureId: "capture-one" },
      } satisfies WireEvent);
      await waitFor(() => notifications.length === 1);
      expect(notifications).toEqual([first]);
    } finally {
      await Promise.allSettled([client.close(), handle.close()]);
    }
  });
});
