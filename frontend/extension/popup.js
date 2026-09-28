/**
 * Popup: settings and statistics.
 *
 * Every value here comes from the shared defaults module and from storage, so
 * the popup cannot display a different default than the content script applies.
 */

import {
  FONT_SCALE_ORDER,
  FONT_SCALES,
  HIDING_ACTIONS,
  SLIDER_MAX,
  SLIDER_MIN,
  STORAGE_KEYS,
  fromSlider,
  toSlider,
} from "./src/lib/defaults.js";
import { applyTranslations, setDocumentLocale, t } from "./src/lib/i18n.js";
import {
  applyFontScale,
  loadSettings,
  readLocal,
  writeSync,
} from "./src/lib/settings.js";
import { REPORT_KIND_LIST, bucketFor } from "./src/lib/feedback.js";
import {
  TELEMETRY_METRICS,
  buildTelemetryEvent,
  resetPendingCounts,
} from "./src/lib/telemetry.js";

const BRAND = "uBlockAI";

/** Human labels for the hiding actions, in the order they should appear. */
const ACTION_LABEL_KEYS = {
  [HIDING_ACTIONS.PLACEHOLDER]: "popupActionPlaceholder",
  [HIDING_ACTIONS.BLUR]: "popupActionBlur",
  [HIDING_ACTIONS.REMOVE]: "popupActionRemove",
};

/** Message name for each text-size option. */
const FONT_SCALE_LABEL_KEYS = {
  [FONT_SCALES.SMALL]: "fontScaleSmall",
  [FONT_SCALES.MEDIUM]: "fontScaleMedium",
  [FONT_SCALES.LARGE]: "fontScaleLarge",
};

/** Hosts the extension is expected to run on. */
const SUPPORTED = ["instagram.com", "threads.net"];

const els = {
  error: document.getElementById("errorMessage"),
  errorBody: document.getElementById("errorBody"),
  content: document.getElementById("contentSection"),
  aiSlider: document.getElementById("aiThreshold"),
  aiValue: document.getElementById("aiThresholdValue"),
  newsSlider: document.getElementById("newsThreshold"),
  newsValue: document.getElementById("newsThresholdValue"),
  actionSelect: document.getElementById("hidingAction"),
  fontScaleSelect: document.getElementById("fontScale"),
  hiddenCount: document.getElementById("hiddenCount"),
  analyzedCount: document.getElementById("analyzedCount"),
  reportedCount: document.getElementById("reportedCount"),
  optionsLink: document.getElementById("optionsLink"),
  debugLogging: document.getElementById("debugLogging"),
  telemetryEnabled: document.getElementById("telemetryEnabled"),
  telemetryDetails: document.getElementById("telemetryDetails"),
};

/**
 * Show the off-site notice.
 *
 * The notice is a `role="status"` region rather than a modal dialog: it must not
 * steal focus from the threshold sliders, which remain usable off-site. Focus
 * moves to the heading rather than the first control, because the user opened
 * the popup to find out why the counters are empty.
 *
 * @param {string} [message] overrides the body text
 */
function showError(message) {
  if (message) {
    els.errorBody.textContent = message;
  }
  els.error.classList.add("visible");
  els.content.classList.add("visible");
  els.error.focus();
}

async function currentTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || tab?.pendingUrl || "";
}

function isSupported(url) {
  return SUPPORTED.some((host) => url.includes(host));
}

/** Fill a select from a list of [value, messageName] pairs. */
function fillSelect(select, entries, selected) {
  select.replaceChildren();
  for (const [value, messageKey] of entries) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = t(messageKey);
    select.append(option);
  }
  select.value = selected;
}

