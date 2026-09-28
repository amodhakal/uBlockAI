/**
 * Popup: settings and statistics.
 *
 * Every value here comes from the shared defaults module and from storage, so
 * the popup cannot display a different default than the content script applies.
 */

import {
  HIDING_ACTIONS,
  SLIDER_MAX,
  SLIDER_MIN,
  STORAGE_KEYS,
  fromSlider,
  toSlider,
} from "./src/lib/defaults.js";
import { loadSettings, readSync, writeSync } from "./src/lib/settings.js";

const BRAND = "uBlockAI";

/** Human labels for the hiding actions, in the order they should appear. */
const ACTION_LABELS = {
  [HIDING_ACTIONS.PLACEHOLDER]: "Replace with a warning",
  [HIDING_ACTIONS.BLUR]: "Blur the image",
  [HIDING_ACTIONS.REMOVE]: "Remove it from the feed",
};

/** Hosts the extension is expected to run on. */
const SUPPORTED = ["instagram.com", "threads.net"];

const els = {
  error: document.getElementById("errorMessage"),
  content: document.getElementById("contentSection"),
  aiSlider: document.getElementById("aiThreshold"),
  aiValue: document.getElementById("aiThresholdValue"),
  newsSlider: document.getElementById("newsThreshold"),
  newsValue: document.getElementById("newsThresholdValue"),
  actionSelect: document.getElementById("hidingAction"),
  hiddenCount: document.getElementById("hiddenCount"),
  analyzedCount: document.getElementById("analyzedCount"),
  optionsLink: document.getElementById("optionsLink"),
  debugLogging: document.getElementById("debugLogging"),
};

function showError(message) {
  els.error.querySelector("p").textContent = message;
  els.error.classList.add("visible");
  els.content.classList.remove("visible");
}

async function currentTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || tab?.pendingUrl || "";
}

function isSupported(url) {
  return SUPPORTED.some((host) => url.includes(host));
}

async function refreshStats() {
  const data = await readSync([STORAGE_KEYS.hiddenCount, STORAGE_KEYS.analyzedCount]);
  els.hiddenCount.textContent = String(Number(data[STORAGE_KEYS.hiddenCount] ?? 0) || 0);
  els.analyzedCount.textContent = String(
    Number(data[STORAGE_KEYS.analyzedCount] ?? 0) || 0,
  );
}

async function init() {
  const url = await currentTabUrl();
  if (!isSupported(url)) {
    showError(
      `${BRAND} analyses posts on Instagram and Threads. Open Instagram.com or Threads.net to use it, ` +
        "or change the threshold settings from the extension options page.",
    );
    // Settings remain editable off-site; only the post count is hidden.
    els.content.classList.add("visible");
  }

  const settings = await loadSettings();

  // The slider range and the available hiding actions come from the shared
  // constants rather than from markup. They used to be hardcoded in the HTML,
  // where they had already drifted: the markup said the AI threshold defaulted
  // to 3 while the constant it duplicated resolves to 4.
  for (const slider of [els.aiSlider, els.newsSlider]) {
    slider.min = String(SLIDER_MIN);
    slider.max = String(SLIDER_MAX);
    slider.step = "1";
  }

  for (const action of Object.values(HIDING_ACTIONS)) {
    const option = document.createElement("option");
    option.value = action;
    option.textContent = ACTION_LABELS[action] ?? action;
    els.actionSelect.append(option);
  }

  els.aiSlider.value = String(toSlider(settings.aiGeneratedThreshold));
  els.aiValue.textContent = els.aiSlider.value;
  els.newsSlider.value = String(toSlider(settings.newsThreshold));
  els.newsValue.textContent = els.newsSlider.value;
  els.actionSelect.value = settings.hidingAction;
  els.debugLogging.checked = settings.debugLogging;

  els.aiSlider.addEventListener("input", (event) => {
    const sliderValue = Number(event.target.value);
    els.aiValue.textContent = String(sliderValue);
    void writeSync({
      [STORAGE_KEYS.aiGeneratedThreshold]: fromSlider(sliderValue),
    });
  });

  els.newsSlider.addEventListener("input", (event) => {
    const sliderValue = Number(event.target.value);
    els.newsValue.textContent = String(sliderValue);
    void writeSync({ [STORAGE_KEYS.newsThreshold]: fromSlider(sliderValue) });
  });

  els.actionSelect.addEventListener("change", (event) => {
    void writeSync({ [STORAGE_KEYS.hidingAction]: event.target.value });
  });

  els.debugLogging.addEventListener("change", (event) => {
    void writeSync({ [STORAGE_KEYS.debugLogging]: event.target.checked });
  });

  els.optionsLink.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  await refreshStats();

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== "sync") return;
    if (changes[STORAGE_KEYS.hiddenCount]) refreshStats();
    if (changes[STORAGE_KEYS.analyzedCount]) refreshStats();
  });
}

void init();

export { BRAND, HIDING_ACTIONS };
