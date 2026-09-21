import { redactUrlCredentials } from "../../../packages/core/src/url-security.js";

export function truncateText(input: string, maxLength = 120_000): string {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength)}\n[内容已截断；详情保留上限内的原文]`;
}

export function redactUrl(value: string): string {
  return redactUrlCredentials(value);
}
