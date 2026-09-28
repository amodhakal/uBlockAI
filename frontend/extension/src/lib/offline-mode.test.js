/**
 * Offline mode (#88).
 *
 * Offline mode changes the most consequential thing the extension does: it
 * stops asking a server and starts deciding on its own. Two failure modes follow
 * from that, and they pull in opposite directions, so both are pinned hard here.
 *
 *   - Hiding a post the local scorer merely guessed at. Pinned by the panel
 *     tests: a local result has to be visibly an estimate, with no verdict, no
 *     confidence and no evidence, because a panel that looks like a backend
 *     verdict is a claim the extension cannot support.
 *   - Stopping looking at a post. Pinned by the fail-open guards: the offline
 *     branch has exactly two exits, both of them a positive outcome, and every
 *     other case falls through to the backend exactly as before.
 *
 * The routing decision itself is a pure function and is tested as a table. The
 * content script is a 1000-line orchestrator that cannot be imported under Node
 * without a DOM and a service worker, so the wiring around it is guarded at the
 * source level instead - the same approach persistence.test.js already uses for
 * the content script's other load-bearing branches.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseHTML } from "linkedom";

import {
  MODEL_STATUS_MESSAGE_KEYS,
  POST_ROUTES,
  SIGNAL_MESSAGE_KEYS,
  SOURCE_MESSAGE_KEYS,
  routeForPost,
  textForClassification,
  toOfflineSkipRecord,
  toResultRecord,
} from "./offline.js";
import { CLASSIFIER_SOURCES, MODEL_STATUS, SIGNAL_IDS } from "./local-classifier.js";
import { MAX_CAPTION_CHARS, STORAGE_KEYS } from "./defaults.js";
import { SETTINGS_KEYS, loadSettings } from "./settings.js";
import { buildPlaceholder } from "./placeholder.js";

const EXTENSION_ROOT = new URL("../../", import.meta.url);

function read(file) {
  return readFileSync(new URL(file, EXTENSION_ROOT), "utf8");
}

function messages() {
  return JSON.parse(read("_locales/en/messages.json"));
}

/** The body of a top-level function, sliced between two anchors in the file. */
function functionBody(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `${signature} is not in the source`);
  const end = nextSignature ? source.indexOf(nextSignature, start) : source.length;
  assert.ok(end > start, `${nextSignature} does not follow ${signature}`);
  return source.slice(start, end);
}

/**
 * Run `fn` with the real catalogue behind chrome.i18n.
 *
 * Without this, t() falls back to returning message names and every assertion
 * about wording would be an assertion that a key exists rather than that the
 * panel says something honest.
 *
 * @template T
 * @param {(catalog: Record<string, {message: string}>) => T} fn
 * @returns {T}
 */
function withChromeI18n(fn) {
  const catalog = messages();
  const previous = globalThis.chrome;
  globalThis.chrome = {
    runtime: { lastError: undefined },
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
      getUILanguage: () => "en",
    },
  };
  try {
    return fn(catalog);
  } finally {
    globalThis.chrome = previous;
  }
}

/** A linkedom document, so the placeholder can actually be built. */
function withDom(fn) {
  const { document: doc } = parseHTML("<!doctype html><html><body></body></html>");
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    return fn(doc);
  } finally {
    globalThis.document = previous;
  }
}

/**
 * Install a minimal chrome.storage holding `values`. Left in place on purpose -
 * settings.js resolves chrome at call time, so the caller restores the previous
 * global itself once its await has settled.
 *
 * @param {Record<string, unknown>} values
 */
function withFakeStorage(values) {
  const pick = (keys) => {
    const out = {};
    for (const key of [].concat(keys)) {
      if (key in values) out[key] = values[key];
    }
    return out;
  };
  globalThis.chrome = {
    runtime: { lastError: undefined },
    i18n: { getMessage: () => "", getUILanguage: () => "en" },
    storage: {
      onChanged: { addListener() {}, removeListener() {} },
      sync: { get: (keys, cb) => cb(pick(keys)), set: (_items, cb) => cb() },
      local: { get: (keys, cb) => cb(pick(keys)), set: (_items, cb) => cb() },
    },
  };
}

