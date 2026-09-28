import { MAX_CAPTION_CHARS } from "../lib/defaults.js";

/**
 * Per-platform DOM adapters.
 *
 * The selectors for posts, images and captions were hardcoded Instagram
 * class names (`._aagu._aa20`, `._ap3a`) inline in the content script. Those
 * are generated hashes and change without notice, and they made supporting
 * another platform impossible without editing the middle of the script.
 *
 * An adapter declares how to find posts and how to read one. Adding a platform
 * means adding an adapter, not editing the scan loop.
 */

/**
 * @typedef {object} RawPost
 * @property {Element} element
 * @property {string|null} imageUrl
 * @property {string|null} imageAlt
 * @property {string} caption
 * @property {string} [permalink]
 * @property {string} [mediaId]
 * @property {boolean} [isVideo]
 * @property {string|null} [videoUrl]
 * @property {string|null} [videoThumb]
 */

/**
 * @typedef {object} PlatformAdapter
 * @property {string} id
 * @property {string[]} matches URL patterns this adapter handles
 * @property {string[]} postSelectors
 * @property {string[]} imageSelectors
 * @property {string[]} captionSelectors
 * @property {(element: Element) => string|null} [extractPermalink]
 * @property {(element: Element) => boolean} [isVideoPost]
 */

