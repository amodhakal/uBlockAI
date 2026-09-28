/**
 * Client-side pre-filter (#66).
 *
 * The tests are weighted towards the failure mode that actually matters. A
 * pre-filter that skips a genuine claim lets misinformation through, which
 * defeats the extension; a pre-filter that fails to skip a worthless post costs
 * a little CPU. So the largest block here is GENUINE_CLAIMS, every one of
 * which must survive, and most are deliberately awkward: short, numeric,
 * lowercase, non-English, image-backed, or all of the above.
 *
 * Two of these cases exist because the first implementation of prefilter.js
 * got them wrong, and both failures were silent: "drink bleach" was skipped as
 * too short, and a bare screenshot with no caption was skipped even though
 * OCR would have read it.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { stableCacheKey } from "./cache.js";
import {
  MIN_CLAIM_LETTERS,
  SKIP_REASONS,
  prefilterPost,
  prefilterPosts,
} from "./prefilter.js";

/** A post with an image, which is the common case. */
const imagePost = (over = {}) => ({
  caption: "",
  imageAlt: "",
  imageUrl: "https://cdn.example.com/pic.jpg",
  permalink: "https://example.com/p/abc",
  mediaId: "m1",
  ...over,
});

/** A text-only post: no image for the backend to OCR. */
const textPost = (caption, over = {}) => ({
  caption,
  imageAlt: "",
  imageUrl: "",
  permalink: "https://example.com/p/abc",
  mediaId: "m1",
  ...over,
});

// --------------------------------------------------------------------------
// No false suppression: real claims must always survive
// --------------------------------------------------------------------------

const GENUINE_CLAIMS = [
  // Short and numeric. Every one of these is checkable and several are exactly
  // the kind of false statistic this extension exists to catch.
  "3 dead",
  "He's 6'2\"",
  "costs $40",
  "since 2019",
  "1 in 9",
  "COVID killed 300k",
  "Pfizer causes autism",
  "drink bleach",
  "5G causes cancer",
  "the election was stolen",
  "Trump won in 2020",
  "vaccines cause infertility",

  // Short, word-bearing, and short enough that a length rule would eat them.
  // "drink bleach" and "Water is wet" were both suppressed by the first
  // implementation, which is why they are pinned here.
  "He's tall",
  "Water is wet",
  "The earth is flat",
  "It is cold outside",
  "This ruins you",
  "They are lying",
  "Stop lying to us",
  "Do your own research",

  // Close cousins of reactions, which a substring match would suppress.
  "stop the presses",
  "no more of this",
  "same energy",
  "true story",

  // Non-English. A rule keyed on ASCII or on English words would drop these.
  "La terre est plate",
  "Die Erde ist flach",
  "La tierra es plana",
  "地球は平らです",
  "الشمس تسطع",
  "Solus orbis planus est",
  "Земля плоская",
  "地球是平的",
  "解雇された",

  // Claims with a URL inside: stripping the URL must not discard the prose.
  "PROOF https://example.com/x this vaccine kills",
  "see http://a.b/c the mayor resigned today",

  // Claims carried entirely in alt text, with no caption.
  "Chart shows a 300% rise in crime since 2020",
  "Two photos side by side, both from 2015",

  // All-caps, which a shouting filter might treat as noise.
  "THE VACCINE CONTAINS MICROCHIPS",
  "STOP THE LIES",

  // Emoji mixed with a short claim.
  "🤔 he really said 2019 was the hottest year",

  // Normal long claims.
  "The council voted to close the hospital in March despite a 4000-signature petition.",
  "A study last week found the vaccine reduces hospitalisation by 90 percent.",
];

test("no genuine claim is ever suppressed, on a text-only post", () => {
  const missed = [];
  for (const caption of GENUINE_CLAIMS) {
    const decision = prefilterPost(textPost(caption));
    if (decision.skip) missed.push({ caption, reason: decision.reason });
  }
  assert.deepEqual(missed, [], "the pre-filter suppressed a real claim");
});

test("no genuine claim is ever suppressed, on a post that also has an image", () => {
  const missed = [];
  for (const caption of GENUINE_CLAIMS) {
    const decision = prefilterPost(imagePost({ caption }));
    if (decision.skip) missed.push({ caption, reason: decision.reason });
  }
  assert.deepEqual(missed, [], "the pre-filter suppressed a real claim");
});