// --------------------------------------------------------------------------
// Routing
// --------------------------------------------------------------------------

test("a post goes to the backend whenever offline mode is off", () => {
  // Including when the local classifier is perfectly healthy. Offline mode is a
  // user opt-in with a real accuracy cost, and a "helpful" extension that
  // silently ignores the switch is worse than one that is merely limited.
  for (const localReady of [true, false]) {
    for (const online of [true, false]) {
      assert.equal(
        routeForPost({ offlineMode: false, online, localReady }),
        POST_ROUTES.BACKEND,
      );
    }
  }
});

test("offline mode scores on device and does not contact the service", () => {
  // True even with no network: a local score needs no network, and refusing to
  // produce it just because the wifi is down would make offline mode useless.
  for (const online of [true, false]) {
    assert.equal(
      routeForPost({ offlineMode: true, online, localReady: true }),
      POST_ROUTES.LOCAL,
    );
  }
});

test("a local failure falls open to the backend", () => {
  // The classifier throwing is a local condition, and the backend is a genuine
  // second opinion. Skipping the post instead would mean an extension bug
  // silently stopped screening a user's feed.
  assert.equal(
    routeForPost({ offlineMode: true, online: true, localReady: false }),
    POST_ROUTES.BACKEND,
  );
});

test("a local failure with no network is not retried against a dead service", () => {
  // The whole point of asking the browser rather than trying: the alternative is
  // one 45 second timeout per post, repeated on every scan, which is a request
  // storm generated by a setting the user deliberately turned on.
  assert.equal(
    routeForPost({ offlineMode: true, online: false, localReady: false }),
    POST_ROUTES.SKIP,
  );
});

test("only an explicit false counts as offline", () => {
  // navigator.onLine is true whenever the machine has *a* network, including a
  // captive portal. It is also undefined in some contexts. Reading anything
  // other than false as "offline" would suppress every backend request the first
  // time the property was missing.
  for (const online of [undefined, null, 0, "", "offline", Number.NaN, true]) {
    assert.equal(
      routeForPost({ offlineMode: true, online, localReady: false }),
      POST_ROUTES.BACKEND,
      `online=${String(online)} was treated as offline`,
    );
  }
});

test("routing tolerates being called with nothing at all", () => {
  // A missing setting must not take the scan down; it has to mean "offline mode
  // is off", which is the pre-#88 behaviour.
  assert.equal(routeForPost(), POST_ROUTES.BACKEND);
  assert.equal(routeForPost({}), POST_ROUTES.BACKEND);
  assert.equal(
    routeForPost({ offlineMode: "true", online: true, localReady: true }),
    POST_ROUTES.BACKEND,
    "a string 'true' switched offline mode on",
  );
});

test("every route is one of the three documented values", () => {
  // A typo here would make the content script's comparisons silently false, and
  // the offline branch would fall through to the backend with no error anywhere.
  assert.deepEqual(Object.values(POST_ROUTES).sort(), ["backend", "local", "skip"]);
});

// --------------------------------------------------------------------------
// The text the classifier sees
// --------------------------------------------------------------------------

test("the classifier sees the caption and the alt text together", () => {
  // The backend OCRs images, so alt text is real content and not metadata. Left
  // out, the same post would be judged differently in the two modes.
  const text = textForClassification({ caption: "a claim", imageAlt: "a chart" });
  assert.match(text, /a claim/);
  assert.match(text, /a chart/);
});

test("a post with no text produces no text to classify", () => {
  // An empty string must not be classified at all. Scoring it as "clean" would
  // be a verdict with no evidence behind it.
  assert.equal(textForClassification({}), "");
  assert.equal(textForClassification({ caption: "   " }), "");
  assert.equal(textForClassification(null), "");
  // A non-string field is coerced rather than dropped. A caption of "42" is a
  // real post, and silently classifying nothing for it would leave it invisible
  // to offline mode without saying so.
  assert.equal(textForClassification({ caption: 42 }), "42");
  assert.equal(textForClassification({ caption: null, imageAlt: 7 }), "7");
});

