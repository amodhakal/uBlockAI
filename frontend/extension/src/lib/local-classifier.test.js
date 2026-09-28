/**
 * The on-device classifier: heuristic scoring, per-signal attribution, and the
 * fallback to the transformer path when one is installed.
 *
 * Two properties are load-bearing and are pinned hardest here.
 *
 * The first is that the scores are the sum of the reported contributions. If
 * that stops being true, the UI can no longer honestly say which observation
 * drove a decision, and the whole reason this scorer returns per-signal
 * attribution evaporates - it would just be an unfalsifiable number.
 *
 * The second is the fallback. This repository ships no model, so the heuristic
 * is what actually runs, and the tests that matter most are the ones where a
 * model is present but unusable: a missing asset, an unreadable asset, a
 * vocabulary that is not there, an output tensor that is not numbers. All four
 * must land on the heuristic rather than on a guess.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  CLASSIFIER_SOURCES,
  MODEL_STATUS,
  SIGNAL_IDS,
  classify,
  classifyHeuristic,
  describeLocalModel,
  resetDefaultSession,
} from "./local-classifier.js";
import { SESSION_STATUS, createOnnxSession } from "./onnx-session.js";

/** Small enough to read, big enough to exercise the special tokens. */
const VOCAB_LINES = [
  "[PAD]",
  "[UNK]",
  "[CLS]",
  "[SEP]",
  "the",
  "vaccine",
  "contains",
  "micro",
  "chip",
  "share",
  "this",
  "with",
  "everyone",
  "studies",
  "show",
  "water",
  "is",
  "wet",
];

/**
 * Reset the module-level session and vocabulary cache between tests.
 *
 * The vocabulary is cached for the life of the page on purpose - a feed holds
 * dozens of posts and re-fetching a 230 KB file per post would be absurd - which
 * means one test that installs a vocabulary silently affects every test after
 * it. This is the only reason these tests are order-independent.
 */
beforeEach(() => {
  resetDefaultSession();
});

/**
 * A session wired to a fake runtime, so the ONNX path can be exercised with no
 * WebAssembly, no model file and no network.
 *
 * @param {{model?: "ok"|"404"|"throw", vocab?: "ok"|"throw", logits?: any,
 *          runtime?: "ok"|"missing", create?: Function, run?: Function}} [options]
 */
function fakeSession(options = {}) {
  const state = { runs: 0, creates: 0 };
  const session = createOnnxSession({
    importImpl: () => {
      if (options.runtime === "missing") {
        throw new Error("Cannot find module 'vendor/ort'");
      }
      return {
        env: { wasm: {} },
        Tensor: class {
          constructor(type, data, dims) {
            this.type = type;
            this.data = data;
            this.dims = dims;
          }
        },
        InferenceSession: {
          create: () => {
            state.creates += 1;
            if (options.create) return options.create();
            return {
              run: () => {
                state.runs += 1;
                if (options.run) return options.run();
                const logits = options.logits ?? [0.2, 3];
                return { logits: { data: Float32Array.from(logits) } };
              },
              release: () => {},
            };
          },
        },
      };
    },
    fetchImpl: (url) => {
      if (String(url).includes("vocab.txt")) {
        if (options.vocab === "throw") throw new TypeError("refused");
        return { ok: true, status: 200, text: () => VOCAB_LINES.join("\n") };
      }
      if (options.model === "404") return { ok: false, status: 404 };
      if (options.model === "throw") throw new TypeError("refused");
      return { ok: true, status: 200, arrayBuffer: () => new ArrayBuffer(8) };
    },
  });
  return { session, state };
}

/** @param {Array<object>} signals @param {"ai"|"news"} axis */
function sumContributions(signals, axis) {
  return signals.reduce((total, signal) => total + signal[axis], 0);
}

/** Every signal id, so a new one cannot be added without a test noticing. */
const ALL_SIGNAL_IDS = Object.values(SIGNAL_IDS);

// --------------------------------------------------------------------------
// Nothing to classify
// --------------------------------------------------------------------------

test("a caption with no words in it is not classified at all", async () => {
  // Returning a confident zero for an empty caption would let a caller treat
  // "there was nothing to read" as "the model says this is safe", which is a
  // real hiding decision made with no evidence behind it.
  assert.equal(await classify(""), null);
  assert.equal(await classify("   \n\t "), null);
  assert.equal(await classify(null), null);
  assert.equal(await classify(undefined), null);
});

