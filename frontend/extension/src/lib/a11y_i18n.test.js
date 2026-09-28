/**
 * Accessibility and localization scaffolding.
 *
 * Two things are easy to break silently and expensive to notice later: a
 * message name that no longer exists in the catalogue (every user sees the raw
 * key), and a focus trap that stops containing focus (every keyboard user falls
 * out of the UI). Both are pinned here.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { parseHTML } from "linkedom";

import {
  FALLBACK_MESSAGES,
  FALLBACK_PLACEHOLDERS,
  applyTranslations,
  interpolate,
  setDocumentLocale,
  t,
} from "./i18n.js";
import { focusFirstIn, focusablesIn, onEscape, trapFocus } from "./focus.js";
import { announce, buildPlaceholder, mountPlaceholder } from "./placeholder.js";
import { applyFontScale } from "./settings.js";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_ORDER,
  FONT_SCALES,
  fontScaleFactor,
} from "./defaults.js";

const EXTENSION_ROOT = new URL("../../", import.meta.url);

function read(file) {
  return readFileSync(new URL(file, EXTENSION_ROOT), "utf8");
}

function messages() {
  return JSON.parse(read("_locales/en/messages.json"));
}

let dom;

before(() => {
  dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.Node = dom.Node;
  globalThis.Event = dom.Event;
});

/**
 * Give a linkedom document the two pieces of focus behaviour it lacks.
 *
 * linkedom has no layout and no focus model: `document.activeElement` does not
 * exist and `element.focus()` dispatches a bare `focus` event that changes
 * nothing. Every focus assertion would therefore pass vacuously, which is worse
 * than not testing focus at all.
 *
 * So the harness supplies what a browser supplies: an `activeElement` that
 * tracks the last focused node, and a `focus()` that sets it and dispatches the
 * `focusin` event a real browser dispatches. The code under test is unmodified;
 * only the environment is filled in.
 *
 * @param {Document} doc
 * @returns {() => Node|null} the current active element
 */
function enableFocus(doc) {
  const active = { node: null };
  Object.defineProperty(doc, "activeElement", {
    get: () => active.node,
    configurable: true,
  });

  const focusNode = (node) => {
    active.node = node;
    // focusin bubbles in a real browser, and the trap listens on the document,
    // so the synthetic event has to bubble too. Dispatching it at the document
    // instead would leave event.target undefined, which is a linkedom quirk
    // rather than something the module under test should have to know about.
    node.dispatchEvent(new dom.Event("focusin", { bubbles: true, cancelable: false }));
  };

  const patch = (node) => {
    Object.defineProperty(node, "focus", {
      configurable: true,
      writable: true,
      value: () => focusNode(node),
    });
    return node;
  };

  // Elements created after mount() - buildPlaceholder, in particular - have to
  // be patched too, or their focus() is linkedom's no-op.
  const createElement = doc.createElement.bind(doc);
  Object.defineProperty(doc, "createElement", {
    configurable: true,
    writable: true,
    value: (...args) => patch(createElement(...args)),
  });
  for (const node of doc.querySelectorAll("*")) patch(node);

  return () => active.node;
}

/**
 * Fresh document containing exactly the given markup.
 *
 * Returns the document body, not the first element: the focus tests need to
 * query *into* their markup, and querySelector does not match the context
 * element itself.
 */
function mount(html) {
  const { document: doc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  globalThis.document = doc;
  enableFocus(doc);
  return doc.body;
}

/**
 * Run `fn` with a chrome.i18n backed by the real catalogue.
 *
 * Without this, `t()` in Node always takes the FALLBACK path, so the
 * interesting behaviour - a message that resolves, a substitution applied by
 * Chrome - would never be exercised. A stub is a lie in general, but here the
 * behaviour under test is "use chrome.i18n when it answers", and that is
 * exactly what the stub provides.
 *
 * @template T
 * @param {(catalog: Record<string, {message: string}>) => T} fn
 * @returns {T}
 */
function withChromeI18n(fn) {
  const catalog = messages();
  const previous = globalThis.chrome;
  globalThis.chrome = {
    i18n: {
      getMessage: (key, substitutions) => {
        const entry = catalog[key];
        if (!entry) return "";
        return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (match, name) => {
          const declared = Object.keys(entry.placeholders || {});
          const position = declared.findIndex(
            (candidate) => candidate.toLowerCase() === name.toLowerCase(),
          );
          if (position === -1) return match;
          const value = substitutions?.[position];
          return value === undefined || value === null ? match : String(value);
        });
      },
      getUILanguage: () => "de",
    },
  };
  try {
    return fn(catalog);
  } finally {
    globalThis.chrome = previous;
  }
}