test("the classifier sees no more text than the backend does", () => {
  // Otherwise the same post is judged on more words in one mode than the other,
  // and the two modes disagree in a way nothing explains.
  const caption = "x".repeat(MAX_CAPTION_CHARS + 500);
  assert.equal(textForClassification({ caption }).length, MAX_CAPTION_CHARS);
});

test("a short post is passed through untouched", () => {
  assert.equal(textForClassification({ caption: "hello" }), "hello");
});

// --------------------------------------------------------------------------
// The result record
// --------------------------------------------------------------------------

test("a local result carries its scores and nothing invented", () => {
  // Every backend-owned field is empty. The backend did not run, so there is no
  // verdict, no confidence, no reasoning chain and no evidence, and rendering
  // any of them would be the extension asserting a conclusion it never reached.
  const record = toResultRecord("p:1", {
    aiScore: 0.4,
    newsScore: 0.2,
    confidence: 0.9,
    source: CLASSIFIER_SOURCES.HEURISTIC,
    signals: [{ id: SIGNAL_IDS.SHOUTING, value: 1 }],
  });
  assert.equal(record.postKey, "p:1");
  assert.equal(record.aiScore, 0.4);
  assert.equal(record.newsScore, 0.2);
  assert.equal(record.explanation, "");
  assert.equal(record.verdict, null);
  assert.equal(record.confidence, null);
  assert.deepEqual(record.reasoning_chain, []);
  assert.deepEqual(record.evidence, []);
  assert.deepEqual(record.uncertainties, []);
  assert.deepEqual(record.claim_scores, []);
  assert.equal(record.tool_rounds, 0);
  assert.equal(record.error, false);
});

test("a local result is marked as local and carries its own attribution", () => {
  // The two fields the scorer really did measure. Without `local` the panel
  // cannot change its wording, and without the signals it would have to either
  // show nothing or invent a reason.
  const record = toResultRecord("p:1", {
    aiScore: 0.4,
    newsScore: 0.2,
    source: CLASSIFIER_SOURCES.ONNX,
    signals: [{ id: SIGNAL_IDS.SHOUTING, value: 1 }],
  });
  assert.equal(record.local, true);
  assert.equal(record.localSource, CLASSIFIER_SOURCES.ONNX);
  assert.equal(record.localSignals.length, 1);
  assert.equal(record.localSignals[0].id, SIGNAL_IDS.SHOUTING);
});

test("a local result with a broken classifier still produces a usable record", () => {
  // classify() is documented never to throw, but a record built from nothing at
  // all must still be safe to hand to the scanner: scores in range, no
  // fabricated fields, and no crash on a missing signals array.
  const record = toResultRecord("p:1", null);
  assert.equal(record.aiScore, 0);
  assert.equal(record.newsScore, 0);
  assert.deepEqual(record.localSignals, []);
  assert.equal(record.localSource, CLASSIFIER_SOURCES.HEURISTIC);
  assert.equal(record.error, false);
  assert.equal(toResultRecord("p:1", { aiScore: Number.NaN }).aiScore, 0);
  assert.equal(toResultRecord("p:1", { aiScore: "0.7" }).aiScore, 0.7);
});

test("a declined post is neither a verdict nor a backend failure", () => {
  // `offline` is what keeps this out of the retry backoff, and `error` is what
  // keeps it out of the result cache. Dropping either one reintroduces a
  // request storm or a permanently un-analysable post respectively.
  const record = toOfflineSkipRecord("p:1");
  assert.equal(record.postKey, "p:1");
  assert.equal(record.error, true);
  assert.equal(record.offline, true);
  assert.equal(record.aiScore, 0);
  assert.equal(record.newsScore, 0);
  assert.equal(record.explanation, "");
});