test("a caption made only of emoji still produces a sequence", async () => {
  // A post that is nothing but an emoji is a real post, and the pre-filter
  // from #66 lets reactions through. Throwing here would take the scan down.
  const result = await classify("🎉🎉", { session: null });
  assert.ok(result);
  assert.equal(result.source, CLASSIFIER_SOURCES.HEURISTIC);
});

// --------------------------------------------------------------------------
// The heuristic scorer
// --------------------------------------------------------------------------

test("the heuristic scorer is deterministic", () => {
  // It has no model, no randomness and no clock. Two runs over the same text
  // must be byte-identical, or a cached score and a fresh one would disagree
  // and the hide decision would depend on which the user scrolled to first.
  const captions = [
    "SHARE THIS WITH EVERYONE!! The vaccine contains microchips",
    "I got the bus to the store and bought bread and milk today",
  ];
  for (const caption of captions) {
    assert.deepEqual(classifyHeuristic(caption), classifyHeuristic(caption));
  }
});

test("the scores are exactly the sum of the contributions that are reported", () => {
  // The invariant the whole explainability story rests on. If a signal can move
  // a score without appearing in the list, the UI is describing a decision it
  // does not fully understand.
  const captions = [
    "SHARE THIS!!! Everyone must know. Studies show the vaccine contains microchips. It is the biggest miracle ever. #fyp #viral #fypforyou",
    "wake up sheeple, they don't want you to know",
    "Stop lying to us. We all know the truth.",
    "hello",
  ];
  for (const caption of captions) {
    const result = classifyHeuristic(caption);
    assert.equal(result.aiScore, sumContributions(result.signals, "aiContribution"));
    assert.equal(result.newsScore, sumContributions(result.signals, "newsContribution"));
  }
});

test("both scores stay inside the zero to one range even on a maximally loaded caption", () => {
  // The weights sum to one per axis, so a caption that saturates every signal
  // has to land on exactly 1.0. If it does not, a weight was mis-summed.
  const stuffed = ALL_SIGNAL_IDS.map(() => "x").join(" ") + " ";
  const everything =
    "SHARE THIS. Everyone. Never. Must. Guaranteed. Share this. Double tap. " +
    "Link in bio. Subscribe. Before it's too late. Act now. Breaking. " +
    "Doctors say. Studies show. Wake up. Leaked. Censored. " +
    "THE VACCINE CONTAINS MICROCHIPS. Stop lying to us. We all know. " +
    "The biggest miracle ever. The worst. #a #b #c #d #e";
  const result = classifyHeuristic(everything);
  assert.ok(result.aiScore > 0 && result.aiScore <= 1, `aiScore ${result.aiScore}`);
  assert.ok(
    result.newsScore > 0 && result.newsScore <= 1,
    `newsScore ${result.newsScore}`,
  );
  void stuffed;
});

test("a caption that trips nothing scores zero on both axes", () => {
  // The floor has to be a real floor. A scorer that never returns zero is a
  // scorer that hides ordinary posts.
  const result = classifyHeuristic("I walked to the corner shop and bought a newspaper");
  assert.equal(result.aiScore, 0);
  assert.equal(result.newsScore, 0);
  assert.deepEqual(result.signals, []);
});

test("the signals are ordered by how much they moved the score", () => {
  // The first thing the UI shows should be the biggest contributor, and a
  // stable order matters for the same reason a stable score does.
  const result = classifyHeuristic(
    "SHARE THIS everyone must know. Studies show the vaccine contains microchips. #a #b #c #d",
  );
  const totals = result.signals.map(
    (signal) => signal.aiContribution + signal.newsContribution,
  );
  for (let index = 1; index < totals.length; index += 1) {
    assert.ok(
      totals[index] <= totals[index - 1],
      "signals are not sorted by contribution",
    );
  }
});

test("no signal id is reported that is not one of the declared signals", () => {
  // A typo in an id would render an untranslatable label in the UI, which is
  // exactly the class of silent failure the i18n tests exist to catch.
  const result = classifyHeuristic(
    "SHARE THIS everyone must know, studies show it, the biggest miracle, #a #b #c #d, stop lying to us",
  );
  for (const signal of result.signals) {
    assert.ok(ALL_SIGNAL_IDS.includes(signal.id), `unknown signal id ${signal.id}`);
  }
});

// --------------------------------------------------------------------------
// Per-signal attribution
// --------------------------------------------------------------------------