async function refreshStats() {
  // Counters live in storage.local (high-churn, not synced). Reading sync
  // here showed a permanent zero.
  const data = await readLocal([STORAGE_KEYS.hiddenCount, STORAGE_KEYS.analyzedCount]);
  els.hiddenCount.textContent = String(Number(data[STORAGE_KEYS.hiddenCount] ?? 0) || 0);
  els.analyzedCount.textContent = String(
    Number(data[STORAGE_KEYS.analyzedCount] ?? 0) || 0,
  );

  // Posts the user reported, in either direction. The queues are pruned on
  // upload and on age, so this is "reports still pending", which is the
  // honest reading of it and the only one available.
  const queues = await readLocal(REPORT_KIND_LIST.map(bucketFor));
  els.reportedCount.textContent = String(
    REPORT_KIND_LIST.reduce((total, kind) => {
      const queue = queues[bucketFor(kind)];
      return total + (Array.isArray(queue) ? queue.length : 0);
    }, 0),
  );
}

async function init() {
  setDocumentLocale();
  applyTranslations(document);

  const url = await currentTabUrl();
  if (!isSupported(url)) {
    showError(t("popupUnsupportedDetail", [BRAND]));
  }

  const settings = await loadSettings();
  // Applied before anything is measured, so the control the user is about to
  // drag is the size it will render at.
  applyFontScale(settings.fontScale);

  // The slider range and the available hiding actions come from the shared
  // constants rather than from markup. They used to be hardcoded in the HTML,
  // where they had already drifted: the markup said the AI threshold defaulted
  // to 3 while the constant it duplicated resolves to 4.
  for (const slider of [els.aiSlider, els.newsSlider]) {
    slider.min = String(SLIDER_MIN);
    slider.max = String(SLIDER_MAX);
    slider.step = "1";
  }

  fillSelect(
    els.actionSelect,
    Object.values(HIDING_ACTIONS).map((action) => [action, ACTION_LABEL_KEYS[action]]),
    settings.hidingAction,
  );
  fillSelect(
    els.fontScaleSelect,
    FONT_SCALE_ORDER.map((scale) => [scale, FONT_SCALE_LABEL_KEYS[scale]]),
    settings.fontScale,
  );

  els.aiSlider.value = String(toSlider(settings.aiGeneratedThreshold));
  els.aiValue.textContent = els.aiSlider.value;
  els.newsSlider.value = String(toSlider(settings.newsThreshold));
  els.newsValue.textContent = els.newsSlider.value;
  els.debugLogging.checked = settings.debugLogging;
  els.telemetryEnabled.checked = settings.telemetryEnabled;

  // "What is sent" shows the payload shape, built by the same module that
  // builds the real one, so the description cannot drift from the behaviour.
  els.telemetryDetails.addEventListener("click", (event) => {
    event.preventDefault();
    const example = buildTelemetryEvent(true, { [TELEMETRY_METRICS.ANALYZED]: 12 });
    window.alert(
      "When enabled, the extension periodically sends counts like:\n\n" +
        `${JSON.stringify(example, null, 2)}\n\n` +
        "Nothing else. No captions, image URLs, post links, or account " +
        "information, and no timestamps for individual posts.",
    );
  });

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

  els.fontScaleSelect.addEventListener("change", (event) => {
    const scale = event.target.value;
    // Applied locally too, so the change is visible before the storage write
    // resolves. The content script picks it up through onSettingsChanged.
    applyFontScale(scale);
    void writeSync({ [STORAGE_KEYS.fontScale]: scale });
  });

  els.debugLogging.addEventListener("change", (event) => {
    void writeSync({ [STORAGE_KEYS.debugLogging]: event.target.checked });
  });

  els.telemetryEnabled.addEventListener("change", (event) => {
    const enabled = event.target.checked;
    void writeSync({ [STORAGE_KEYS.telemetryEnabled]: enabled }).then(async () => {
      // Turning it off drops anything already queued. The counts stay on the
      // device as local statistics, but there is no longer a pending batch, so
      // switching the flag back on cannot resurrect and upload an older total
      // the user did not expect to send.
      if (!enabled) await resetPendingCounts();
    });
  });

  els.optionsLink.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  await refreshStats();

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== "local") return;
    const watched = [
      STORAGE_KEYS.hiddenCount,
      STORAGE_KEYS.analyzedCount,
      ...REPORT_KIND_LIST.map(bucketFor),
    ];
    if (watched.some((key) => key in changes)) refreshStats();
  });
}

void init();

export { BRAND, HIDING_ACTIONS };
