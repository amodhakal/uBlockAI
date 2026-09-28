/**
 * A small, injectable wrapper around onnxruntime-web.
 *
 * The point of this file is to make the transformer path *absent by default*.
 * A ~100 MB checkpoint and the onnxruntime-web WASM binaries are not committed
 * to this repository: they are third-party binaries, they would dominate the
 * repository size, and shipping a model nobody can audit from the source tree is
 * worse than not shipping one. The operator drops them in; see
 * docs/models/README.md. Nothing here assumes they are there, and every failure
 * path returns null or a structured status rather than throwing, because the
 * caller degrades to the heuristic scorer in local-classifier.js and a throw
 * there would take the whole content script down over a missing file.
 *
 * Every external dependency is injectable so the whole file is testable in Node
 * with no WASM, no network and no chrome.* namespace:
 *
 *   - `importImpl` stands in for the dynamic `import()` of the vendored bundle.
 *   - `fetchImpl` stands in for `fetch(chrome.runtime.getURL(...))`.
 *   - `createSession` stands in for `InferenceSession.create`.
 *
 * Two platform facts are baked in and are the reason this file is not a
 * three-line `import`:
 *
 *   1. Manifest V3 disables WebAssembly in extension pages unless
 *      `content_security_policy.extension_pages` contains `'wasm-unsafe-eval'`.
 *      Without it, `InferenceSession.create` fails at instantiation time, not at
 *      load time, which is a much worse place to find out.
 *   2. A content script cannot read a packaged extension file unless it is
 *      declared in `web_accessible_resources`. This repository deliberately
 *      declares none (src/lib/manifest.test.js pins its absence), so from a
 *      content script the fetch is refused. That is reported as
 *      `asset-unreadable`, which is deliberately distinct from `missing-asset`:
 *      the file may be installed and the model may work fine in the popup.
 */

/** Where the vendored onnxruntime-web ESM bundle goes. */
export const RUNTIME_MODULE_PATH = "vendor/ort/ort.wasm.bundle.min.mjs";

/** Where the exported ONNX checkpoint goes. */
export const MODEL_PATH = "models/classifier.onnx";

/** Where the vocabulary that matches the checkpoint goes. */
export const VOCAB_PATH = "models/vocab.txt";

/**
 * Every terminal state a session attempt can end in.
 *
 * The distinctions matter: "no model installed" tells the user to go and export
 * one, "runtime not vendored" tells them to run `npm pack onnxruntime-web`, and
 * "asset unreadable from here" tells them the configuration is fine but this
 * context cannot see it. Collapsing them into one boolean would make the popup
 * status line useless.
 */
export const SESSION_STATUS = Object.freeze({
  /** Nothing has been attempted yet. */
  IDLE: "idle",
  /** A load is in flight. */
  LOADING: "loading",
  /** The session exists and can be run. */
  READY: "ready",
  /** The runtime bundle is not in the package. */
  RUNTIME_UNAVAILABLE: "runtime-unavailable",
  /** The model file is not in the package. */
  MISSING_ASSET: "missing-asset",
  /** The model is there but this context is not allowed to read it. */
  ASSET_UNREADABLE: "asset-unreadable",
  /** Present but unusable: bad export, unsupported opset, corrupt bytes. */
  FAILED: "failed",
});

/** Statuses from which no further attempt should be made. */
const TERMINAL_STATUSES = new Set([
  SESSION_STATUS.MISSING_ASSET,
  SESSION_STATUS.ASSET_UNREADABLE,
  SESSION_STATUS.RUNTIME_UNAVAILABLE,
  SESSION_STATUS.FAILED,
]);

/**
 * Turn a package-relative path into a URL the current context can fetch.
 *
 * `chrome.runtime.getURL` is available in every extension context including
 * content scripts, so it is the only correct way to build this. The `location`
 * fallback is for tests and for the Node-side unit tests, which have neither.
 *
 * @param {string} path package-relative, e.g. "models/classifier.onnx"
 * @returns {string}
 */
export function resolveAssetUrl(path) {
  const relative = String(path || "");
  const api = typeof chrome === "undefined" ? undefined : chrome?.runtime;
  if (api && typeof api.getURL === "function") return api.getURL(relative);
  const base = globalThis.location?.href;
  if (base) return new URL(relative, base).href;
  return relative;
}

