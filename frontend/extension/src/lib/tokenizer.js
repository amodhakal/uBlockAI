/**
 * A minimal, dependency-free WordPiece tokenizer.
 *
 * The extension has no build step and no runtime dependencies, so the tokenizer
 * a real text-classification checkpoint expects cannot be vendored: BERT-family
 * models are trained against `tokenizers` (a Rust/WASM package) or
 * `@xenova/transformers` (a ~1 MB JavaScript bundle plus its own dependencies),
 * and neither is compatible with "plain ESM that Chrome loads directly".
 *
 * So this file reimplements the parts of the algorithm that inference actually
 * depends on: lowercasing and accent folding, basic tokenisation on whitespace
 * and punctuation, a greedy longest-match-first subword split, and [CLS]/[SEP]
 * framing with truncation.
 *
 * The vocabulary is NOT bundled, and must not be. It is 30 000 entries for a
 * BERT-base checkpoint (about 230 KB of text), it is a verbatim copy of a
 * third-party artefact, and it is worthless without the matching weights. The
 * operator drops it next to the model; see docs/models/README.md. Every entry
 * point here therefore takes the vocabulary as an argument and fails soft when
 * it is absent.
 *
 * The two behaviours that break silently, and are therefore the two most
 * heavily tested, are:
 *
 *   1. The greedy longest-match-first split. Taking the longest piece at each
 *      position is what WordPiece does, and it is not interchangeable with
 *      "first match wins" or with a shortest-match split: `unbelievable` is
 *      `un` + `##believ` + `##able` under greedy matching and three unrelated
 *      tokens under a naive one, and the model sees a completely different
 *      sequence.
 *   2. The unknown-token fallback. When no prefix of a word is in the
 *      vocabulary the whole word becomes [UNK] - the partial pieces that were
 *      found along the way are discarded, not emitted. Emitting them produces a
 *      short sequence that looks plausible and means nothing, and the resulting
 *      logits are still in range, so nothing downstream notices.
 */

/** The five special tokens every checkpoint in this family is trained with. */
export const PAD_TOKEN = "[PAD]";
export const UNK_TOKEN = "[UNK]";
export const CLS_TOKEN = "[CLS]";
export const SEP_TOKEN = "[SEP]";
export const MASK_TOKEN = "[MASK]";

/**
 * Longest input a model with a 512-token position embedding can accept.
 *
 * 256 is the default here rather than 512 because a feed caption is short, and
 * attention is quadratic in sequence length: 512 positions costs roughly four
 * times the compute of 256 for no extra signal on a caption.
 */
export const DEFAULT_MAX_INPUT_TOKENS = 256;

/**
 * Longest word the subword split will try to break up.
 *
 * A caption is untrusted input, so a 3000-character run of letters is a real
 * possibility, and the split is O(n^2) in the word length. WordPiece bounds the
 * same way (`max_input_chars_per_word = 100`): a longer word is [UNK] outright.
 */
export const MAX_PIECE_CHARS = 100;

const SPECIAL_TOKENS = new Set([PAD_TOKEN, UNK_TOKEN, CLS_TOKEN, SEP_TOKEN, MASK_TOKEN]);

/**
 * C0 and C1 controls, plus format characters.
 *
 * Format characters matter more than they look: a zero-width joiner inside an
 * emoji is what makes a 200-code-unit grapheme cluster, and a word containing
 * one can never be in any vocabulary.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/**
 * One run of letters/digits, or one single non-letter/non-digit character.
 *
 * The alternation with a one-character branch is BERT's rule and it is what
 * keeps punctuation as its own token: "autism!" is `autism` + `!`, and
 * collapsing it to `autism` would silently delete the exclamation mark that
 * models treat as a strong emphasis signal.
 */
const WORD_OR_PUNCT = /[\p{L}\p{N}]+|[^\p{L}\p{N}]/gu;

/**
 * Lowercase and strip diacritics, the two normalisations BERT applies before
 * anything else.
 *
 * NFD first, then remove combining marks. NFC would leave a precomposed "e"
 * with an acute accent as a single code point that no vocabulary contains,
 * which turns ordinary accented text into [UNK] at a much higher rate than the
 * checkpoint was trained to expect.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function foldText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * Split raw text into vocabulary-sized units.
 *
 * Whitespace-separated first, then each chunk split into word and punctuation
 * runs. A literal `[CLS]` or `[SEP]` in the input is preserved as one token
 * rather than being shredded into `[`, `CLS`, `]`; a caption can contain it and
 * the alternative is three tokens that mean nothing.
 *
 * @param {unknown} text
 * @returns {string[]} tokens, in order, before subword splitting
 */