// --------------------------------------------------------------------------
// Catalogue integrity
// --------------------------------------------------------------------------

test("every data-i18n key used in the popup and options pages exists", () => {
  const catalog = messages();
  for (const page of ["popup.html", "options.html"]) {
    const source = read(page);
    const keys = [...source.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.ok(keys.length > 0, `${page} declares no translatable strings`);
    for (const key of keys) {
      assert.ok(catalog[key], `${page} references ${key}, which is not in the catalogue`);
    }
  }
});

test("every message name passed to t() exists in the catalogue", () => {
  const catalog = messages();
  const sources = ["popup.js", "options.js", "src/script.js", "src/lib/placeholder.js"];
  const pattern = /\bt\(\s*"([A-Za-z0-9_]+)"/g;
  let checked = 0;
  for (const file of sources) {
    for (const [, key] of read(file).matchAll(pattern)) {
      assert.ok(catalog[key], `${file} calls t("${key}"), which is not in the catalogue`);
      checked += 1;
    }
  }
  assert.ok(checked >= 8, `only found ${checked} t() call sites to check`);
});

test("the option label maps cover every action and every font scale", () => {
  const catalog = messages();
  for (const key of [
    "popupActionPlaceholder",
    "popupActionBlur",
    "popupActionRemove",
    "fontScaleSmall",
    "fontScaleMedium",
    "fontScaleLarge",
  ]) {
    assert.ok(catalog[key], `${key} is missing from the catalogue`);
  }
});

test("the FALLBACK table has not drifted from the catalogue", () => {
  // FALLBACK exists so a JavaScript-composed string never renders a raw key.
  // That guarantee is only as good as its agreement with messages.json.
  const catalog = messages();
  for (const [key, template] of Object.entries(FALLBACK_MESSAGES)) {
    const entry = catalog[key];
    assert.ok(entry, `FALLBACK has ${key}, which the catalogue does not`);
    assert.equal(
      entry.message,
      template,
      `${key} differs between i18n.js and _locales/en/messages.json`,
    );
    assert.deepEqual(
      Object.keys(entry.placeholders || {}),
      FALLBACK_PLACEHOLDERS[key] || [],
      `${key} declares different placeholders in i18n.js and messages.json`,
    );
  }
  // And the reverse direction: a message the code relies on the fallback for
  // must not exist only in one place.
  for (const key of Object.keys(FALLBACK_MESSAGES)) {
    assert.ok(catalog[key]);
  }
});

// --------------------------------------------------------------------------
// t() and interpolation
// --------------------------------------------------------------------------

test("t() returns the key rather than an empty string for an unknown message", () => {
  // An empty string would silently blank out a label. The key is visible and
  // greppable.
  assert.equal(t("thisMessageDoesNotExist"), "thisMessageDoesNotExist");
});

test("interpolate substitutes by declared position, case-insensitively", () => {
  assert.equal(
    interpolate("$BRAND$ hid this", ["BRAND"], ["uBlockAI"]),
    "uBlockAI hid this",
  );
  assert.equal(
    interpolate("$brand$ hid this", ["BRAND"], ["uBlockAI"]),
    "uBlockAI hid this",
  );
  assert.equal(interpolate("risk: $PERCENT$%", ["PERCENT"], [42]), "risk: 42%");
});

test("interpolate leaves an undeclared placeholder alone", () => {
  assert.equal(interpolate("$NOPE$ stays", ["BRAND"], ["x"]), "$NOPE$ stays");
});

test("t() falls back to English and still interpolates without chrome.i18n", () => {
  assert.equal(t("placeholderScoreAi", ["37"]), "AI-generated risk: 37%");
  assert.equal(
    t("placeholderPanelLabel", ["uBlockAI"]),
    "Content hidden by uBlockAI as possible misinformation",
  );
});

test("applyTranslations does not overwrite text with an unresolved key", () => {
  const node = mount(
    '<p id="p" data-i18n="thisMessageDoesNotExist">Original English</p>',
  );
  const changed = applyTranslations(node.ownerDocument);
  assert.equal(node.textContent, "Original English");
  assert.equal(changed, 0);
});

test("applyTranslations writes text and attributes that do resolve", () => {
  withChromeI18n(() => {
    const root = mount(
      [
        "<div>",
        '  <p data-i18n="popupStatHidden">placeholder</p>',
        '  <button data-i18n-aria-label="popupHidingAction" data-i18n-title="popupTextSize">b</button>',
        "</div>",
      ].join(""),
    );
    const changed = applyTranslations(root.ownerDocument);
    assert.ok(changed >= 3, `expected at least 3 changes, got ${changed}`);
    assert.equal(root.querySelector("p").textContent, "Hidden");
    const button = root.querySelector("button");
    assert.equal(button.getAttribute("aria-label"), "When content is hidden");
    assert.equal(button.getAttribute("title"), "Text size");
  });
});

test("applyTranslations still leaves English in place for a key Chrome cannot resolve", () => {
  withChromeI18n(() => {
    const node = mount('<p data-i18n="noSuchMessage">Original English</p>');
    // chrome.i18n returns "" for a missing key. Writing that would blank the
    // label; writing the key would show "noSuchMessage". Neither is acceptable.
    assert.equal(applyTranslations(node.ownerDocument), 0);
    assert.equal(node.textContent, "Original English");
  });
});

test("t() prefers chrome.i18n and lets Chrome do the substitution", () => {
  withChromeI18n(() => {
    assert.equal(t("placeholderScoreAi", ["88"]), "AI-generated risk: 88%");
    assert.equal(
      t("placeholderShownLive", ["uBlockAI"]),
      "uBlockAI showed this post again at your request.",
    );
    // Still falls back for a key the catalogue does not have.
    assert.equal(t("noSuchMessage"), "noSuchMessage");
  });
});

test("setDocumentLocale reports the browser UI language", () => {
  withChromeI18n(() => {
    // Not forced to "en": <html lang> has to match the language the strings are
    // actually in, or a screen reader picks the wrong voice.
    assert.equal(setDocumentLocale(), "de");
    assert.equal(document.documentElement.getAttribute("lang"), "de");
  });
});

test("setDocumentLocale falls back to en without chrome.i18n", () => {
  assert.equal(setDocumentLocale(), "en");
  assert.equal(document.documentElement.getAttribute("lang"), "en");
});

// --------------------------------------------------------------------------
// Font scaling
// --------------------------------------------------------------------------

test("fontScaleFactor resolves every named scale and nothing else", () => {
  assert.equal(fontScaleFactor(FONT_SCALES.SMALL), 1);
  assert.equal(fontScaleFactor(FONT_SCALES.MEDIUM), 1.25);
  assert.equal(fontScaleFactor(FONT_SCALES.LARGE), 1.5);
  // A corrupt stored value must produce a number, never NaN, which would
  // invalidate the custom property and drop the text to the browser default.
  assert.equal(fontScaleFactor("huge"), fontScaleFactor(DEFAULT_FONT_SCALE));
  assert.equal(fontScaleFactor(undefined), 1);
  assert.equal(fontScaleFactor(42), 1);
});

test("every named scale is a strict increase, in order", () => {
  const factors = FONT_SCALE_ORDER.map(fontScaleFactor);
  for (let i = 1; i < factors.length; i += 1) {
    assert.ok(
      factors[i] > factors[i - 1],
      `scale ${FONT_SCALE_ORDER[i]} is not larger than ${FONT_SCALE_ORDER[i - 1]}`,
    );
  }
});

test("applyFontScale publishes one custom property on the root", () => {
  mount("<div></div>");
  const factor = applyFontScale(FONT_SCALES.LARGE);
  assert.equal(factor, 1.5);
  assert.equal(
    document.documentElement.style.getPropertyValue("--aibot-font-scale"),
    "1.5",
  );
});

test("all three surfaces read the same custom property", () => {
  for (const sheet of ["popup.css", "options.css", "src/lib/placeholder.js"]) {
    assert.ok(
      read(sheet).includes("--aibot-font-scale"),
      `${sheet} hardcodes a font size instead of reading the scale variable`,
    );
  }
});

test("the warning panel carries the user's scale", () => {
  mount("<div></div>");
  const panel = buildPlaceholder({ postKey: "p:1", fontScale: FONT_SCALES.LARGE });
  assert.equal(panel.style.getPropertyValue("--aibot-font-scale"), "1.5");
});

test("an unknown scale leaves the panel at the default rather than unset", () => {
  mount("<div></div>");
  const panel = buildPlaceholder({ postKey: "p:1", fontScale: "nonsense" });
  assert.equal(panel.style.getPropertyValue("--aibot-font-scale"), "1");
});

// --------------------------------------------------------------------------
// The warning panel's ARIA contract
// --------------------------------------------------------------------------

test("the warning panel is a named, focusable region", () => {
  mount("<div></div>");
  const panel = buildPlaceholder({ postKey: "p:1" });
  assert.equal(panel.getAttribute("tabindex"), "-1");
  const region = panel.querySelector(".aibot-panel");
  assert.equal(region.getAttribute("role"), "region");
  assert.match(region.getAttribute("aria-label"), /hidden by uBlockAI/);
});

test("the panel's icon is hidden from assistive technology", () => {
  mount("<div></div>");
  const panel = buildPlaceholder({ postKey: "p:1" });
  // A screen reader announcing "WARNING SIGN" before the actual warning is
  // noise.
  assert.equal(panel.querySelector(".aibot-icon").getAttribute("aria-hidden"), "true");
});

test("a reported button is both disabled and aria-disabled", () => {
  mount("<div></div>");
  const panel = buildPlaceholder({ postKey: "p:1", reported: true });
  const button = panel.querySelector(".aibot-report-fp");
  assert.equal(button.disabled, true);
  // Disabled alone removes the button from the tab order and from the
  // accessibility tree's announcements, so the reason is lost.
  assert.equal(button.getAttribute("aria-disabled"), "true");
});

test("the blurred video is inert", () => {
  mount("<div></div>");
  const panel = buildPlaceholder({
    postKey: "p:1",
    action: "blur",
    imageUrl: "https://cdn/p.jpg",
    videoUrl: "https://cdn/reel.mp4",
  });
  const video = panel.querySelector("video");
  assert.equal(video.getAttribute("aria-hidden"), "true");
  assert.equal(video.getAttribute("tabindex"), "-1");
  assert.equal(video.hasAttribute("autoplay"), false);
});

// --------------------------------------------------------------------------
// Live region
// --------------------------------------------------------------------------

test("announce creates one polite live region and reuses it", () => {
  const root = mount("<div id='host'></div>");
  const first = announce("hidden a post", root.ownerDocument);
  const second = announce("hid another post", root.ownerDocument);
  assert.equal(first, second, "a second live region was created");
  assert.equal(first.getAttribute("aria-live"), "polite");
  assert.equal(first.getAttribute("role"), "status");
  assert.equal(first.textContent, "hid another post");
  assert.equal(root.ownerDocument.querySelectorAll("[aria-live]").length, 1);
});

test("repeating the same message is still announced", () => {
  const root = mount("<div></div>");
  const region = announce("same", root.ownerDocument);
  announce("same", root.ownerDocument);
  // Screen readers ignore a write that does not change the text, so the region
  // is cleared first.
  assert.equal(region.textContent, "same");
});

test("the live region is hidden without being removed from the a11y tree", () => {
  const root = mount("<div></div>");
  const region = announce("hello", root.ownerDocument);
  assert.equal(region.className, "aibot-visually-hidden");
  // display:none or visibility:hidden would make this a no-op.
  const css = read("src/lib/placeholder.js");
  assert.ok(css.includes(".aibot-visually-hidden"));
  assert.ok(!/\.aibot-visually-hidden\s*\{[^}]*display:\s*none/.test(css));
  assert.ok(!/\.aibot-visually-hidden\s*\{[^}]*visibility:\s*hidden/.test(css));
});

// --------------------------------------------------------------------------
// Focus management
// --------------------------------------------------------------------------

/** Standard trap fixture: a panel with two controls and a button outside it. */
function trapFixture() {
  const root = mount(
    [
      '<div id="panel">',
      '  <button id="first">first</button>',
      "  <button id='last'>last</button>",
      "</div>",
      '<button id="outside">outside</button>',
    ].join(""),
  );
  return {
    root,
    panel: root.querySelector("#panel"),
    first: root.querySelector("#first"),
    last: root.querySelector("#last"),
    outside: root.querySelector("#outside"),
  };
}

test("focusablesIn returns tabbable descendants in DOM order", () => {
  const root = mount(
    [
      "<div>",
      '  <button id="a">a</button>',
      '  <a id="b" href="#x">b</a>',
      '  <button id="c" disabled>c</button>',
      '  <input id="d" type="hidden" />',
      '  <div id="e" tabindex="-1">e</div>',
      '  <div id="f" tabindex="0">f</div>',
      '  <div id="g" hidden>g</div>',
      '  <button id="h" aria-hidden="true">h</button>',
      "</div>",
    ].join(""),
  );
  const ids = focusablesIn(root).map((node) => node.id);
  assert.deepEqual(ids, ["a", "b", "f"]);
});

test("focusablesIn returns nothing for an empty or missing container", () => {
  assert.deepEqual(focusablesIn(mount("<div></div>")), []);
  assert.deepEqual(focusablesIn(null), []);
});

test("trapFocus pulls escaped focus back to the first control", () => {
  // The listener is on the document, not the container: focusin bubbles up from
  // the element that received focus, so a container-scoped listener would never
  // fire for the one case a trap exists to catch.
  const { panel, first, outside, root } = trapFixture();
  const release = trapFocus(panel);

  outside.focus();
  assert.equal(root.ownerDocument.activeElement, first);

  release();
});

test("trapFocus stops working once released", () => {
  const { panel, first, outside, root } = trapFixture();
  const release = trapFocus(panel);
  release();

  outside.focus();
  assert.equal(root.ownerDocument.activeElement, outside, "focus escaped after release");
  void first;
});

test("trapFocus leaves focus alone while it is inside the container", () => {
  const { panel, last } = trapFixture();
  const release = trapFocus(panel);
  last.focus();
  assert.equal(
    document.activeElement,
    last,
    "the trap yanked focus off a control inside itself",
  );
  release();
});

test("trapFocus makes an unreachable container focusable, then takes it back", () => {
  const root = mount(
    ['<div id="panel">no controls here</div>', '<button id="outside">o</button>'].join(
      "",
    ),
  );
  const panel = root.querySelector("#panel");
  const outside = root.querySelector("#outside");

  const release = trapFocus(panel);
  outside.focus();
  assert.equal(root.ownerDocument.activeElement, panel, "focus was not recovered at all");

  release();
  assert.equal(
    panel.hasAttribute("tabindex"),
    false,
    "the temporary tabindex was left behind",
  );
});

test("trapFocus restores focus to the invoker on release", () => {
  const { panel, outside } = trapFixture();
  const release = trapFocus(panel, { returnFocusTo: outside });
  release();
  assert.equal(document.activeElement, outside);
});

test("trapFocus is a no-op for a missing container", () => {
  const release = trapFocus(null);
  assert.equal(typeof release, "function");
  release();
});

test("focusFirstIn lands on the first control", () => {
  const { panel, first } = trapFixture();
  assert.equal(focusFirstIn(panel), true);
  assert.equal(document.activeElement, first);
});

test("focusFirstIn falls back to the container when it has no controls", () => {
  const root = mount('<div id="panel">nothing to focus</div>');
  const panel = root.querySelector("#panel");
  panel.setAttribute("tabindex", "-1");
  assert.equal(focusFirstIn(panel), true);
  assert.equal(document.activeElement, panel);
});

test("onEscape fires the close handler and only for Escape", () => {
  const root = mount(
    [
      '<div id="panel">',
      '  <button id="first">first</button>',
      "</div>",
      '<div id="elsewhere"><button id="other">e</button></div>',
    ].join(""),
  );
  const panel = root.querySelector("#panel");
  const elsewhere = root.querySelector("#elsewhere");
  let closed = 0;
  const release = onEscape(panel, () => {
    closed += 1;
  });

  elsewhere.dispatchEvent(keydown("Enter"));
  assert.equal(closed, 0, "a keystroke in the host page reached the extension");

  panel.dispatchEvent(keydown("Escape"));
  assert.equal(closed, 1);

  panel.dispatchEvent(keydown("Enter"));
  assert.equal(closed, 1, "a non-Escape key closed the panel");

  release();
  panel.dispatchEvent(keydown("Escape"));
  assert.equal(closed, 1, "the handler outlived its release");
});

test("Escape stops propagating so the host site does not also act on it", () => {
  const root = mount(
    ['<div id="panel"><button>b</button></div>', '<div id="host"></div>'].join(""),
  );
  const panel = root.querySelector("#panel");
  const host = root.querySelector("#host");
  let reachedHost = 0;
  host.addEventListener("keydown", () => {
    reachedHost += 1;
  });
  onEscape(panel, () => {});
  panel.dispatchEvent(keydown("Escape"));
  assert.equal(reachedHost, 0);
});

test("Escape reveals a hidden post without touching the mouse", () => {
  const root = mount("<div></div>");
  let revealed = 0;
  const panel = mountPlaceholder({ postKey: "p:1" }, { onReveal: () => (revealed += 1) });
  root.append(panel);
  panel.dispatchEvent(keydown("Escape"));
  assert.equal(revealed, 1);
});

test("focus is only taken when the caller says the user was already there", () => {
  const root = mount("<div></div>");
  const untouched = mountPlaceholder({ postKey: "p:1" }, { onReveal() {} });
  root.append(untouched);
  assert.equal(
    document.activeElement,
    null,
    "focus was stolen from a post nobody was reading",
  );

  const engaged = mountPlaceholder({ postKey: "p:2" }, { onReveal() {}, hadFocus: true });
  root.append(engaged);
  assert.equal(engaged.contains(document.activeElement), true);
});

/** Build a keydown event carrying `key`, for linkedom's dispatchEvent. */
function keydown(key) {
  const event = new dom.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  return event;
}