/** @returns {typeof fetch|null} */
function defaultFetch() {
  return typeof fetch === "function" ? fetch.bind(globalThis) : null;
}

/**
 * Ask whether a packaged asset is there, without downloading it.
 *
 * A HEAD probe rather than a GET: the model is ~100 MB and a readiness check
 * that streams it would be indistinguishable from loading it. A server that
 * refuses the verb reports "present but unprobed" instead of "missing", because
 * treating 405 as absent would permanently disable a model that is installed.
 *
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, method?: string}} [options]
 * @returns {Promise<{ok: boolean, status: number|null, probed: boolean, error: string|null}>}
 */
export async function probeAsset(url, options = {}) {
  const doFetch = options.fetchImpl || defaultFetch();
  if (!doFetch) {
    return { ok: false, status: null, probed: false, error: "no fetch implementation" };
  }
  try {
    const response = await doFetch(url, { method: options.method || "HEAD" });
    const status = Number(response?.status ?? 0);
    if (status === 405 || status === 501) {
      return { ok: true, status, probed: false, error: null };
    }
    return { ok: Boolean(response?.ok), status, probed: true, error: null };
  } catch (error) {
    // A thrown fetch is the shape a blocked cross-origin read takes, and it is
    // indistinguishable from "not installed" at this layer. The caller decides
    // which it is by comparing the runtime probe against this one.
    return {
      ok: false,
      status: null,
      probed: false,
      error: String(error?.message || error),
    };
  }
}

/**
 * Import the vendored onnxruntime-web bundle.
 *
 * @param {object} [options]
 * @param {string} [options.modulePath]
 * @param {(specifier: string) => Promise<any>} [options.importImpl]
 * @returns {Promise<{ok: boolean, runtime: any, error: string|null}>}
 */
export async function loadRuntime(options = {}) {
  const doImport =
    options.importImpl || ((specifier) => import(/* webpackIgnore: true */ specifier));
  const url = resolveAssetUrl(options.modulePath ?? RUNTIME_MODULE_PATH);
  try {
    const runtime = await doImport(url);
    if (typeof runtime?.InferenceSession?.create !== "function") {
      return { ok: false, runtime: null, error: "module has no InferenceSession.create" };
    }
    return { ok: true, runtime, error: null };
  } catch (error) {
    return { ok: false, runtime: null, error: String(error?.message || error) };
  }
}

/**
 * Build an int64 tensor.
 *
 * ONNX sequence-classification models declare `input_ids` as int64, and
 * onnxruntime-web rejects a plain number[] for an int64 input: a BigInt64Array
 * is required, and BigInt values are not interchangeable with numbers even
 * though both are integral. Getting this wrong produces a tensor whose values
 * are correct and whose type is not, which fails inside the runtime rather than
 * here.
 *
 * @param {any} Tensor the runtime's Tensor constructor
 * @param {string} name
 * @param {ArrayLike<number>} values
 * @param {number[]} dims
 * @returns {any|null} null when the tensor cannot be built
 */
export function toInt64Tensor(Tensor, name, values, dims) {
  if (typeof Tensor !== "function") return null;
  try {
    return new Tensor("int64", BigInt64Array.from(Array.from(values), BigInt), dims);
  } catch {
    return null;
  }
}

/**
 * A lazily created ONNX inference session for a packaged classifier.
 *
 * Nothing is loaded until {@link load} is called, and a failure is remembered,
 * so a missing model costs one failed attempt per page rather than one per post.
 */
export class OnnxSession {
  /**
   * @param {object} [options]
   * @param {string} [options.modelPath]
   * @param {string} [options.runtimePath]
   * @param {string} [options.wasmPath] directory the runtime loads its .wasm from
   * @param {(specifier: string) => Promise<any>} [options.importImpl]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {(bytes: ArrayBuffer, config: object) => Promise<any>} [options.createSession]
   * @param {string[]} [options.executionProviders]
   * @param {(status: string, detail: string|null) => void} [options.onStatus]
   */
  constructor(options = {}) {
    this.modelPath = options.modelPath ?? MODEL_PATH;
    this.runtimePath = options.runtimePath ?? RUNTIME_MODULE_PATH;
    this.wasmPath = options.wasmPath ?? "vendor/ort/";
    this.executionProviders = options.executionProviders ?? ["wasm"];
    this._importImpl = options.importImpl;
    this._fetchImpl = options.fetchImpl;
    this._createSession = options.createSession;
    this._onStatus = options.onStatus;

    this.status = SESSION_STATUS.IDLE;
    this.detail = null;
    /** @type {any} */
    this.session = null;
    /** @type {any} the loaded runtime module, kept between load attempts */
    this._runtime = null;
    this._pending = null;
  }

