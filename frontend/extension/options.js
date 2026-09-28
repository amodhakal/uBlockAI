/**
 * Options page: self-hosting, credentials and trust settings.
 *
 * The backend URL was a hardcoded constant in the service worker, repeated in
 * the manifest, with no way to point the extension at a self-hosted deployment
 * without editing and rebuilding it.
 */

import { FONT_SCALE_ORDER, FONT_SCALES, STORAGE_KEYS } from "./src/lib/defaults.js";
import { applyTranslations, setDocumentLocale, t } from "./src/lib/i18n.js";
import {
  DEFAULT_BACKEND_URL,
  applyFontScale,
  loadSettings,
  parseBackendUrl,
  readLocal,
  writeLocal,
  writeSync,
} from "./src/lib/settings.js";
import {
  clearTrustedKeys,
  describeTrustedKey,
  normalizeTrustedKeys,
  removeTrustedKey,
} from "./src/lib/trust.js";

/** Message name for each text-size option. */
const FONT_SCALE_LABEL_KEYS = {
  [FONT_SCALES.SMALL]: "fontScaleSmall",
  [FONT_SCALES.MEDIUM]: "fontScaleMedium",
  [FONT_SCALES.LARGE]: "fontScaleLarge",
};

const els = {
  form: document.getElementById("optionsForm"),
  backendUrl: document.getElementById("backendUrl"),
  backendUrlHelp: document.getElementById("backendUrlHelp"),
  apiKey: document.getElementById("apiKey"),
  fontScale: document.getElementById("fontScale"),
  save: document.getElementById("save"),
  reset: document.getElementById("reset"),
  test: document.getElementById("testConnection"),
  status: document.getElementById("status"),
  error: document.getElementById("error"),
  trustList: document.getElementById("trustList"),
  trustEmpty: document.getElementById("trustEmpty"),
  trustStatus: document.getElementById("trustStatus"),
  clearTrusted: document.getElementById("clearTrusted"),
};

function setStatus(message, tone = "ok") {
  els.status.textContent = message;
  els.status.dataset.tone = tone;
  els.error.textContent = "";
}

function setError(message) {
  els.error.textContent = message;
  els.status.textContent = "";
}

/**
 * Render a parseBackendUrl failure.
 *
 * The message name carries the translation; `error` is the English the service
 * worker logs, and is used when the catalogue has no entry for it.
 */
function setParseError(parsed) {
  setError(t(parsed.errorKey, parsed.errorParams) || parsed.error);
}

function fillFontScaleSelect(selected) {
  els.fontScale.replaceChildren();
  for (const scale of FONT_SCALE_ORDER) {
    const option = document.createElement("option");
    option.value = scale;
    option.textContent = t(FONT_SCALE_LABEL_KEYS[scale]);
    els.fontScale.append(option);
  }
  els.fontScale.value = selected;
}

async function populate() {
  const settings = await loadSettings();
  els.backendUrl.value = settings.backendUrl;
  // Re-interpolated rather than left as the value applyTranslations wrote,
  // because the message carries a $URL$ placeholder for the hosted default.
  els.backendUrlHelp.textContent = t("optionsBackendUrlHelp", [DEFAULT_BACKEND_URL]);
  // Applied before the select is filled, so the options are measured at the size
  // the user chose rather than jumping after the first paint.
  applyFontScale(settings.fontScale);
  fillFontScaleSelect(settings.fontScale);

  // The key is stored in local storage, not sync, so read it directly.
  const local = await readLocal([STORAGE_KEYS.apiKey]);
  els.apiKey.value =
    typeof local[STORAGE_KEYS.apiKey] === "string" ? local[STORAGE_KEYS.apiKey] : "";
}

async function onSubmit(event) {
  event.preventDefault();
  setError("");

  const parsed = parseBackendUrl(els.backendUrl.value);
  if (!parsed.ok) {
    // Do not fall back to the default here. Silently writing the default on a
    // typo is the worst possible outcome: the user believes they are pointing
    // at their own server and are not.
    setParseError(parsed);
    els.backendUrl.focus();
    return;
  }

  // Host permission must be requested from a user gesture. A self-hosted
  // backend the extension has no permission for fails as an opaque
  // "Failed to fetch" in the service worker.
  let granted = true;
  try {
    granted = await chrome.permissions.request({ origins: [`${parsed.url}/*`] });
  } catch {
    granted = false;
  }
  if (!granted) {
    setError(t("optionsErrorPermission", [parsed.url]));
    return;
  }

  const urlResult = await writeSync({ [STORAGE_KEYS.backendUrl]: parsed.url });
  if (!urlResult.ok) {
    setError(t("optionsErrorSaveUrl", [urlResult.error]));
    return;
  }

  const key = els.apiKey.value.trim();
  const keyResult = await writeLocal({ [STORAGE_KEYS.apiKey]: key });
  if (!keyResult.ok) {
    setError(t("optionsErrorSaveKey", [keyResult.error]));
    return;
  }

  setStatus(t("optionsStatusSaved"));
}

