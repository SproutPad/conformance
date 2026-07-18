export const DEFAULT_RESPONSE_LIMIT_BYTES = 1_000_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function positiveInteger(value, fallback, label) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return candidate;
}

export function canonicalBaseUrl(input) {
  const value = input ?? "https://api.sproutpad.ai";
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("base URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "base URL must not contain credentials, query, or fragment",
    );
  }
  return url.href.replace(/\/$/, "");
}

export function requireGovernedHttps(input) {
  const baseUrl = canonicalBaseUrl(input);
  if (new URL(baseUrl).protocol !== "https:") {
    throw new Error("governed profile requires an https base URL");
  }
  return baseUrl;
}

export function cleanError(value, secrets = []) {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      message = message.replaceAll(secret, "[redacted]");
    }
  }
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:agk_|sk_(?:live|test)_)[A-Za-z0-9._~-]+/g, "[redacted]")
    .replace(
      /\b(?:gh[pousr]_|github_pat_|npm_)[A-Za-z0-9_]{20,}\b/g,
      "[redacted]",
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[redacted private key]",
    )
    .replace(
      /("(?:authorization|authorizationHeader|token|accessToken|refreshToken|apiKey|api_key|secret|password|privateKey)"\s*:\s*")[^"]*/gi,
      "$1[redacted]",
    )
    .replace(/\r?\n/g, " ")
    .slice(0, 500);
}

export async function readBoundedText(
  response,
  { label = "response", limitBytes = DEFAULT_RESPONSE_LIMIT_BYTES } = {},
) {
  const limit = positiveInteger(
    limitBytes,
    DEFAULT_RESPONSE_LIMIT_BYTES,
    "response limit",
  );
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > limit) {
      throw new Error(`${label} exceeds ${limit} byte safety limit`);
    }
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} exceeds ${limit} byte safety limit`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function parseJsonText(text, label = "response") {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function boundedRequest(
  fetchImpl,
  url,
  init = {},
  {
    label = new URL(url).pathname,
    limitBytes = DEFAULT_RESPONSE_LIMIT_BYTES,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {},
) {
  const timeout = positiveInteger(
    timeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    "request timeout",
  );
  const response = await fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  const text = await readBoundedText(response, { label, limitBytes });
  return { response, text };
}