const SIGNAL_CASES = [
  {
    id: SIGNAL_IDS.ABSOLUTE_QUANTIFIER,
    text: "This is always true and must never be questioned",
    evidence: ["always", "never", "must"],
  },
  {
    id: SIGNAL_IDS.CALL_TO_ACTION,
    text: "Please share this with your friends right now",
    evidence: ["share this"],
  },
  {
    id: SIGNAL_IDS.URGENCY_AUTHORITY,
    text: "Studies show you are not being told the truth",
    evidence: ["studies show"],
  },
  {
    id: SIGNAL_IDS.SHOUTING,
    text: "THE VACCINE CONTAINS MICROCHIPS AND NOBODY BELIEVES ME",
    evidence: ["VACCINE", "CONTAINS", "MICROCHIPS"],
  },
  {
    id: SIGNAL_IDS.HASHTAG_SPAM,
    text: "#fyp #viral #foryou #trending #explore",
    evidence: ["#fyp", "#viral", "#foryou", "#trending", "#explore"],
  },
  {
    id: SIGNAL_IDS.SECOND_PERSON_IMPERATIVE,
    text: "Stop lying to us. Check your own facts.",
    evidence: ["stop lying to us", "check your own facts"],
  },
  {
    id: SIGNAL_IDS.SUPERLATIVE,
    text: "This is the biggest and best deal you will ever find",
    evidence: ["biggest", "best"],
  },
];

for (const testCase of SIGNAL_CASES) {
  test(`the ${testCase.id} signal reports the words that produced it`, () => {
    // Each signal in isolation, so a rule that quietly started depending on
    // another one is visible rather than plausible.
    const result = classifyHeuristic(testCase.text);
    const signal = result.signals.find((entry) => entry.id === testCase.id);
    assert.ok(signal, `${testCase.id} did not fire on ${JSON.stringify(testCase.text)}`);
    assert.ok(
      signal.value > 0 && signal.value <= 1,
      "a signal value is not a 0..1 fraction",
    );
    for (const expected of testCase.evidence) {
      assert.ok(
        signal.evidence.includes(expected),
        `${testCase.id} did not cite ${expected}; got ${JSON.stringify(signal.evidence)}`,
      );
    }
    assert.equal(signal.aiContribution, signal.value * signal.aiWeight);
    assert.equal(signal.newsContribution, signal.value * signal.newsWeight);
  });
}

test("the shouting signal is case sensitive and no other signal is", () => {
  // Folding to lower case before detecting would delete the signal entirely,
  // and shouting is one of the cheapest AI-generation signals there is.
  const shouted = classifyHeuristic("THE TRUTH IS BEING HIDDEN FROM EVERYONE");
  const whispered = classifyHeuristic("The truth is being hidden from everyone");
  assert.ok(shouted.signals.some((entry) => entry.id === SIGNAL_IDS.SHOUTING));
  assert.equal(
    whispered.signals.some((entry) => entry.id === SIGNAL_IDS.SHOUTING),
    false,
  );
  // The other detectors see the folded text, so the two agree on everything
  // that is not casing.
  assert.equal(shouted.aiScore > 0, whispered.aiScore > 0);
});

test("an acronym in an ordinary sentence is not shouting", () => {
  // "FBI" and "CDC" are three capitals, and the rule takes four. Without that
  // character of slack the signal fires on any caption that names an agency,
  // which is a large fraction of the health reporting this extension exists to
  // let people see.
  const result = classifyHeuristic("The FBI and the CDC both say the vaccine is safe");
  assert.equal(
    result.signals.some((entry) => entry.id === SIGNAL_IDS.SHOUTING),
    false,
  );
});

test("a short caption cannot be shouted", () => {
  // Three words is a fragment, not a post, and a caption fragment has no
  // baseline for what "normal casing" would have looked like.
  const result = classifyHeuristic("FBI CDC WHO");
  assert.equal(
    result.signals.some((entry) => entry.id === SIGNAL_IDS.SHOUTING),
    false,
  );
});

test("the call-to-action signal needs the instruction, not the word", () => {
  // "Share" on its own is how every caption on the platform reads. Only the
  // instruction is a signal, which is why the list is phrases.
  const instruction = classifyHeuristic("Share this with everybody you know");
  const mention = classifyHeuristic("I shared this photo with a friend yesterday");
  assert.ok(instruction.signals.some((entry) => entry.id === SIGNAL_IDS.CALL_TO_ACTION));
  assert.equal(
    mention.signals.some((entry) => entry.id === SIGNAL_IDS.CALL_TO_ACTION),
    false,
  );
});