async function onReset() {
  await writeSync({ [STORAGE_KEYS.backendUrl]: DEFAULT_BACKEND_URL });
  await writeLocal({ [STORAGE_KEYS.apiKey]: "" });
  await populate();
  setStatus(t("optionsStatusReset"));
}

async function onFontScaleChange(event) {
  const scale = event.target.value;
  applyFontScale(scale);
  const result = await writeSync({ [STORAGE_KEYS.fontScale]: scale });
  if (!result.ok) {
    setError(t("optionsErrorSaveUrl", [result.error]));
  }
}

async function onTestConnection() {
  setError("");

  const parsed = parseBackendUrl(els.backendUrl.value);
  if (!parsed.ok) {
    setParseError(parsed);
    return;
  }

  els.test.disabled = true;
  setStatus(t("optionsStatusTesting"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${parsed.url}/api/health`, {
      method: "GET",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      setError(t("optionsErrorRejected"));
    } else if (!response.ok) {
      setError(t("optionsErrorHttpStatus", [String(response.status)]));
    } else {
      const body = await response.json().catch(() => ({}));
      setStatus(
        body.status === "ok"
          ? t("optionsStatusConnected", [body.model || "unknown"])
          : t("optionsStatusDegraded", [JSON.stringify(body.checks || {})]),
      );
    }
  } catch (error) {
    setError(
      error?.name === "AbortError"
        ? t("optionsErrorTimeout")
        : t("optionsErrorUnreachable", [error?.message || String(error)]),
    );
  } finally {
    clearTimeout(timer);
    els.test.disabled = false;
  }
}

async function init() {
  setDocumentLocale();
  applyTranslations(document);
  await populate();
  els.form.addEventListener("submit", onSubmit);
  els.reset.addEventListener("click", onReset);
  els.test.addEventListener("click", onTestConnection);
  els.fontScale.addEventListener("change", onFontScaleChange);
  await renderTrusted();
  els.clearTrusted.addEventListener("click", onClearTrusted);
}

// --------------------------------------------------------------------------
// Trust settings
// --------------------------------------------------------------------------

function setTrustStatus(message) {
  els.trustStatus.textContent = message;
}

/**
 * Replace the trust list with one row per trusted post.
 *
 * Every node is built with createElement and filled with textContent. The keys
 * are derived from CDN URLs on posts the user chose to trust, so they are
 * attacker-influenced: an innerHTML template here would be an injection point
 * in a page that can already reach the extension's storage.
 */
async function renderTrusted() {
  const settings = await loadSettings();
  const keys = normalizeTrustedKeys(settings.trustedKeys);

  els.trustList.replaceChildren();
  for (const key of keys) {
    const row = document.createElement("li");

    const label = document.createElement("span");
    label.className = "trust-key";
    // Short, recognisable form; the full key stays available on hover.
    label.textContent = describeTrustedKey(key);
    label.title = key;
    row.append(label);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Stop trusting ${describeTrustedKey(key)}`);
    remove.addEventListener("click", () => {
      void onRemoveTrusted(key);
    });
    row.append(remove);

    els.trustList.append(row);
  }

  els.trustEmpty.textContent = keys.length === 0 ? "No posts are trusted yet." : "";
  els.clearTrusted.disabled = keys.length === 0;
}

async function onRemoveTrusted(key) {
  const { keys, removed } = removeTrustedKey(
    normalizeTrustedKeys((await loadSettings()).trustedKeys),
    key,
  );
  if (!removed) return;

  const result = await writeSync({ [STORAGE_KEYS.trustedKeys]: keys });
  if (!result.ok) {
    setTrustStatus(`Could not update the trust list: ${result.error}`);
    return;
  }
  await renderTrusted();
  setTrustStatus("Removed. The post will be hidden again if it trips a threshold.");
}

async function onClearTrusted() {
  const { keys, removed } = clearTrustedKeys(
    normalizeTrustedKeys((await loadSettings()).trustedKeys),
  );
  if (removed === 0) return;

  const result = await writeSync({ [STORAGE_KEYS.trustedKeys]: keys });
  if (!result.ok) {
    setTrustStatus(`Could not update the trust list: ${result.error}`);
    return;
  }
  await renderTrusted();
  setTrustStatus(`Cleared ${removed} trusted ${removed === 1 ? "post" : "posts"}.`);
}

void init();
