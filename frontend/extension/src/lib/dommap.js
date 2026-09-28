/**
 * Stable post identity to live element, re-resolved at the moment of mutation.
 *
 * `element.isConnected` is necessary but not sufficient. Social feeds are
 * virtualised: a node removed for one post is frequently reused for the next
 * one without ever being detached. The gap between collecting a post and
 * applying its analysis is up to REQUEST_TIMEOUT_MS plus queueing, during which
 * the user can scroll a long way. A naive check would then replace a
 * *legitimate* post with a placeholder because the *previous* post's analysis
 * came back positive, which for a blocker is the worst possible failure.
 *
 * Two structures are used deliberately:
 *  - a WeakMap is authoritative, because a content script's isolated world
 *    shares the DOM with the page and any attribute the page sets is forgeable;
 *  - a data attribute is only a lookup index, re-verified against the WeakMap
 *    before the element is trusted.
 */

import { MARK_ATTRS } from "./placeholder.js";

/** @type {WeakMap<Element, string>} */
const bindings = new WeakMap();

/**
 * Record which element a post key belongs to, and stamp the key onto it.
 *
 * @param {Element} element
 * @param {string} postKey
 * @returns {void}
 */
export function registerPost(element, postKey) {
  if (!element || !postKey) return;
  bindings.set(element, postKey);
  element.setAttribute(MARK_ATTRS.POST_KEY, postKey);
}

/**
 * Re-resolve a post's element by key at the moment of mutation.
 *
 * Returns null when the element is gone, or when the node now belongs to a
 * different post. The second case is what `isConnected` cannot see.
 *
 * The lookup avoids building a selector from the key: a key can contain a full
 * CDN URL, and interpolating one into a selector is an injection vector.
 *
 * @param {string} postKey
 * @param {Document|Element} [root]
 * @returns {Element|null}
 */
export function resolvePostElement(postKey, root) {
  if (!postKey) return null;
  const scope = root || (typeof document === "undefined" ? null : document);
  if (!scope) return null;

  for (const element of scope.querySelectorAll(`[${MARK_ATTRS.POST_KEY}]`)) {
    if (element.getAttribute(MARK_ATTRS.POST_KEY) !== postKey) continue;
    // The attribute is an index only. The page can set it on its own nodes, so
    // the WeakMap must confirm the binding before the element is used.
    if (bindings.get(element) !== postKey) continue;
    if (!element.isConnected) continue;
    return element;
  }
  return null;
}

/**
 * Whether an element still represents the post it was registered for.
 *
 * @param {Element} element
 * @param {string} postKey
 * @returns {boolean}
 */
export function isCurrentPost(element, postKey) {
  if (!element || !element.isConnected) return false;
  return bindings.get(element) === postKey;
}

/** Forget a binding, e.g. once a post is definitively un-hidden. */
export function forgetPost(element) {
  if (element) bindings.delete(element);
}