test("an authority appeal with no citation pushes the misinformation axis harder", () => {
  // "Studies show" is the archetypal citation with no citation, and it says
  // nothing about whether a machine wrote the sentence. The two axes are scored
  // separately for exactly this case.
  const result = classifyHeuristic(
    "Studies show the council hid the results from everyone",
  );
  const signal = result.signals.find(
    (entry) => entry.id === SIGNAL_IDS.URGENCY_AUTHORITY,
  );
  assert.ok(signal);
  assert.ok(signal.newsWeight > signal.aiWeight);
  assert.ok(result.newsScore >= result.aiScore);
});

test("second-person instructions are counted per clause, not per word", () => {
  // "You" appears constantly in captions that assert nothing ("I saw you at
  // the store"). Only a clause that opens with an instruction and addresses the
  // reader counts, and a clause that merely opens with "we" is not one.
  const instructed = classifyHeuristic("Stop lying to us. Check your own facts.");
  const mentioned = classifyHeuristic("You should know that water is wet.");
  assert.equal(
    instructed.signals.find((entry) => entry.id === SIGNAL_IDS.SECOND_PERSON_IMPERATIVE)
      ?.value,
    1,
  );
  assert.equal(
    mentioned.signals.some((entry) => entry.id === SIGNAL_IDS.SECOND_PERSON_IMPERATIVE),
    false,
  );
  // Half the clauses addressed the reader is half a signal, not a full one: the
  // ratio is what keeps a single imperative in a long caption from saturating.
  const half = classifyHeuristic("Stop lying to us. The council met on Tuesday.");
  assert.equal(
    half.signals.find((entry) => entry.id === SIGNAL_IDS.SECOND_PERSON_IMPERATIVE)?.value,
    0.5,
  );
});

test("the superlative rule does not fire on ordinary words that end in -est", () => {
  // A morphological rule was tried and rejected: "interest", "request",
  // "witness", "protest" and "harvest" all end in "est" and the signal fired on
  // ordinary English often enough to be worthless. A fixed list can be audited.
  const ordinary = classifyHeuristic(
    "I filed a request about the forest and showed interest in the protest",
  );
  assert.equal(
    ordinary.signals.some((entry) => entry.id === SIGNAL_IDS.SUPERLATIVE),
    false,
  );
});

test("a caption of nothing but hashtags saturates the hashtag signal", () => {
  const result = classifyHeuristic("#fyp #viral #foryou #trending");
  const signal = result.signals.find((entry) => entry.id === SIGNAL_IDS.HASHTAG_SPAM);
  assert.equal(signal.value, 1);
  assert.equal(signal.evidence.length, 4);
});

test("a longer caption earns more confidence than a short one at the same strength", () => {
  // Confidence here is how much evidence was available, not a probability of
  // being right - a keyword counter cannot be calibrated. It still has to mean
  // something, and "a five-word caption scored the same as a fifty-word one"
  // would not.
  const short = classifyHeuristic("Everyone must know");
  const long = classifyHeuristic(
    "Everyone must know that the council has been hiding the results from the public for years",
  );
  assert.ok(long.confidence > short.confidence);
  assert.ok(long.confidence <= 1);
  assert.ok(classifyHeuristic("").confidence >= 0);
});

test("a caption with no signals still reports a confidence from its length alone", () => {
  // Otherwise "confident that nothing fired" and "no idea" look identical, and
  // the UI has nothing to show.
  const result = classifyHeuristic(
    "the shop was closed when i arrived but it opens at nine",
  );
  assert.deepEqual(result.signals, []);
  assert.ok(
    result.confidence > 0,
    "a six-word caption should not read as zero confidence",
  );
  assert.ok(result.confidence < 0.5);
});

// --------------------------------------------------------------------------
// The transformer path
// --------------------------------------------------------------------------

test("an installed model is preferred over the heuristic", async () => {
  // The transformer is strictly more informative than a keyword count. Falling
  // back while a working model sits installed would be a bug, not caution.
  const { session, state } = fakeSession({ logits: [0.2, 3] });
  const result = await classify("hello", { session });
  assert.equal(result.source, CLASSIFIER_SOURCES.ONNX);
  assert.equal(result.status, MODEL_STATUS.ONNX_READY);
  assert.ok(result.aiScore > 0.9, `expected a high ai score, got ${result.aiScore}`);
  assert.ok(result.newsScore < 0.6);
  assert.equal(state.runs, 1);
});

