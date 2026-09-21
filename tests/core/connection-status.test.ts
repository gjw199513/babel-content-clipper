import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import {
  createClipperService,
  deleteClipperDatabase,
  type ConnectionStatusResult,
  type CoreService,
} from "../../packages/core/src/index.js";

const services: CoreService[] = [];
const databases: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.allSettled(databases.splice(0).map((database) => deleteClipperDatabase(database)));
});

describe("connection capability advertisement", () => {
  it("advertises extension-owned source media acquisition", async () => {
    const databaseName = `connection-status-${crypto.randomUUID()}`;
    databases.push(databaseName);
    const service = createClipperService({
      databaseName,
      extensionVersion: "0.1.1",
      coreVersion: "0.1.1",
    });
    services.push(service);

    const status = await service.handle("connection.status", {}, { profileId: "profile-status" }) as ConnectionStatusResult;

    expect(status.capabilities.methods).toContain("capture.acquireMedia");
  });
});
