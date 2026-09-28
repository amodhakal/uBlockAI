/**
 * DOM behaviour for the placeholder, the attribute contract and element
 * re-resolution. Uses linkedom so these run in Node without a browser.
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { parseHTML } from "linkedom";

import {
  MARK_ATTRS,
  buildPlaceholder,
  installStyles,
  markPost,
  mountPlaceholder,
} from "./placeholder.js";
import { isCurrentPost, registerPost, resolvePostElement } from "./dommap.js";
import { HIDING_ACTIONS } from "./defaults.js";

let dom;

before(() => {
  dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  // The modules under test reach for the globals a browser would provide.
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.Node = dom.Node;
});

/** Fresh document containing exactly the given markup. */
function mount(html) {
  const { document: doc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  globalThis.document = doc;
  return doc.body.firstElementChild;
}

/**
 * A single shared document with `count` article elements appended. Used where a
 * test needs two nodes visible at once, e.g. a real element and a forged one.
 */
function mountMany(count) {
  const { document: doc } = parseHTML("<!doctype html><html><body></body></html>");
  globalThis.document = doc;
  const elements = [];
  for (let i = 0; i < count; i += 1) {
    const el = doc.createElement("article");
    doc.body.append(el);
    elements.push(el);
  }
  return elements;
}

// --------------------------------------------------------------------------
// Model output never becomes markup
// --------------------------------------------------------------------------

test("the model explanation is rendered as text, never as markup", () => {
  const placeholder = buildPlaceholder({
    postKey: "p:1",
    explanation: '<img src=x onerror="alert(1)">',
  });
  assert.equal(placeholder.querySelector("img"), null, "model output was parsed as HTML");
  assert.match(placeholder.textContent, /onerror/);
});

test("a script tag in the explanation does not create a script element", () => {
  const placeholder = buildPlaceholder({
    postKey: "p:1",
    explanation: "<script>window.__pwned = 1</script>",
  });
  assert.equal(placeholder.querySelector("script"), null);
  assert.match(placeholder.textContent, /__pwned/);
});

// --------------------------------------------------------------------------
// No inline handlers
// --------------------------------------------------------------------------

test("the placeholder contains no inline event handler attributes", () => {
  const placeholder = buildPlaceholder({
    postKey: "p:1",
    explanation: "flagged",
    imageUrl: "https://scontent.cdninstagram.com/a.jpg",
    action: HIDING_ACTIONS.BLUR,
  });
  for (const node of placeholder.querySelectorAll("*")) {
    for (const attr of node.getAttributeNames()) {
      assert.ok(
        !/^on[a-z]+$/i.test(attr),
        `inline handler ${attr} is blocked by the page CSP and must not be used`,
      );
    }
  }
});

test("hover styling comes from CSS, not from listeners", () => {
  // Inline onmouseover/onmouseout attributes are blocked by the page's CSP, so
  // the hover effect has to come from a stylesheet rule.
  const source = readFileSync(new URL("./placeholder.js", import.meta.url), "utf8");
  assert.match(source, /:hover/);
  assert.ok(!/mouseover|mouseout/.test(source), "hover must not use mouse listeners");
});

// --------------------------------------------------------------------------
// Hiding actions
// --------------------------------------------------------------------------

test("the remove action produces no placeholder", () => {
  assert.equal(buildPlaceholder({ postKey: "p:1", action: HIDING_ACTIONS.REMOVE }), null);
});

test("the blur action actually renders an image to blur", () => {
  // The blur action was inert: the class was set but no image was inserted, so
  // it looked identical to the placeholder action.
  const placeholder = buildPlaceholder({
    postKey: "p:1",
    imageUrl: "https://scontent.cdninstagram.com/a.jpg",
    action: HIDING_ACTIONS.BLUR,
  });
  assert.ok(placeholder.classList.contains("aibot-blur"));
  const img = placeholder.querySelector("img");
  assert.ok(img, "blur action rendered no image");
  assert.equal(img.getAttribute("src"), "https://scontent.cdninstagram.com/a.jpg");
});

test("a non-http image url is dropped by the blur action", () => {
  const placeholder = buildPlaceholder({
    postKey: "p:1",
    imageUrl: "javascript:alert(1)",
    action: HIDING_ACTIONS.BLUR,
  });
  assert.equal(placeholder.querySelector("img"), null);
});

test("the report button is disabled once reported", () => {
  const placeholder = buildPlaceholder({ postKey: "p:1", reported: true });
  const button = placeholder.querySelector(".aibot-report-fp");
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /Reported/);
});

// --------------------------------------------------------------------------
// Listener binding happens once
// --------------------------------------------------------------------------