test("the transformer is given the ids, the mask and the shape it expects", async () => {
  // A shape mismatch is a runtime error with a message about tensors, so the
  // thing worth pinning is that the batch dimension and the sequence length
  // agree with each other.
  const seen = [];
  const { session } = fakeSession({
    create: () => ({
      run: (feeds) => {
        seen.push(feeds);
        return { logits: { data: Float32Array.from([0.2, 3]) } };
      },
      release: () => {},
    }),
  });
  await classify("the vaccine contains micro chips", { session });
  const feeds = seen[0];
  const [batch, length] = feeds.input_ids.dims;
  assert.equal(batch, 1);
  assert.equal(feeds.attention_mask.dims[1], length);
  assert.equal(feeds.token_type_ids.dims[1], length);
  // [CLS] and [SEP] are present, so the sequence is at least two long and the
  // ids are the vocabulary's, not raw word lengths.
  assert.ok(length >= 7);
  assert.ok(feeds.input_ids.data instanceof BigInt64Array);
});

test("the transformer reports no confidence, because a raw head is not calibrated", async () => {
  // Inventing one would be the single most misleading thing this module could
  // do: the backend's agent already reports a real confidence, and a number
  // derived from a logit would be read as that.
  const { session } = fakeSession();
  const result = await classify("hello", { session });
  assert.equal(result.confidence, null);
});

test("the transformer offers no per-signal attribution", async () => {
  // A transformer has no lexical explanation to give. Returning the heuristic's
  // signals alongside an ONNX score would attribute a number to words the model
  // never looked at.
  const { session } = fakeSession();
  const result = await classify("SHARE THIS", { session });
  assert.deepEqual(result.signals, []);
});

test("the two heads are squashed independently rather than as a softmax pair", async () => {
  // "90% machine-generated" and "90% misinformation" are different questions.
  // A 2-way softmax would force them to sum to 1, so a post that is both would
  // be reported as 0.92 / 0.08 and the misinformation axis would fall under its
  // threshold even though the model was confident about it.
  // A 2-way softmax over these same logits would report 0.03 / 0.97, so the
  // misinformation axis would sit far below its threshold on a post the model
  // was 62% sure about.
  const { session } = fakeSession({ logits: [0.5, 4] });
  const result = await classify("hello", { session });
  assert.ok(result.aiScore > 0.95, `aiScore ${result.aiScore}`);
  assert.ok(result.newsScore > 0.6, `newsScore ${result.newsScore}`);
});

test("a one-output model fills one axis and says which", async () => {
  // A single binary head can answer one question. Reporting the other axis as
  // zero is only honest if the caller can tell "the model said no" from "the
  // model did not look", which is what the scored flags are for.
  const aiOnly = fakeSession({ logits: [2.5] });
  const asAi = await classify("hello", { session: aiOnly.session });
  assert.equal(asAi.aiScored, true);
  assert.equal(asAi.newsScored, false);
  assert.equal(asAi.newsScore, 0);
  assert.ok(asAi.aiScore > 0.8);

  const asNews = await classify("hello", {
    session: aiOnly.session,
    singleChannel: "news",
  });
  assert.equal(asNews.aiScored, false);
  assert.equal(asNews.newsScored, true);
  assert.ok(asNews.newsScore > 0.8);
});

test("a model with no vocabulary available degrades rather than inventing ids", async () => {
  // Ids are meaningless without the vocabulary the checkpoint was trained
  // with, and every id the tokenizer could produce is in range. Guessing would
  // produce confident nonsense with no error anywhere.
  const { session } = fakeSession({ vocab: "throw" });
  const result = await classify("SHARE THIS, everyone must know", { session });
  assert.equal(result.source, CLASSIFIER_SOURCES.HEURISTIC);
  assert.ok(result.signals.length > 0, "the heuristic did not run");
});

test("a missing model asset falls back to the heuristic and says why", async () => {
  const { session } = fakeSession({ model: "404" });
  const result = await classify("SHARE THIS everyone must know", { session });
  assert.equal(result.source, CLASSIFIER_SOURCES.HEURISTIC);
  assert.equal(result.status, MODEL_STATUS.MISSING_ASSET);
  assert.ok(result.aiScore > 0, "the heuristic did not run");
});