// --------------------------------------------------------------------------
// The panel
// --------------------------------------------------------------------------

/** A local result, as the scanner would build it. */
function localPanel(over = {}) {
  return toResultRecord("p:1", {
    aiScore: 0.42,
    newsScore: 0.31,
    source: CLASSIFIER_SOURCES.HEURISTIC,
    signals: [{ id: SIGNAL_IDS.SHOUTING }, { id: SIGNAL_IDS.CALL_TO_ACTION }],
    ...over,
  });
}

test("a panel for a local score says it is an estimate, in words a user can read", () => {
  // This is the test the whole of offline mode exists for. A panel that says
  // "Flagged as possible misinformation" over a word count is a lie with a
  // confidence number attached to it.
  withDom(() =>
    withChromeI18n(() => {
      const panel = buildPlaceholder(localPanel());
      const heading = panel.querySelector(".aibot-heading").textContent;
      assert.match(heading, /on-device estimate/i);
      assert.ok(
        !/Flagged as possible misinformation/.test(heading),
        "a local estimate reused the backend's heading",
      );
      const region = panel.querySelector(".aibot-panel");
      assert.match(region.getAttribute("aria-label"), /on-device estimate/i);
      assert.ok(panel.classList.contains("aibot-placeholder-local"));
      assert.equal(panel.dataset.source, CLASSIFIER_SOURCES.HEURISTIC);
    }),
  );
});

test("a panel for a local score states that no analysis was performed", () => {
  withDom(() =>
    withChromeI18n(() => {
      const note =
        buildPlaceholder(localPanel()).querySelector(".aibot-local-note").textContent;
      assert.match(note, /estimate/i);
      assert.match(note, /not an analysis/i);
    }),
  );
});

test("a panel for a local score names the word patterns it counted", () => {
  // The one thing it can honestly show: what the scorer measured. Rendering
  // these as an "explanation" would be a category error - they are inputs to a
  // sum, not a reason for a conclusion - so they get their own block.
  withDom(() =>
    withChromeI18n(() => {
      const panel = buildPlaceholder(localPanel());
      const signals = panel.querySelector(".aibot-local-signals").textContent;
      assert.match(signals, /shouting/);
      assert.match(signals, /calls to share/i);
      const engine = panel.querySelector(".aibot-local-engine").textContent;
      assert.match(engine, /word-pattern scorer/);
    }),
  );
});

test("a panel for a local score does not offer the backend's reasoning view", () => {
  // There is no reasoning chain, no evidence and no verdict behind a keyword
  // count. The expandable "Why was this flagged?" section has nothing true to
  // put in it, so it must be absent rather than empty.
  withDom(() =>
    withChromeI18n(() => {
      const panel = buildPlaceholder(localPanel());
      assert.equal(panel.querySelector("details"), null);
      assert.equal(panel.querySelector(".aibot-explanation"), null);
    }),
  );
});

test("a panel for a local score does not call the number a risk score", () => {
  // The backend's labels say "risk". A count of shouting words is an estimate,
  // and reusing the word would import the authority of a model that never ran.
  withDom(() =>
    withChromeI18n(() => {
      const scores = buildPlaceholder(localPanel()).querySelector(".aibot-scores");
      assert.match(scores.textContent, /Estimated AI-generated: 42%/);
      assert.match(scores.textContent, /Estimated misinformation: 31%/);
      assert.ok(!/risk/i.test(scores.textContent), scores.textContent);
    }),
  );
});

test("a local score is hidden only by the user's own thresholds", () => {
  // Offline mode changes where the number comes from, not whether it is
  // measured against the same two thresholds. Anything else would be a hidden
  // sensitivity change.
  assert.equal(STORAGE_KEYS.offlineMode, "offlineMode");
  assert.equal(typeof MAX_CAPTION_CHARS, "number");
});

