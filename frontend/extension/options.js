/**
 * Options page: self-hosting and credentials.
 *
 * The backend URL was a hardcoded constant in the service worker, repeated in
 * the manifest, with no way to point the extension at a self-hosted deployment
 * without editing and rebuilding it.
 */

import { STORAGE_KEYS } from "./src/lib/defaults.js";
import {
  DEFAULT_BACKEND_URL,
  loadSettings,
  parseBackendUrl,
  readLocal,
  writeLocal,
  writeSync,
} from "./src/lib/settings.js";

const els = {
  form: document.getElementById("optionsForm"),
  backendUrl: document.getElementById("backendUrl"),
  backendUrlDefault: document.getElementById("backendUrlDefault"),
  apiKey: document.getElementById("apiKey"),
  save: document.getElementById("save"),
  reset: document.getElementById("reset"),
  test: document.getElementById("testConnection"),
  status: document.getElementById("status"),
  error: document.getElementById("error"),
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

async function populate() {
  const settings = await loadSettings();
  els.backendUrl.value = settings.backendUrl;
  els.backendUrlDefault.textContent = DEFAULT_BACKEND_URL;

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
    setError(parsed.error);
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
    setError(`Permission to reach ${parsed.url} was not granted.`);
    return;
  }

  const urlResult = await writeSync({ [STORAGE_KEYS.backendUrl]: parsed.url });
  if (!urlResult.ok) {
    setError(`Could not save the backend URL: ${urlResult.error}`);
    return;
  }

  const key = els.apiKey.value.trim();
  const keyResult = await writeLocal({ [STORAGE_KEYS.apiKey]: key });
  if (!keyResult.ok) {
    setError(`Could not save the API key: ${keyResult.error}`);
    return;
  }

  setStatus("Saved.");
}

async function onReset() {
  await writeSync({ [STORAGE_KEYS.backendUrl]: DEFAULT_BACKEND_URL });
  await writeLocal({ [STORAGE_KEYS.apiKey]: "" });
  await populate();
  setStatus("Reset to defaults.");
}

async function onTestConnection() {
  setError("");

  const parsed = parseBackendUrl(els.backendUrl.value);
  if (!parsed.ok) {
    setError(parsed.error);
    return;
  }

  els.test.disabled = true;
  setStatus("Testing…");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${parsed.url}/api/health`, {
      method: "GET",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      setError("Reachable, but the backend rejected the request. Check the API key.");
    } else if (!response.ok) {
      setError(`Reachable, but returned HTTP ${response.status}.`);
    } else {
      const body = await response.json().catch(() => ({}));
      setStatus(
        body.status === "ok"
          ? `Connected. Backend is healthy (model ${body.model || "unknown"}).`
          : `Reachable but degraded: ${JSON.stringify(body.checks || {})}`,
      );
    }
  } catch (error) {
    setError(
      error?.name === "AbortError"
        ? "No response within 8 seconds."
        : `Could not reach the backend: ${error?.message || error}`,
    );
  } finally {
    clearTimeout(timer);
    els.test.disabled = false;
  }
}

async function init() {
  await populate();
  els.form.addEventListener("submit", onSubmit);
  els.reset.addEventListener("click", onReset);
  els.test.addEventListener("click", onTestConnection);
}

void init();