test("a claim in alt text alone is not suppressed", () => {
  const decision = prefilterPost(
    textPost("", { imageAlt: "Chart shows a 300% rise in crime" }),
  );
  assert.equal(decision.skip, false);
});

test("a bare image with no text is still analysed, because OCR will read it", () => {
  // The backend OCRs images. A screenshot with no caption is a primary
  // misinformation vector, not an empty post. The first implementation
  // skipped these, which blinded the extension to exactly the case that
  // matters most.
  const decision = prefilterPost(imagePost({ caption: "", imageAlt: "" }));
  assert.equal(decision.skip, false);
});

test("a short claim containing a digit is never skipped", () => {
  for (const caption of ["3 dead", "2019", "$40", "9 out of 10"]) {
    assert.equal(prefilterPost(textPost(caption)).skip, false, `suppressed: ${caption}`);
  }
});

test("a short claim in a script the rules were not written for is never skipped", () => {
  // Character counting, not word counting: a four-character CJK sentence is
  // a full assertion, and an Arabic caption is not an English reaction.
  for (const caption of ["地球は平ら", "地球是平的", "解雇された", "تسطع الشمس"]) {
    assert.equal(prefilterPost(textPost(caption)).skip, false, `suppressed: ${caption}`);
  }
});

test("the reaction list is matched whole, never as a substring", () => {
  // "stop" is a reaction and "stop lying to us" is a claim. A substring rule
  // would suppress the second, which is a death threat to the whole idea.
  for (const caption of ["stop lying to us", "stop the vaccine", "same page here"]) {
    assert.equal(prefilterPost(textPost(caption)).skip, false, `suppressed: ${caption}`);
  }
});

// --------------------------------------------------------------------------
// What it does skip
// --------------------------------------------------------------------------

test("a post with no text and no image is skipped", () => {
  const decision = prefilterPost({
    caption: "",
    imageAlt: "",
    imageUrl: "",
    permalink: "https://example.com/p/abc",
    mediaId: "m1",
  });
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, SKIP_REASONS.NO_CONTENT);
});

test("a missing post is skipped rather than throwing", () => {
  const decision = prefilterPost(null);
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, SKIP_REASONS.NO_CONTENT);
});

test("a text-only post of pure emoji and punctuation is skipped", () => {
  for (const caption of ["😂😂😂", "!!!", "???", "❤️❤️", "🔥🔥🔥", "…", "..."]) {
    const decision = prefilterPost(textPost(caption));
    assert.equal(decision.skip, true, `not skipped: ${caption}`);
    assert.equal(decision.reason, SKIP_REASONS.NOT_TEXT);
  }
});

test("a text-only caption that is only a URL is skipped", () => {
  for (const caption of [
    "https://example.com/something",
    "http://a.b/c",
    "www.example.com/x",
    "https://example.com/a https://example.com/b",
  ]) {
    const decision = prefilterPost(textPost(caption));
    assert.equal(decision.skip, true, `not skipped: ${caption}`);
    assert.equal(decision.reason, SKIP_REASONS.NOT_TEXT);
  }
});

test("a text-only post of only hashtags is skipped", () => {
  // Hashtags are letters, so this is not the "no text at all" case and it is
  // long enough to clear the letter floor. It needs its own rule.
  const decision = prefilterPost(textPost("#goals #viral #fyp"));
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, SKIP_REASONS.NOT_TEXT);
});

test("a hashtag is not stripped before the claim check", () => {
  // A caption that is mostly hashtags but contains an assertion must survive:
  // dropping the hashtag tokens would leave nothing and read as "not text".
  assert.equal(
    prefilterPost(textPost("#act #viral the hospital is closing")).skip,
    false,
  );
});

test("a text-only reaction is skipped", () => {
  for (const caption of [
    "omg",
    "no way",
    "yesss",
    "stop",
    "literally",
    "wait what",
    "LMAO",
  ]) {
    const decision = prefilterPost(textPost(caption));
    assert.equal(decision.skip, true, `not skipped: ${caption}`);
    assert.equal(decision.reason, SKIP_REASONS.REACTION);
  }
});