export function basicTokens(text) {
  const cleaned = String(text ?? "")
    .replace(INVISIBLE, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return [];

  const out = [];
  for (const chunk of cleaned.split(" ")) {
    // Tested against the original casing, before folding. "[CLS]" folds to
    // "[cls]", which is not a token in any vocabulary, so folding first turns
    // a recognisable special token into three ordinary pieces.
    if (SPECIAL_TOKENS.has(chunk)) {
      out.push(chunk);
      continue;
    }
    const folded = foldText(chunk);
    for (const match of folded.matchAll(WORD_OR_PUNCT)) {
      if (match[0]) out.push(match[0]);
    }
  }
  return out;
}

/**
 * Split one word into vocabulary pieces, greedily longest-match-first.
 *
 * Greedy means: at each position take the longest suffix that is in the
 * vocabulary, emit it, and continue. Pieces after the first are prefixed with
 * `##` so the model can tell "believ" in "unbelievable" from a word that
 * starts with "believ".
 *
 * The `[UNK]` fallback discards the partial pieces found so far. That is the
 * whole point of the special token: WordPiece has no way to represent "most of
 * this word was known", and emitting the known prefix would claim a token
 * sequence the model was never trained to interpret.
 *
 * @param {unknown} word a single basic token; folded internally
 * @param {Map<string, number>} vocab
 * @returns {string[]} pieces, or `[UNK_TOKEN]`, or `[]` for empty input
 */
export function wordPieces(word, vocab) {
  const raw = String(word ?? "");
  // Before folding, for the same reason as in basicTokens: the framing tokens
  // are upper case and folding them makes them unrecognisable.
  if (SPECIAL_TOKENS.has(raw)) return [raw];
  const target = foldText(raw);
  if (!target) return [];
  if (!vocab || typeof vocab.has !== "function") return [UNK_TOKEN];
  if (target.length > MAX_PIECE_CHARS) return [UNK_TOKEN];
  if (vocab.has(target)) return [target];

  const pieces = [];
  let start = 0;
  while (start < target.length) {
    let end = target.length;
    let match = null;
    while (start < end) {
      const candidate =
        start === 0 ? target.slice(start, end) : `##${target.slice(start, end)}`;
      if (vocab.has(candidate)) {
        match = candidate;
        break;
      }
      end -= 1;
    }
    if (match === null) return [UNK_TOKEN];
    pieces.push(match);
    start = end;
  }
  return pieces;
}

/**
 * Build a vocabulary map from any of the shapes it is likely to arrive in.
 *
 * Positional ids are preserved for the text and array forms, because a
 * `vocab.txt` is indexed by line number and re-numbering it would silently
 * remap every embedding row in the checkpoint.
 *
 * @param {Map<string, number>|Record<string, number>|string[]|string} source
 * @returns {Map<string, number>}
 */
export function loadVocab(source) {
  if (source instanceof Map) return new Map(source);
  if (Array.isArray(source)) return vocabFromLines(source);
  if (typeof source === "string") return vocabFromLines(source.split("\n"));
  if (source && typeof source === "object") {
    const out = new Map();
    for (const [token, id] of Object.entries(source)) {
      const numeric = Number(id);
      if (Number.isInteger(numeric) && numeric >= 0) out.set(String(token), numeric);
    }
    return out;
  }
  throw new TypeError(
    "vocabulary must be a Map, an id map, an array of lines, or vocab.txt text",
  );
}

/**
 * @param {Array<string|number>} lines
 * @returns {Map<string, number>}
 */
function vocabFromLines(lines) {
  const out = new Map();
  for (const [index, line] of lines.entries()) {
    const token = String(line ?? "").replace(/\r$/, "");
    if (token === "") continue;
    out.set(token, index);
  }
  return out;
}

/**
 * A WordPiece tokenizer bound to one vocabulary.
 *
 * @typedef {object} Encoding
 * @property {string[]} tokens the pieces, including [CLS] and [SEP]
 * @property {number[]} inputIds vocabulary ids
 * @property {number[]} attentionMask 1 per real token
 * @property {number[]} tokenTypeIds 0 for a single-segment input
 */
export class WordPieceTokenizer {
  /**
   * @param {Map<string, number>|Record<string, number>|string[]|string} vocab
   * @param {object} [options]
   * @param {number} [options.maxInputTokens] total length including [CLS]/[SEP]
   * @param {string} [options.clsToken]
   * @param {string} [options.sepToken]
   * @param {string} [options.padToken]
   * @param {string} [options.unkToken]
   */
  constructor(vocab, options = {}) {
    this.vocab = loadVocab(vocab);
    if (this.vocab.size === 0) {
      throw new TypeError("the vocabulary is empty, so no text can be tokenized");
    }
    this.clsToken = options.clsToken ?? CLS_TOKEN;
    this.sepToken = options.sepToken ?? SEP_TOKEN;
    this.padToken = options.padToken ?? PAD_TOKEN;
    this.unkToken = options.unkToken ?? UNK_TOKEN;
    /** @type {Map<number, string>|null} built lazily by tokenAt */
    this._reverse = null;

    // Floored at 2 because the framing tokens are not optional: a "sequence"
    // of length 1 is [CLS] with no [SEP], which every checkpoint rejects.
    const requested = Math.floor(Number(options.maxInputTokens));
    this.maxInputTokens = Number.isFinite(requested)
      ? Math.max(2, requested)
      : DEFAULT_MAX_INPUT_TOKENS;
  }

  /** @returns {number} vocabulary size */
  get size() {
    return this.vocab.size;
  }

  /**
   * @param {string} token
   * @returns {number} the id, or the [UNK] id, or 0
   */
  idOf(token) {
    const id = this.vocab.get(token);
    if (typeof id === "number") return id;
    const unk = this.vocab.get(this.unkToken);
    return typeof unk === "number" ? unk : 0;
  }

  /**
   * @param {number} id
   * @returns {string|null}
   */
  tokenAt(id) {
    // Reverse lookup is only used by decode(), which is a test and debugging
    // affordance, so the index is built on first use rather than paying for a
    // 30 000-entry second map on every tokenizer that never decodes.
    if (!this._reverse) {
      this._reverse = new Map();
      for (const [token, value] of this.vocab) {
        if (!this._reverse.has(value)) this._reverse.set(value, token);
      }
    }
    return this._reverse.get(id) ?? null;
  }

  /**
   * @param {unknown} word
   * @returns {string[]}
   */
  splitWord(word) {
    return wordPieces(word, this.vocab);
  }

  /**
   * Encode text for a sequence-classification model.
   *
   * Truncation drops tokens from the end of the body and always keeps the
   * final [SEP]. A sequence without it is malformed for every model in this
   * family, and losing the terminator to save one caption word is not a trade
   * worth making.
   *
   * @param {unknown} text
   * @returns {Encoding}
   */
  tokenize(text) {
    const budget = this.maxInputTokens - 2;
    const body = [];
    outer: for (const token of basicTokens(text)) {
      // A caption that already contains the framing tokens must not be able to
      // forge a second [CLS] in the middle of the sequence.
      if (token === this.clsToken || token === this.sepToken) continue;
      for (const piece of this.splitWord(token)) {
        if (body.length >= budget) break outer;
        body.push(piece);
      }
    }

    const tokens = [this.clsToken, ...body, this.sepToken];
    const inputIds = tokens.map((token) => this.idOf(token));
    return {
      tokens,
      inputIds,
      // No padding: inference is one sequence at a time, and a 0 in the mask
      // for a token that is genuinely there is a silent accuracy loss.
      attentionMask: inputIds.map(() => 1),
      tokenTypeIds: inputIds.map(() => 0),
    };
  }

  /**
   * Inverse of {@link tokenize}, for tests and for inspecting what a caption
   * actually became.
   *
   * @param {Iterable<number>} ids
   * @param {{skipSpecialTokens?: boolean}} [options]
   * @returns {string}
   */
  decode(ids, options = {}) {
    const skipSpecial = options.skipSpecialTokens !== false;
    const special = new Set([this.clsToken, this.sepToken, this.padToken]);

    let out = "";
    for (const raw of Array.from(ids || [])) {
      const id = Number(raw);
      if (!Number.isInteger(id)) continue;
      const token = this.tokenAt(id);
      if (token === null) continue;
      if (skipSpecial && special.has(token)) continue;
      if (token.startsWith("##")) {
        out += token.slice(2);
      } else {
        if (out) out += " ";
        out += token;
      }
    }
    return out;
  }
}

/**
 * Build a tokenizer, or return null when there is no usable vocabulary.
 *
 * Null rather than a throw because the caller here is the classifier, which has
 * to degrade to its heuristic scorer rather than take the whole content script
 * down over a missing file.
 *
 * @param {Parameters<typeof WordPieceTokenizer>[1] & {vocab?: unknown}} options
 * @returns {WordPieceTokenizer|null}
 */
export function createTokenizer(options = {}) {
  if (options.vocab === undefined || options.vocab === null) return null;
  try {
    return new WordPieceTokenizer(options.vocab, options);
  } catch {
    return null;
  }
}
