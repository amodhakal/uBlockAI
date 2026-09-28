/**
 * Focus management for in-page UI.
 *
 * The warning panel the extension mounts over a hidden post is the only UI
 * this extension puts inside somebody else's page, and it had no keyboard
 * behaviour at all: focus stayed wherever the last click left it, Tab walked
 * straight out of the panel and into the host site's feed, Escape did nothing,
 * and a screen reader user had no way to tell that a post had been replaced.
 *
 * Three things are provided, and they are separate on purpose because they are
 * separately useful:
 *
 *  - `focusablesIn()`  - the tabbable subset of a container, in DOM order.
 *  - `trapFocus()`     - keeps Tab and Shift+Tab inside a container, and
 *                        restores focus to the invoker when released.
 *  - `onEscape()`      - closes on Escape, returning focus to the invoker.
 *
 * Note on "the detail view": issue #79's explanation detail view (reasoning,
 * evidence, uncertainties) is not in this branch's base, so there is no such
 * view to trap focus in yet. `buildPlaceholder` mounts the panel with
 * `trapFocus` armed and the panel as the container, which is the same contract
 * #79's detail view should adopt when it lands: pass it the detail container
 * and a close handler. Do not add a second, subtly different focus trap.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]",
  "[contenteditable='true']",
].join(",");

/**
 * Elements a keyboard user can actually reach, in DOM order.
 *
 * The filter is attribute-based on purpose: `hidden`, `disabled`,
 * `aria-hidden="true"` and a negative `tabindex` all reliably mean "not in the
 * tab order". A `getClientRects()` emptiness check would additionally catch
 * `display: none` subtrees, but it depends on a layout engine, so it silently
 * reports every element as unreachable outside a browser and would have to be
 * stubbed out in every test. The browser's own sequential focus navigation
 * already skips non-rendered elements; this list only has to be right about
 * what the markup declares.
 *
 * @param {ParentNode} container
 * @returns {HTMLElement[]}
 */
export function focusablesIn(container) {
  if (!container || typeof container.querySelectorAll !== "function") return [];
  const seen = new Set();
  const out = [];
  for (const node of container.querySelectorAll(FOCUSABLE)) {
    if (seen.has(node)) continue;
    const tabindex = node.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) < 0) continue;
    if (node.hasAttribute("disabled") || node.getAttribute("aria-hidden") === "true") {
      continue;
    }
    if (node.hasAttribute("hidden")) continue;
    seen.add(node);
    out.push(node);
  }
  return out;
}

/**
 * Keep keyboard focus inside a container until the returned function is called.
 *
 * The listener is on the owner *document*, not on the container, and it checks
 * whether the newly focused element is inside the container. That distinction
 * is the whole implementation: `focusin` bubbles up from the element that
 * received focus, so a container-scoped listener never fires when focus leaves,
 * which is precisely the case a trap has to catch. A document-scoped listener
 * catches focus leaving by any route - Tab, a click outside, a programmatic
 * `.focus()` from the host site, find-in-page.
 *
 * Reimplementing Tab order is the usual alternative and is where traps go
 * wrong: they have to be right about Shift+Tab, about elements added and
 * removed while the trap is armed, and about the browser's own focus
 * heuristics. This version only has to be right about containment.
 *
 * @param {HTMLElement} container
 * @param {{returnFocusTo?: HTMLElement}} [options]
 * @returns {() => void} release; also restores focus to the invoker
 */
export function trapFocus(container, options = {}) {
  if (!container) return () => {};

  const doc =
    container.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!doc) return () => {};

  const returnFocusTo =
    options.returnFocusTo ||
    (typeof document !== "undefined" ? document.activeElement : null);

  let madeFocusable = false;
  // Reentrancy guard. `element.focus()` inside a `focusin` handler fires
  // another `focusin` synchronously, so without this the handler can be made
  // to bounce focus between two elements - and if a focused element is removed
  // mid-callback the browser falls back to <body> and the trap fires again.
  // Events caused by our own correction are not escapes and must be ignored.
  let correcting = false;

  const onFocusIn = (event) => {
    if (correcting) return;
    const target = event.target;
    if (target && container.contains(target)) return;

    const items = focusablesIn(container);
    if (items.length === 0 && !container.hasAttribute("tabindex")) {
      // Nothing inside is reachable. Making the container itself focusable is
      // the only way to stop focus escaping to the host page, so do it and take
      // it back out on release.
      container.setAttribute("tabindex", "-1");
      madeFocusable = true;
    }
    const next = items[0] || container;
    if (next === target) return;
    correcting = true;
    try {
      next.focus();
    } finally {
      correcting = false;
    }
  };

  doc.addEventListener("focusin", onFocusIn, true);

  return () => {
    doc.removeEventListener("focusin", onFocusIn, true);
    if (madeFocusable) container.removeAttribute("tabindex");
    if (
      returnFocusTo &&
      typeof returnFocusTo.focus === "function" &&
      returnFocusTo.isConnected
    ) {
      returnFocusTo.focus();
    }
  };
}

/**
 * Run a handler when Escape is pressed inside a container.
 *
 * Bound to the container, not to `document`, so two extension surfaces in the
 * same page do not both react, and so a keystroke meant for the host site is
 * not swallowed.
 *
 * @param {HTMLElement} container
 * @param {(event: KeyboardEvent) => void} handler
 * @returns {() => void} release
 */
export function onEscape(container, handler) {
  if (!container) return () => {};
  const listener = (event) => {
    if (event.key !== "Escape" && event.key !== "Esc") return;
    event.preventDefault();
    event.stopPropagation();
    handler(event);
  };
  container.addEventListener("keydown", listener);
  return () => container.removeEventListener("keydown", listener);
}

/**
 * Move focus to the first tabbable element in a container, or to the container
 * itself when it has nothing focusable.
 *
 * @param {HTMLElement} container
 * @returns {boolean} whether focus landed inside the container
 */
export function focusFirstIn(container) {
  const items = focusablesIn(container);
  const target = items[0] || container;
  if (typeof target.focus !== "function") return false;
  target.focus();
  return container.contains(target) || target === container;
}
