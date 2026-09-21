const SENSITIVE_QUERY_KEYS = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "authtoken",
  "bearer",
  "clientsecret",
  "code",
  "credential",
  "credentials",
  "exp",
  "expires",
  "idtoken",
  "jwt",
  "key",
  "password",
  "passwd",
  "refreshtoken",
  "secret",
  "session",
  "sessionid",
  "sig",
  "signature",
  "token",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function isSensitiveUrlParameter(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SENSITIVE_QUERY_KEYS.has(normalized)) return true;
  return normalized.endsWith("token")
    || normalized.endsWith("signature")
    || normalized.endsWith("credential")
    || normalized.endsWith("secret");
}

function removeSensitiveParameters(params: URLSearchParams): boolean {
  const keys = [...new Set([...params.keys()])];
  let changed = false;
  for (const key of keys) {
    if (!isSensitiveUrlParameter(key)) continue;
    params.delete(key);
    changed = true;
  }
  return changed;
}

function redactHash(hash: string): string {
  if (hash.length <= 1) return hash;
  const raw = hash.slice(1);
  const queryIndex = raw.indexOf("?");
  const prefix = queryIndex >= 0 ? raw.slice(0, queryIndex) : "";
  const candidate = queryIndex >= 0 ? raw.slice(queryIndex + 1) : raw;
  if (!candidate.includes("=")) return hash;
  const params = new URLSearchParams(candidate);
  if (!removeSensitiveParameters(params)) return hash;
  const suffix = params.toString();
  if (queryIndex >= 0) return suffix ? `#${prefix}?${suffix}` : prefix ? `#${prefix}` : "";
  return suffix ? `#${suffix}` : "";
}

/**
 * Removes embedded credentials and common signed/authentication parameters.
 * Invalid URLs are replaced instead of being echoed back into persisted facts.
 */
export function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    removeSensitiveParameters(url.searchParams);
    url.hash = redactHash(url.hash);
    return url.href;
  } catch {
    return "about:blank";
  }
}