/** Try each selector in order and return the first match. */
export function queryWithFallback(selectors, root) {
  for (const selector of selectors) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

/** Try each selector in order and return the first non-empty NodeList. */
export function queryAllWithFallback(selectors, root) {
  for (const selector of selectors) {
    const found = root.querySelectorAll(selector);
    if (found.length > 0) return found;
  }
  return root.querySelectorAll(selectors[0]);
}

/** Find the largest plausible content image, skipping avatars and emoji. */
function findContentImage(post) {
  const images = post.querySelectorAll("img");
  for (const img of images) {
    const alt = img.getAttribute("alt") || "";
    if (alt.includes("profile picture")) continue;
    if (alt.includes("emoji")) continue;
    if (!img.getAttribute("src")) continue;
    if (img.width > 100) return img;
  }
  return null;
}

/**
 * Find the primary video in a post, if any.
 *
 * Reels and video posts render a <video> element whose `poster` attribute is
 * the frame the backend analyses (see the poster-frame strategy documented in
 * backend/app/post_classifier.py). The src may live on the element itself or
 * on a nested <source>.
 *
 * @param {Element} post
 * @returns {{element: Element, src: string|null, poster: string|null}|null}
 */
export function findContentVideo(post) {
  const video = post.querySelector("video");
  if (!video) return null;
  const source = video.querySelector("source[src]");
  const src = video.getAttribute("src") || source?.getAttribute("src") || null;
  const poster = video.getAttribute("poster") || null;
  if (!src && !poster) return null;
  return { element: video, src, poster };
}

function readCaption(post, captionSelectors) {
  const direct = queryWithFallback(captionSelectors, post);
  if (direct) {
    const text = (direct.textContent || "").trim();
    if (text) return text;
  }

  // Fall back to scanning for the longest plausible caption text in the post,
  // skipping location links, timestamps and like counts.
  const spans = post.querySelectorAll("span");
  for (const span of spans) {
    const text = (span.textContent || "").trim();
    if (!text || text.length <= 5) continue;
    if (span.closest('a[href*="/explore/locations/"]')) continue;
    if (span.closest("time")) continue;
    if (/^\d+\s*(likes?|others?)$/i.test(text)) continue;
    if (span.getAttribute("aria-hidden") === "true") continue;
    return text;
  }
  return "";
}

const instagramAdapter = {
  id: "instagram",
  matches: ["https://www.instagram.com/*", "https://instagram.com/*"],
  postSelectors: [
    "article:not([data-aibot-processed])",
    "div[role='article']:not([data-aibot-processed])",
    "main article:not([data-aibot-processed])",
  ],
  imageSelectors: [
    "div._aagu._aa20 div._aagv img",
    "div._a9--._ap30 img",
    "article img[src*='instagram.com'], article img[src*='fbcdn.net']",
    'img[alt^="Photo by"], img[alt^="Image by"]',
    "article img:not([aria-hidden='true']):not([src*='emoji'])",
  ],
  captionSelectors: [
    "span._ap3a._aacu",
    "span._ap3a",
    "span.x1lliihq",
    "div[role='article'] span[dir='auto']",
    "article a[href*='/p/'] + div span",
  ],
  extractPermalink(post) {
    const link = post.querySelector(
      "a[href*='/p/'], a[href*='/reel/'], a[href*='/reels/']",
    );
    return link ? link.getAttribute("href") : null;
  },
  isVideoPost(post) {
    return Boolean(post.querySelector("video, [aria-label*='ideo']"));
  },
};

const threadsAdapter = {
  id: "threads",
  // Threads is the closest DOM to Instagram (same Meta React feed stack:
  // article-based feed, CDN images, client-rendered text), so its selectors
  // mirror the Instagram adapter with Threads permalink shapes.
  matches: ["https://www.threads.net/*", "https://threads.net/*"],
  postSelectors: [
    "article:not([data-aibot-processed])",
    "div[role='article']:not([data-aibot-processed])",
    "main article:not([data-aibot-processed])",
  ],
  imageSelectors: [
    "article img[src*='fbcdn.net']",
    "article img[src*='cdninstagram.com']",
    "article img:not([aria-hidden='true']):not([src*='emoji'])",
    "article img",
  ],
  captionSelectors: [
    "article div[dir='auto']",
    "article span[dir='auto']",
    "div[role='article'] span[dir='auto']",
    "article p",
  ],
  extractPermalink(post) {
    // Threads permalinks look like /@user/post/<id> or /t/<id>.
    const link = post.querySelector("a[href*='/post/'], a[href*='/t/']");
    return link ? link.getAttribute("href") : null;
  },
  isVideoPost(post) {
    return Boolean(post.querySelector("video, [aria-label*='ideo']"));
  },
};

const genericAdapter = {
  id: "generic",
  matches: [],
  postSelectors: [
    "article:not([data-aibot-processed])",
    "div[role='article']:not([data-aibot-processed])",
    "main article:not([data-aibot-processed])",
  ],
  imageSelectors: ["article img", "main img", "img"],
  captionSelectors: ["article p", "article figcaption", "main p", "figcaption"],
  extractPermalink(post) {
    const link = post.querySelector("a[href]");
    return link ? link.getAttribute("href") : null;
  },
  extractMediaId(post) {
    const node = post.querySelector("[data-media-id], a[data-id]");
    const raw = node
      ? node.getAttribute("data-media-id") || node.getAttribute("data-id")
      : null;
    if (!raw) return null;
    return /^\d+$/.test(raw) ? raw : null;
  },
  isVideoPost(post) {
    return Boolean(post.querySelector("video"));
  },
};

/** @type {PlatformAdapter[]} */
export const ADAPTERS = [instagramAdapter, threadsAdapter, genericAdapter];

/**
 * Pick the adapter for a URL, falling back to the generic one.
 * @param {string} url
 * @returns {PlatformAdapter}
 */
export function adapterForUrl(url) {
  const href = String(url || "");
  for (const adapter of ADAPTERS) {
    if (adapter.matches.some((pattern) => matchesPattern(href, pattern))) {
      return adapter;
    }
  }
  return genericAdapter;
}

/**
 * Match a URL against a Chrome-style match pattern that may contain `*`.
 * @param {string} href
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesPattern(href, pattern) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return href === pattern;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(href);
}

/**
 * Map post elements to their extractable content.
 * @param {PlatformAdapter} adapter
 * @param {Document|Element} root
 * @param {{maxCaptionChars?: number}} [options]
 * @returns {RawPost[]}
 */
export function collectPosts(adapter, root, options = {}) {
  const maxCaptionChars = options.maxCaptionChars ?? MAX_CAPTION_CHARS;
  const elements = queryAllWithFallback(adapter.postSelectors, root);
  const posts = [];

  for (const element of elements) {
    if (element.querySelector(".aibot-placeholder")) continue;

    const img =
      queryWithFallback(adapter.imageSelectors, element) || findContentImage(element);
    const caption = readCaption(element, adapter.captionSelectors);
    const video = findContentVideo(element);

    posts.push({
      element,
      imageUrl: img ? img.getAttribute("src") : video?.poster || null,
      imageAlt: img ? img.getAttribute("alt") : null,
      caption: caption.slice(0, maxCaptionChars),
      permalink: adapter.extractPermalink ? adapter.extractPermalink(element) : null,
      mediaId: adapter.extractMediaId ? adapter.extractMediaId(element) : null,
      isVideo: adapter.isVideoPost ? adapter.isVideoPost(element) : Boolean(video),
      videoUrl: video?.src || null,
      videoThumb: video?.poster || null,
    });
  }

  return posts;
}
