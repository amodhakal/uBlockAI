/**
 * Opt-in, redacted diagnostics.
 *
 * The extension writes user-generated content to storage and receives
 * server-controlled strings in error bodies. Both used to reach the console
 * verbatim, through console.warn calls that nothing gated. There is no way to
 * un-log, so redaction has to happen before the console call.
 *
 * The gate is a storage flag rather than a build flag, so it works in a
 * store-installed extension that a developer never rebuilds.
 */

import { STORAGE_KEYS } from "./defaults.js";

export const DEBUG_KEY = STORAGE_KEYS.debugLogging;

const REDACTED = "[redacted]";

/**
 * Key fragments that mark a value as sensitive. Matched case-insensitively as
 * substrings, so `myApiKey` and `X_API_KEY` are both caught.
 *
 * `postKey` is included even though it is not a secret: it is derived from a
 * CDN URL and is therefore a user-identifying tracking handle.
 */
const SENSITIVE_KEYS = Object.freeze([
  "apikey",
  "api-key",
  "api_key",
  "authorization",
  "bearer",
  "token",
  "secret",
  "password",
  "cookie",
  "caption",
  "explanation",
  "imageurl",
  "image_url",
  "post_key",
  "postkey",
  "data_base64",
  "payload",
]);

const MAX_STRING_CHARS = 200;
const MAX_DEPTH = 4;

/** @type {boolean} */
let enabled = false;

/** @param {string} key */
function isSensitive(key) {
  const lower = String(key).toLowerCase();
  return SENSITIVE_KEYS.some((fragment) => lower.includes(fragment));
}

/**
 * Recursively redact a value for logging.
 *
 * @param {unknown} value
 * @param {{maxStringChars?: number, maxDepth?: number}} [options]
 * @param {WeakSet<object>} [seen] cycle guard
 * @returns {unknown}
 */
export function redact(value, options = {}, seen = new WeakSet(), depth = 0) {
  const maxStringChars = options.maxStringChars ?? MAX_STRING_CHARS;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;

  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (typeof value === "string") {
    return value.length > maxStringChars
      ? `${value.slice(0, maxStringChars)}…(${value.length} chars)`
      : value;
  }

  if (typeof value === "function" || typeof value === "symbol")
    return `[${typeof value}]`;

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    // Depth is an explicit counter. Deriving it from the number of visited
    // objects would accumulate across siblings, so the limit would stop
    // working for shallow-but-wide structures.
    if (depth >= maxDepth) return "[depth]";
    seen.add(value);

    if (Array.isArray(value)) {
      const out = value
        .slice(0, 25)
        .map((item) => redact(item, options, seen, depth + 1));
      if (value.length > 25) out.push(`… ${value.length - 25} more items`);
      return out;
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redact(value.message, options, seen, depth + 1),
      };
    }

    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitive(key) ? REDACTED : redact(item, options, seen, depth + 1);
    }
    return out;
  }

  return String(value);
}

/** @param {boolean} on */
export function setDebug(on) {
  enabled = Boolean(on);
}

/** @returns {boolean} */
export function debugEnabled() {
  return enabled;
}

/**
 * Log only when debug is enabled.
 * @param {string} scope
 * @param {string} message
 * @param {unknown} [detail]
 */
export function logDebug(scope, message, detail) {
  if (!enabled) return;
  if (detail === undefined) {
    console.warn(`[uBlockAI:${scope}] ${message}`);
    return;
  }
  console.warn(`[uBlockAI:${scope}] ${message}`, redact(detail));
}

/**
 * Log an error. Always emitted, and always redacted.
 * @param {string} scope
 * @param {string} message
 * @param {unknown} [detail]
 */
export function logError(scope, message, detail) {
  if (detail === undefined) {
    console.warn(`[uBlockAI:${scope}] ${message}`);
    return;
  }
  console.warn(`[uBlockAI:${scope}] ${message}`, redact(detail));
}

export { REDACTED };