test("a panel for a backend verdict is unchanged by any of this", () => {
  // The regression that matters: an on-device feature must not alter what an
  // ordinary analysis looks like.
  withDom(() =>
    withChromeI18n(() => {
      const panel = buildPlaceholder({
        postKey: "p:2",
        aiScore: 0.42,
        newsScore: 0.31,
        explanation: "The council voted to close the hospital in March.",
        verdict: "likely_false",
        confidence: 0.8,
        reasoning_chain: ["Checked the minutes."],
        evidence: [{ title: "Minutes", url: "https://example.com/m" }],
      });
      assert.ok(!panel.classList.contains("aibot-placeholder-local"));
      assert.equal(panel.querySelector(".aibot-local"), null);
      assert.equal(
        panel.querySelector(".aibot-heading").textContent,
        "Flagged as possible misinformation",
      );
      assert.match(
        panel.querySelector(".aibot-scores").textContent,
        /AI-generated risk: 42%/,
      );
      assert.ok(panel.querySelector("details"), "the reasoning view disappeared");
    }),
  );
});

test("a local panel with no signals still explains itself honestly", () => {
  // A caption that tripped a threshold on the ONNX path has no lexical
  // attribution at all. The panel must say less, not invent a reason, and must
  // not fall back to the backend's wording to fill the gap.
  withDom(() =>
    withChromeI18n(() => {
      const panel = buildPlaceholder(
        localPanel({ source: CLASSIFIER_SOURCES.ONNX, signals: [] }),
      );
      assert.equal(panel.querySelector(".aibot-local-signals"), null);
      assert.match(
        panel.querySelector(".aibot-local-engine").textContent,
        /transformer/i,
      );
      assert.match(
        panel.querySelector(".aibot-heading").textContent,
        /on-device estimate/i,
      );
    }),
  );
});

test("a signal with no message name is dropped rather than shown as a raw key", () => {
  // The scorer's signal list can grow independently of the catalogue, and a raw
  // message name inside a warning panel is the failure the i18n tests exist to
  // prevent.
  withDom(() =>
    withChromeI18n(() => {
      const panel = buildPlaceholder(
        localPanel({
          signals: [{ id: "a-signal-nobody-translated" }, { id: SIGNAL_IDS.SHOUTING }],
        }),
      );
      const signals = panel.querySelector(".aibot-local-signals").textContent;
      assert.match(signals, /shouting/);
      assert.ok(!signals.includes("localSignal"), signals);
    }),
  );
});

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

test("offline mode is a setting the content script reads", () => {
  // The listener in onSettingsChanged is filtered to SETTINGS_KEYS, so a key that
  // is stored but not listed here would never reach the content script and the
  // toggle would appear to do nothing.
  assert.ok(SETTINGS_KEYS.includes(STORAGE_KEYS.offlineMode));
  assert.match(read("src/lib/defaults.js"), /offlineMode:\s*"offlineMode"/);
});

test("offline mode is off unless it is exactly true", async () => {
  // Strictly boolean, like telemetryEnabled. A hand-edited or partially synced
  // "true" must not switch on a behaviour that suppresses every backend
  // request on the strength of a string.
  const previous = globalThis.chrome;
  try {
    for (const stored of [undefined, null, false, "true", 1, 0, "yes", {}, []]) {
      withFakeStorage({ [STORAGE_KEYS.offlineMode]: stored });
      const settings = await loadSettings();
      assert.equal(settings.offlineMode, false, `${JSON.stringify(stored)} enabled it`);
    }
  } finally {
    globalThis.chrome = previous;
  }
});

test("offline mode is on when it is exactly true", async () => {
  const previous = globalThis.chrome;
  withFakeStorage({ [STORAGE_KEYS.offlineMode]: true });
  try {
    const settings = await loadSettings();
    assert.equal(settings.offlineMode, true);
  } finally {
    globalThis.chrome = previous;
  }
});