  /** @returns {string} */
  get modelUrl() {
    return resolveAssetUrl(this.modelPath);
  }

  /** @returns {string} */
  get runtimeUrl() {
    return resolveAssetUrl(this.runtimePath);
  }

  /**
   * A cheap, side-effect-free description of the current state.
   * @returns {{status: string, detail: string|null, modelPath: string, runtimePath: string}}
   */
  snapshot() {
    return {
      status: this.status,
      detail: this.detail,
      modelPath: this.modelPath,
      runtimePath: this.runtimePath,
    };
  }

  /**
   * Move to a status and notify the caller.
   * @param {string} status @param {string|null} detail
   */
  _setStatus(status, detail = null) {
    this.status = status;
    this.detail = detail;
    try {
      this._onStatus?.(status, detail);
    } catch {
      // A status listener is diagnostics. It must never be able to fail a load.
    }
  }

  /**
   * Check that the runtime bundle and the model are both reachable, without
   * loading the weights.
   *
   * @returns {Promise<{ready: boolean, status: string, detail: string|null}>}
   */
  async readiness() {
    if (TERMINAL_STATUSES.has(this.status)) {
      return {
        ready: this.status === SESSION_STATUS.READY,
        status: this.status,
        detail: this.detail,
      };
    }
    if (this.status === SESSION_STATUS.READY) {
      return { ready: true, status: this.status, detail: this.detail };
    }

    const [runtime, asset] = await Promise.all([
      loadRuntime({ modulePath: this.runtimePath, importImpl: this._importImpl }),
      probeAsset(this.modelUrl, { fetchImpl: this._fetchImpl }),
    ]);

    if (!runtime.ok) {
      this._setStatus(SESSION_STATUS.RUNTIME_UNAVAILABLE, runtime.error);
      return { ready: false, status: this.status, detail: runtime.error };
    }

    if (!asset.ok) {
      // A probe that came back with a status is a real 404: the operator has
      // not installed a model. A probe that never got a status at all was
      // refused before it left - that is the content-script case, where the
      // runtime bundle loaded fine and only the model read was denied. Saying
      // "missing" there would tell the operator to install something they have
      // already installed.
      const status = asset.probed
        ? SESSION_STATUS.MISSING_ASSET
        : SESSION_STATUS.ASSET_UNREADABLE;
      this._setStatus(status, asset.error);
      return { ready: false, status: this.status, detail: asset.error };
    }

    this._runtime = runtime.runtime;
    return { ready: true, status: SESSION_STATUS.IDLE, detail: null };
  }

  /**
   * Load the model, at most once per terminal outcome.
   *
   * @returns {Promise<any|null>} the session, or null when it cannot be loaded
   */
  load() {
    if (this.status === SESSION_STATUS.READY && this.session)
      return Promise.resolve(this.session);
    if (this._pending) return this._pending;
    if (TERMINAL_STATUSES.has(this.status)) return Promise.resolve(null);

    this._pending = this._load();
    return this._pending;
  }

  /** @returns {Promise<any|null>} */
  async _load() {
    this._setStatus(SESSION_STATUS.LOADING);
    try {
      const ready = await this.readiness();
      if (!ready.ready) return null;

      const runtime =
        this._runtime ??
        (
          await loadRuntime({
            modulePath: this.runtimePath,
            importImpl: this._importImpl,
          })
        ).runtime;
      if (!runtime) {
        this._setStatus(SESSION_STATUS.RUNTIME_UNAVAILABLE, "runtime vanished");
        return null;
      }

      // onnxruntime-web resolves its .wasm relative to the module URL unless it
      // is told otherwise, and the vendored copy sits next to the bundle. Left
      // unset, a build that worked in a bundler resolves against the page.
      const env = runtime.env;
      if (env?.wasm && typeof env.wasm === "object") {
        env.wasm.wasmPaths = resolveAssetUrl(this.wasmPath);
      }

      const create =
        this._createSession ||
        ((bytes, config) => runtime.InferenceSession.create(bytes, config));
      const response = await this._fetchImpl(this.modelUrl);
      if (!response || !response.ok) {
        this._setStatus(
          SESSION_STATUS.MISSING_ASSET,
          `model fetch returned ${Number(response?.status ?? 0)}`,
        );
        return null;
      }
      const bytes = await response.arrayBuffer();

      this.session = await create(bytes, {
        executionProviders: this.executionProviders,
      });
      this._setStatus(SESSION_STATUS.READY);
      return this.session;
    } catch (error) {
      this._setStatus(SESSION_STATUS.FAILED, String(error?.message || error));
      return null;
    } finally {
      this._pending = null;
    }
  }

