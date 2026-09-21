import { createClipperService } from "../../../packages/core/src/index.js";

export interface CoreContext { profileId?: string }

let service: ReturnType<typeof createClipperService> | undefined;

function bundledVersion(): string | undefined {
  const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & { version_name?: unknown };
  return typeof manifest.version_name === "string" && manifest.version_name.length > 0
    ? manifest.version_name
    : manifest.version;
}

function getService(): ReturnType<typeof createClipperService> {
  const version = bundledVersion();
  service ??= createClipperService({ extensionVersion: version, coreVersion: version });
  return service;
}

export async function handleCore(method: string, params: unknown, context: CoreContext = {}): Promise<unknown> {
  return getService().handle(method, params, context);
}