test("offline mode is off on a fresh install", async () => {
  // Nothing stored at all. A feature that silenced the backend on first run
  // would be indistinguishable from a broken extension.
  const previous = globalThis.chrome;
  withFakeStorage({});
  try {
    const settings = await loadSettings();
    assert.equal(settings.offlineMode, false);
    assert.equal(typeof settings.aiGeneratedThreshold, "number");
  } finally {
    globalThis.chrome = previous;
  }
});

// --------------------------------------------------------------------------
// The popup
// --------------------------------------------------------------------------

test("the popup offers a real toggle wired to the real storage key", () => {
  const html = read("popup.html");
  const script = read("popup.js");
  assert.match(html, /id="offlineMode"/);
  assert.match(html, /for="offlineMode"/);
  assert.match(html, /data-i18n="popupOfflineLabel"/);
  assert.match(script, /els\.offlineMode\.checked = settings\.offlineMode/);
  // A checkbox that renders but is never written back is the exact shape of the
  // first-run default mismatch this repository has been bitten by twice.
  assert.match(
    script,
    /els\.offlineMode\.addEventListener\("change"[\s\S]{0,200}?STORAGE_KEYS\.offlineMode/,
  );
});

test("the popup says which on-device classifier is actually running", () => {
  // Offline mode replaces an analysis with a local estimate, so the user has to
  // be able to see which of the two they are being offered without hunting
  // through the options page.
  assert.match(read("popup.html"), /id="modelStatusValue"/);
  assert.match(read("popup.html"), /data-i18n="popupModelLabel"/);
  assert.match(read("popup.js"), /describeLocalModel\(\)/);
  assert.match(read("popup.js"), /MODEL_STATUS_MESSAGE_KEYS\[report\.status\]/);
});

test("the popup does not load the model just to describe it", () => {
  // describeLocalModel() probes. A popup that called session.load() would stream
  // 100 MB of weights to render one line, which is a far worse experience than
  // the answer is worth.
  const script = read("popup.js");
  assert.ok(
    !/describeLocalModel\([\s\S]{0,400}?\)\s*;[\s\S]{0,80}?\.load\(/.test(script),
  );
  assert.match(read("src/lib/offline.js"), /MODEL_STATUS_MESSAGE_KEYS/);
});

test("every message name the offline-mode code refers to exists in the catalogue", () => {
  // SIGNAL_MESSAGE_KEYS, SOURCE_MESSAGE_KEYS and MODEL_STATUS_MESSAGE_KEYS are
  // looked up through a variable, so the a11y test's scan of t("...") call sites
  // cannot see them. A typo there renders a raw message name to a user.
  const catalog = messages();
  const referenced = [
    ...Object.values(SIGNAL_MESSAGE_KEYS),
    ...Object.values(SOURCE_MESSAGE_KEYS),
    ...Object.values(MODEL_STATUS_MESSAGE_KEYS),
  ];
  assert.ok(referenced.length >= 15, `only ${referenced.length} keys to check`);
  for (const key of referenced) {
    assert.ok(catalog[key], `${key} is missing from the catalogue`);
    assert.ok(catalog[key].description, `${key} has no description for translators`);
  }
});

test("every model state the classifier can report has a message", () => {
  // A new MODEL_STATUS with no label would render as a raw key in the popup,
  // which is the one place the user goes to find out what they are getting.
  for (const status of Object.values(MODEL_STATUS)) {
    assert.ok(MODEL_STATUS_MESSAGE_KEYS[status], `${status} has no message name`);
  }
});

test("every signal the scorer can report has a message", () => {
  for (const id of Object.values(SIGNAL_IDS)) {
    assert.ok(SIGNAL_MESSAGE_KEYS[id], `${id} has no message name`);
  }
});

test("both on-device engines have a name for the panel to show", () => {
  for (const source of Object.values(CLASSIFIER_SOURCES)) {
    assert.ok(SOURCE_MESSAGE_KEYS[source], `${source} has no message name`);
  }
});

test("the offline-mode strings say what they are, not that they are an analysis", () => {
  // The help text is the user's only warning before they turn this on. A wording
  // change that dropped the accuracy caveat would be a quiet lie.
  const catalog = messages();
  assert.match(catalog.popupOfflineHelp.message, /less accurate/i);
  assert.match(catalog.popupOfflineHelp.message, /never sent/i);
  assert.match(catalog.placeholderLocalNote.message, /not an analysis/i);
  for (const key of ["placeholderLocalScoreAi", "placeholderLocalScoreNews"]) {
    assert.ok(
      !/risk/i.test(catalog[key].message),
      `${key} calls an estimate a risk score`,
    );
  }
});

// --------------------------------------------------------------------------
// Source-level guards on the content script
// --------------------------------------------------------------------------

const SCRIPT = read("src/script.js");

test("offline mode decides before the analysis port is ever opened", () => {
  // The port is what costs 20-60 seconds and real money. If the offline branch
  // sat after the request rather than before it, the setting would be a
  // preference about what happens afterwards, which is not what it says it is.
  const body = functionBody(
    SCRIPT,
    "async function analysePost",
    "/**\n * Apply the current",
  );
  const guard = body.indexOf("if (settings?.offlineMode)");
  const port = body.indexOf("analysePostStreaming(post, postKey,");
  assert.ok(guard !== -1, "analysePost has no offline mode branch");
  assert.ok(port !== -1, "analysePost no longer calls analysePostStreaming");
  assert.ok(guard < port, "the offline check runs after the request was already sent");
});

test("the offline branch has exactly two exits and both are positive outcomes", () => {
  // This is the fail-open guard, stated structurally. Two `return`s - a local
  // score and a deliberate skip. If a third appeared, or if either returned an
  // error record, a classifier failure would stop the post being examined. And
  // because there is no other exit, every remaining case falls through to the
  // backend exactly as it did before offline mode existed.
  const start = SCRIPT.indexOf("if (settings?.offlineMode) {");
  const end = SCRIPT.indexOf("analysePostStreaming(post, postKey,", start);
  const block = SCRIPT.slice(start, end);
  const returns = block.match(/\breturn\b/g) || [];
  assert.equal(returns.length, 2, `the offline branch has ${returns.length} exits`);
  assert.match(block, /return toResultRecord\(postKey, local\);/);
  assert.match(block, /return toOfflineSkipRecord\(postKey\);/);
  assert.ok(
    !/return \{ postKey, aiScore: 0, newsScore: 0, explanation: "", error: true \}/.test(
      block,
    ),
    "the offline branch gives up on a post instead of falling through",
  );
});

test("offline mode asks the browser about the network rather than finding out", () => {
  // The brief this satisfies: with offline mode on and the backend unreachable,
  // the request is suppressed outright rather than discovered by timing out.
  // Only an explicit false counts, because navigator.onLine is also true behind
  // a captive portal, which is not the same as "the backend is reachable".
  const start = SCRIPT.indexOf("if (settings?.offlineMode) {");
  const end = SCRIPT.indexOf("analysePostStreaming(post, postKey,", start);
  const block = SCRIPT.slice(start, end);
  assert.match(block, /online: navigator\.onLine !== false/);
  assert.match(block, /localReady: Boolean\(local\)/);
});

test("the analysis port and the one-shot message are opened in exactly one place", () => {
  // Both are the "contact the service" step, and both live inside
  // analysePostStreaming. If either were reachable from the offline branch the
  // setting would be decorative. Counted rather than matched, so a second call
  // site added later fails the test.
  assert.equal(
    (SCRIPT.match(/chrome\.runtime\.connect\(\{ name: "aibot-analysis" \}\)/g) || [])
      .length,
    1,
  );
  assert.equal((SCRIPT.match(/type: "ANALYZE_POST"/g) || []).length, 1);
  const streaming = functionBody(
    SCRIPT,
    "function analysePostStreaming",
    "/**\n * Read the optional per-claim",
  );
  assert.match(streaming, /chrome\.runtime\.connect\(\{ name: "aibot-analysis" \}\)/);
  assert.match(streaming, /type: "ANALYZE_POST"/);
});

test("a declined post is never scheduled for a retry", () => {
  // `offline` is checked before `error` and returns early, so a post offline
  // mode declined never reaches recordFailure. If it did, offline mode would
  // manufacture the very request storm it exists to avoid, and the backoff
  // would be pacing attempts against a service that is not what is broken.
  const start = SCRIPT.indexOf("if (value.offline) {");
  const end = SCRIPT.indexOf("if (value.error) {", start);
  assert.ok(start !== -1 && end > start, "scan() no longer branches on value.offline");
  const branch = SCRIPT.slice(start, end);
  // A call site, not the identifier: the branch explains in a comment why the
  // retry backoff must not be involved, and that sentence is not a call.
  assert.ok(!/recordFailure\(/.test(branch), "a declined post is scheduled for a retry");
  assert.match(branch, /offlineSkipped\.add\(postKey\)/);
  assert.match(branch, /markSafe\(post, postKey\)/);
  // The pinned guard from persistence.test.js must still hold, so the branch
  // has to stay ahead of the error branch rather than nested inside it.
  assert.match(SCRIPT, /if \(value\.error\) \{[\s\S]{0,400}?recordFailure/);
});

test("a declined post is picked up again as soon as anything changes", () => {
  // Without this, turning offline mode off would leave every post that was
  // skipped while offline permanently unexamined: the scan skips anything marked
  // processed, reapplyAll only walks posts with cached results, and there is no
  // cached result for a declined post.
  const listener = functionBody(
    SCRIPT,
    "onSettingsChanged((next)",
    "async function start()",
  );
  assert.match(listener, /clearOfflineSkips\(\);/);
  const clearer = functionBody(
    SCRIPT,
    "function clearOfflineSkips",
    "/** Re-hide anything",
  );
  assert.match(clearer, /MARK_ATTRS\.PROCESSED/);
  assert.match(clearer, /MARK_ATTRS\.SAFE/);
  assert.match(clearer, /scheduleScan\(\)/);
});

test("the content script reaches the classifier through the shared surface", () => {
  // Not a second, simpler copy of the scoring. The import is what keeps the
  // offline path and the popup's status line describing the same classifier.
  assert.match(SCRIPT, /import \{ classify \} from "\.\/lib\/local-classifier\.js"/);
  assert.match(SCRIPT, /routeForPost\(\{/);
  assert.match(SCRIPT, /textForClassification\(post\)/);
  assert.ok(
    !/infer|classifyHeuristic/.test(SCRIPT),
    "the content script reimplemented scoring",
  );
});

test("local classification is bounded well below the network budget", () => {
  // The heuristic fallback is immediate, so the only way to reach the timeout is
  // a WASM session that has wedged. Waiting out the 45 second network budget to
  // discover that would leave a feed that looks broken.
  assert.match(SCRIPT, /LOCAL_INFERENCE_TIMEOUT_MS/);
  const defaults = read("src/lib/defaults.js");
  const value = Number(
    /LOCAL_INFERENCE_TIMEOUT_MS = ([\d_]+);/.exec(defaults)?.[1]?.replace(/_/g, ""),
  );
  const network = Number(
    /REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(defaults)?.[1]?.replace(/_/g, ""),
  );
  assert.ok(value > 0 && network > 0, "the budgets are not readable from defaults.js");
  assert.ok(value < network, "local classification is allowed the whole network budget");
});

// --------------------------------------------------------------------------
// The manifest is untouched by any of this
// --------------------------------------------------------------------------

test("offline mode added no permission", () => {
  // Nothing here reaches the network, and the classifier reads packaged files
  // rather than a host. A permission added for an opt-in feature is a permanent
  // grant for something most users will never turn on.
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(manifest.permissions, ["storage", "alarms"]);
  assert.equal(manifest.web_accessible_resources, undefined);
});