  /**
   * Read a packaged text asset through this session's own fetch.
   *
   * The vocabulary that goes with the checkpoint is read here rather than by the
   * caller so that one fetch implementation, and therefore one answer to "can
   * this context read the package", governs every asset read. A caller with its
   * own `fetch` would get a different answer from the same page, which is
   * exactly the kind of split that makes a status line lie.
   *
   * @param {string} path package-relative
   * @returns {Promise<string|null>} the text, or null for every failure
   */
  async textAsset(path) {
    const doFetch = this._fetchImpl || defaultFetch();
    if (!doFetch) return null;
    try {
      const response = await doFetch(resolveAssetUrl(path));
      if (!response?.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  /**
   * Build an int64 input tensor for this session's runtime.
   *
   * Exposed rather than built by the caller because the `Tensor` constructor
   * only exists once the runtime module has been imported, and importing it is
   * this class's job.
   *
   * @param {string} name
   * @param {ArrayLike<number>} values
   * @param {number[]} dims
   * @returns {Promise<any|null>} null when no session could be loaded
   */
  async tensor(name, values, dims) {
    const session = await this.load();
    if (!session) return null;
    return toInt64Tensor(this._runtime?.Tensor, name, values, dims);
  }

  /**
   * Run the session over a set of named tensors.
   *
   * @param {Record<string, any>} feeds
   * @returns {Promise<any|null>} the output map, or null on any failure
   */
  async run(feeds) {
    const session = await this.load();
    if (!session) return null;
    try {
      return await session.run(feeds);
    } catch (error) {
      this._setStatus(SESSION_STATUS.FAILED, String(error?.message || error));
      return null;
    }
  }

  /** Release the session. Safe to call when nothing was ever loaded. */
  async close() {
    try {
      await this.session?.release?.();
    } catch {
      // Already gone.
    }
    this.session = null;
    this._pending = null;
    this._runtime = null;
    this._setStatus(SESSION_STATUS.IDLE);
  }

  /**
   * Forget a remembered failure, so a freshly installed model can be picked up
   * without reloading the page.
   */
  reset() {
    this.session = null;
    this._pending = null;
    this._runtime = null;
    this._setStatus(SESSION_STATUS.IDLE);
  }
}

/**
 * @param {Parameters<typeof OnnxSession>[0]} [options]
 * @returns {OnnxSession}
 */
export function createOnnxSession(options = {}) {
  return new OnnxSession(options);
}

/**
 * A short, developer-facing description of a status. English on purpose: this
 * goes into a log line, which has to stay greppable after the fact.
 *
 * @param {string} status
 * @param {string|null} [detail]
 * @returns {string}
 */
export function describeSessionStatus(status, detail = null) {
  const base = {
    [SESSION_STATUS.IDLE]: "no onnx session has been attempted",
    [SESSION_STATUS.LOADING]: "loading the onnx session",
    [SESSION_STATUS.READY]: "onnx session ready",
    [SESSION_STATUS.RUNTIME_UNAVAILABLE]: "onnxruntime-web is not vendored in this build",
    [SESSION_STATUS.MISSING_ASSET]: "no onnx model asset is installed",
    [SESSION_STATUS.ASSET_UNREADABLE]:
      "the onnx model asset is not readable from this context",
    [SESSION_STATUS.FAILED]: "the onnx session failed to load",
  }[status];
  const text = base || `unknown onnx session status: ${status}`;
  return detail ? `${text} (${detail})` : text;
}