test("mountPlaceholder wires exactly one handler per button", () => {
  let reveals = 0;
  const placeholder = mountPlaceholder(
    { postKey: "p:1" },
    { onReveal: () => (reveals += 1) },
  );
  placeholder.querySelector(".aibot-show-btn").click();
  assert.equal(reveals, 1);

  // A second mount creates a fresh node, so the previous binding is irrelevant.
  mountPlaceholder({ postKey: "p:2" }, { onReveal: () => (reveals += 1) });
  placeholder.querySelector(".aibot-show-btn").click();
  assert.equal(reveals, 2, "each mount owns exactly its own node");
});

// --------------------------------------------------------------------------
// Attribute contract
// --------------------------------------------------------------------------

test("markPost writes the shared attribute names", () => {
  const element = mount("<article></article>");
  markPost(element, { postKey: "p:1", state: "hidden" });
  assert.equal(element.getAttribute(MARK_ATTRS.PROCESSED), "true");
  assert.equal(element.getAttribute(MARK_ATTRS.REMOVED), "true");
  assert.equal(element.getAttribute(MARK_ATTRS.POST_KEY), "p:1");
});

test("markPost clears the mutually exclusive states", () => {
  const element = mount("<article></article>");
  markPost(element, { postKey: "p:1", state: "hidden" });
  markPost(element, { postKey: "p:1", state: "safe" });
  assert.equal(element.getAttribute(MARK_ATTRS.SAFE), "true");
  assert.equal(element.getAttribute(MARK_ATTRS.REMOVED), null);

  markPost(element, { postKey: "p:1", state: "hidden" });
  assert.equal(element.getAttribute(MARK_ATTRS.SAFE), null);
  assert.equal(element.getAttribute(MARK_ATTRS.REMOVED), "true");
});

test("markSafe records the post key, which is what makes it re-evaluatable", () => {
  const element = mount("<article></article>");
  registerPost(element, "p:1");
  markPost(element, { postKey: "p:1", state: "safe" });
  // reapplyAll resolves posts by this attribute; without it a safe post is
  // invisible to threshold re-evaluation.
  assert.equal(element.getAttribute(MARK_ATTRS.POST_KEY), "p:1");
  assert.equal(resolvePostElement("p:1"), element);
});

test("markPost reports a detached element rather than throwing", () => {
  const element = mount("<article></article>");
  element.remove();
  assert.equal(markPost(element, { postKey: "p:1", state: "hidden" }), false);
});

test("installStyles is idempotent", () => {
  installStyles();
  installStyles();
  installStyles();
  assert.equal(document.querySelectorAll("#aibot-styles").length, 1);
});

// --------------------------------------------------------------------------
// Element re-resolution
// --------------------------------------------------------------------------

test("resolvePostElement returns the bound element", () => {
  const element = mount("<article></article>");
  registerPost(element, "p:1");
  assert.equal(resolvePostElement("p:1"), element);
});

test("resolvePostElement returns null once the element is detached", () => {
  const element = mount("<article></article>");
  registerPost(element, "p:1");
  element.remove();
  assert.equal(resolvePostElement("p:1"), null);
});

test("resolvePostElement returns null when a connected node is recycled", () => {
  // The case isConnected cannot detect: a virtualised feed reuses the same
  // connected node for a different post.
  const element = mount("<article></article>");
  registerPost(element, "p:1");
  assert.equal(isCurrentPost(element, "p:1"), true);

  // The node is reused for a different post while still connected.
  registerPost(element, "p:2");
  assert.equal(element.isConnected, true);
  assert.equal(resolvePostElement("p:1"), null, "stale key must not resolve");
  assert.equal(resolvePostElement("p:2"), element);
  assert.equal(isCurrentPost(element, "p:1"), false);
});

test("resolvePostElement ignores a page-forged attribute", () => {
  // An isolated content script shares the DOM, so the page can set data-*
  // attributes on its own nodes. The attribute is an index only; the WeakMap
  // is authoritative. Both elements must be in the same document for the
  // lookup order to be meaningful.
  const [real, forged] = mountMany(2);
  registerPost(real, "p:1");
  forged.setAttribute(MARK_ATTRS.POST_KEY, "p:1");

  assert.equal(resolvePostElement("p:1"), real, "the forged element must not win");
  assert.equal(isCurrentPost(forged, "p:1"), false);
});

test("resolvePostElement does not build a selector from the key", () => {
  // A key can contain a full CDN URL, so the lookup must not interpolate it.
  const element = mount("<article></article>");
  const key = 'url:https://x/a.jpg?a="][x';
  registerPost(element, key);
  assert.equal(resolvePostElement(key), element);
  assert.equal(resolvePostElement('url:https://x/a.jpg?a="][x'), element);
});

test("resolvePostElement returns null for an empty or unknown key", () => {
  mount("<article></article>");
  assert.equal(resolvePostElement(""), null);
  assert.equal(resolvePostElement("nope"), null);
});
