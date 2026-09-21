import { createClipperService } from "../../../packages/core/src/index.js";

export interface CoreContext { profileId?: string }

let service: ReturnType<typeof createClipperService> | undefined;

function getService(): ReturnType<typeof createClipperService> {
  service ??= createClipperService();
  return service;
}

export async function handleCore(method: string, params: unknown, context: CoreContext = {}): Promise<unknown> {
  return getService().handle(method, params, context);
}