test("the letter floor only fires below four letters", () => {
  // Guards the constant rather than a fixture: raising it is how the first
  // implementation came to suppress "drink bleach".
  assert.equal(MIN_CLAIM_LETTERS, 4);
  // "drink bleach" has eleven letters, and must stay analysable.
  assert.ok("drinkbleach".length > MIN_CLAIM_LETTERS);
  assert.equal(prefilterPost(textPost("omg")).skip, true);
  assert.equal(prefilterPost(textPost("nice")).skip, true);
});

test("a hashtag next to a real claim keeps the post", () => {
  assert.equal(prefilterPost(textPost("he resigned today #politics")).skip, false);
});

// --------------------------------------------------------------------------
// Failing open
// --------------------------------------------------------------------------

test("a post that throws during evaluation is not skipped", () => {
  // A getter that explodes stands in for any future field access that can
  // fail. The rule is absolute: unknown means analyse.
  const hostile = {
    get caption() {
      throw new Error("boom");
    },
    imageAlt: "",
    imageUrl: "https://cdn.example.com/x.jpg",
  };
  assert.equal(prefilterPost(hostile).skip, false, "the pre-filter must fail open");
});

test("a non-string caption is handled without throwing", () => {
  for (const caption of [null, undefined, 0, 42, {}, []]) {
    const decision = prefilterPost(textPost(caption));
    assert.equal(typeof decision.skip, "boolean");
  }
});

// --------------------------------------------------------------------------
// Trust list
// --------------------------------------------------------------------------

test("an already-trusted key is skipped", () => {
  const p = textPost("a real claim worth checking");
  // stableCacheKey prefers mediaId, then the permalink, so that is the key the
  // trust list actually holds; deriving it keeps the fixture honest.
  const key = stableCacheKey(p);
  assert.equal(key, "mid:m1");
  assert.equal(
    prefilterPost(p, { trustedKeys: new Set([key]) }).reason,
    SKIP_REASONS.TRUSTED,
  );
  assert.equal(prefilterPost(p, { trustedKeys: [key] }).reason, SKIP_REASONS.TRUSTED);
  assert.equal(prefilterPost(p, { trustedKeys: new Set(["other"]) }).skip, false);
});

test("the trust list cannot suppress a post with no key", () => {
  // An empty postKey would make every post look trusted under a naive
  // `includes("")` check.
  const p = { caption: "a real claim", imageAlt: "", imageUrl: "", permalink: "" };
  assert.equal(prefilterPost(p, { trustedKeys: [""] }).skip, false);
});

test("trust is honoured even for a post that has an image", () => {
  const p = imagePost({ caption: "a real claim" });
  const key = stableCacheKey(p);
  assert.equal(
    prefilterPost(p, { trustedKeys: new Set([key]) }).reason,
    SKIP_REASONS.TRUSTED,
  );
});

// --------------------------------------------------------------------------
// Batch
// --------------------------------------------------------------------------

test("prefilterPosts partitions without losing or duplicating a post", () => {
  const posts = [
    textPost("The council closed the hospital in March."),
    textPost("😂😂"),
    textPost("https://example.com/x"),
    textPost("5G causes cancer"),
    textPost("omg"),
  ];
  const { keep, skipped } = prefilterPosts(posts, { trustedKeys: new Set() });

  assert.equal(keep.length + skipped.length, posts.length, "nothing may be lost");
  assert.equal(keep.length, 2, "the two real claims must survive");
  assert.deepEqual(
    keep.map((p) => p.caption),
    ["The council closed the hospital in March.", "5G causes cancer"],
  );
  assert.deepEqual(
    skipped.map((s) => s.reason).sort(),
    [SKIP_REASONS.NOT_TEXT, SKIP_REASONS.NOT_TEXT, SKIP_REASONS.REACTION].sort(),
  );
});

test("prefilterPosts tolerates an empty or missing list", () => {
  assert.deepEqual(prefilterPosts([]), { keep: [], skipped: [] });
  assert.deepEqual(prefilterPosts(null), { keep: [], skipped: [] });
});

test("the decision carries a reason so it can be audited", () => {
  // A skip with no recorded reason cannot be debugged from a support report.
  for (const caption of ["😂😂", "omg", "https://x.example/y"]) {
    const { skip, reason } = prefilterPost(textPost(caption));
    if (skip) assert.ok(reason, `no reason recorded for: ${caption}`);
  }
});