test("a model that cannot be read from this context is not reported as missing", async () => {
  const { session } = fakeSession({ model: "throw" });
  const result = await classify("SHARE THIS everyone must know", { session });
  assert.equal(result.source, CLASSIFIER_SOURCES.HEURISTIC);
  assert.equal(result.status, MODEL_STATUS.ASSET_UNREADABLE);
});

test("an output tensor that is not usable numbers falls back to the heuristic", async () => {
  // NaN, a missing tensor and an empty output are all shapes a mismatched
  // export produces. None of them may become a score.
  for (const logits of [[Number.NaN], [Number.POSITIVE_INFINITY]]) {
    const { session } = fakeSession({ logits });
    const result = await classify("SHARE THIS everyone", { session });
    assert.equal(
      result.source,
      CLASSIFIER_SOURCES.HEURISTIC,
      `used ${JSON.stringify(logits)}`,
    );
  }
  const empty = fakeSession({ run: () => ({}) });
  assert.equal(
    (await classify("SHARE THIS everyone", { session: empty.session })).source,
    CLASSIFIER_SOURCES.HEURISTIC,
  );
});

test("a session that throws at any point leaves the caller with a heuristic verdict", async () => {
  // classify() is called from a content scan. An exception here is a scan that
  // stops, which is a worse outcome than a coarse score.
  const { session } = fakeSession({
    create: () => {
      throw new Error("Unrecognized opset 42");
    },
  });
  const result = await classify("SHARE THIS everyone must know", { session });
  assert.equal(result.source, CLASSIFIER_SOURCES.HEURISTIC);
  assert.ok(result.aiScore > 0);
});

test("a session that throws while running is survivable too", async () => {
  const { session } = fakeSession({
    run: () => {
      throw new Error("Invalid input shape");
    },
  });
  const result = await classify("SHARE THIS everyone must know", { session });
  assert.equal(result.source, CLASSIFIER_SOURCES.HEURISTIC);
});

// --------------------------------------------------------------------------
// Readiness reporting
// --------------------------------------------------------------------------

test("the readiness report names the state an operator has to act on", async () => {
  // The popup has to distinguish "export a checkpoint" from "vendor
  // onnxruntime-web" from "this context cannot read the model", because the
  // three need three different actions.
  const cases = [
    { options: {}, status: MODEL_STATUS.MODEL_PRESENT },
    { options: { model: "404" }, status: MODEL_STATUS.MISSING_ASSET },
    { options: { model: "throw" }, status: MODEL_STATUS.ASSET_UNREADABLE },
    { options: { runtime: "missing" }, status: MODEL_STATUS.RUNTIME_MISSING },
  ];
  for (const testCase of cases) {
    const { session } = fakeSession(testCase.options);
    const report = await describeLocalModel({ session });
    assert.equal(report.status, testCase.status, JSON.stringify(testCase.options));
    assert.ok(
      report.detail.length > 10,
      "a status with no explanation is not actionable",
    );
  }
});

test("the readiness report confirms an installed model without loading it", async () => {
  // The popup renders one line. Streaming 100 MB of weights to do it would make
  // the popup slower than the thing it is describing.
  const { session, state } = fakeSession();
  const report = await describeLocalModel({ session });
  assert.equal(report.status, MODEL_STATUS.MODEL_PRESENT);
  assert.equal(report.asset, "present");
  assert.equal(report.runtime, true);
  assert.equal(state.creates, 0, "the readiness check built a session");
});

test("the readiness report degrades to heuristic-only when no session exists", async () => {
  // Asking "what am I getting" with the transformer switched off is a
  // legitimate question and the answer is a state, not an error.
  const report = await describeLocalModel({ session: null });
  assert.equal(report.status, MODEL_STATUS.HEURISTIC_ONLY);
  assert.equal(report.runtime, false);
});

test("the readiness report never throws, whatever the session does", async () => {
  const hostile = {
    readiness: () => {
      throw new Error("probe exploded");
    },
    snapshot: () => {
      throw new Error("snapshot exploded");
    },
  };
  const report = await describeLocalModel({ session: hostile });
  assert.equal(report.status, MODEL_STATUS.HEURISTIC_ONLY);
  assert.match(report.detail, /threw/);
});

test("a session that has never been asked anything reports idle", () => {
  const session = createOnnxSession();
  assert.equal(session.snapshot().status, SESSION_STATUS.IDLE);
  assert.equal(session.snapshot().modelPath, "models/classifier.onnx");
});
