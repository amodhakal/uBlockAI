/**
 * The onnxruntime-web session wrapper.
 *
 * Every test here runs with a fake runtime, a fake fetch and no WebAssembly, no
 * network and no chrome.* namespace. That is the point of the file's design: if
 * the transformer path could only be exercised with a real model, it would be
 * exercised approximately never.
 *
 * The block that matters most is the last one. This repository ships no model
 * and no runtime binaries, on purpose, and the tests below pin that as a
 * property rather than leaving it as a fact in a README that drifts.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  MODEL_PATH,
  RUNTIME_MODULE_PATH,
  SESSION_STATUS,
  createOnnxSession,
  describeSessionStatus,
  probeAsset,
  resolveAssetUrl,
  toInt64Tensor,
} from "./onnx-session.js";

/** A stand-in for onnxruntime-web's Tensor. Records what it was handed. */
class FakeTensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

/**
 * A runtime module that behaves like the real one closely enough to exercise
 * the loader: an env with a wasm bag, a Tensor constructor, and a session whose
 * run returns a logits tensor.
 *
 * The fakes return plain values rather than promises. Every one of them is
 * awaited by the code under test, so a value is a valid answer, and it keeps
 * the doubles readable.
 *
 * @param {{logits?: number[]}} [options]
 */
function fakeRuntime(options = {}) {
  const logits = options.logits ?? [0.1, 3.2];
  return {
    env: { wasm: {} },
    Tensor: FakeTensor,
    InferenceSession: {
      create: () => ({
        run: () => ({
          logits: { data: Float32Array.from(logits), dims: [1, logits.length] },
        }),
        release: () => {},
      }),
    },
  };
}

/**
 * A fetch that answers HEAD for probes and GET for the model.
 *
 * @param {{model?: "ok"|"404"|"throw"|"noVerb"}} [options]
 */
function fakeFetch(options = {}) {
  const model = options.model ?? "ok";
  const state = { heads: 0, gets: 0, urls: [] };
  const impl = (url, init) => {
    const method = String(init?.method || "GET").toUpperCase();
    state.urls.push(String(url));
    if (method === "HEAD") {
      state.heads += 1;
      if (model === "throw") throw new TypeError("Failed to fetch");
      if (model === "404") return { ok: false, status: 404 };
      if (model === "noVerb") return { ok: false, status: 405 };
      return { ok: true, status: 200 };
    }
    state.gets += 1;
    if (model === "throw") throw new TypeError("Failed to fetch");
    if (model === "404") return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: () => new ArrayBuffer(16) };
  };
  return { impl, state };
}

/**
 * A session wired to fakes.
 * @param {{runtime?: "ok"|"missing"|"wrong", model?: string, create?: Function}} [options]
 */
function wiredSession(options = {}) {
  const runtime = options.runtime ?? "ok";
  const fetchFake = fakeFetch({ model: options.model });
  const session = createOnnxSession({
    importImpl: () => {
      if (runtime === "missing") throw new Error("Cannot find module 'vendor/ort'");
      if (runtime === "wrong") return { somethingElse: true };
      return fakeRuntime();
    },
    fetchImpl: fetchFake.impl,
    createSession: options.create,
  });
  return { session, fetch: fetchFake };
}

// --------------------------------------------------------------------------
// Degradation
// --------------------------------------------------------------------------

test("a missing model yields no session instead of an exception", async () => {
  // The shipped repository has no model file, so this is the path every page
  // takes until an operator installs one. It must be silent, or the content
  // script stops scanning the feed.
  const { session } = wiredSession({ model: "404" });
  assert.equal(await session.load(), null);
  assert.equal(session.status, SESSION_STATUS.MISSING_ASSET);
});

test("a runtime that is not vendored is not reported as a missing model", async () => {
  // The two failures need opposite actions from whoever is installing this:
  // one means "export a checkpoint", the other means "npm pack
  // onnxruntime-web". Collapsing them sends people to re-download something
  // they already have.
  const { session, fetch } = wiredSession({ runtime: "missing" });
  assert.equal(await session.load(), null);
  assert.equal(session.status, SESSION_STATUS.RUNTIME_UNAVAILABLE);
  assert.equal(fetch.state.gets, 0, "it tried to download a model it could not run");
});

test("a module that is present but is not onnxruntime-web is rejected", async () => {
  const { session } = wiredSession({ runtime: "wrong" });
  assert.equal(await session.load(), null);
  assert.equal(session.status, SESSION_STATUS.RUNTIME_UNAVAILABLE);
  assert.match(String(session.detail), /InferenceSession/);
});

test("a model this context is not allowed to read is not called missing", async () => {
  // This is the content-script case: the runtime bundle loaded, so the
  // configuration is right, and only the model read was refused because the
  // repository declares no web_accessible_resources. Saying "missing" would be
  // a lie the popup would then show to the user.
  const { session } = wiredSession({ model: "throw" });
  assert.equal(await session.load(), null);
  assert.equal(session.status, SESSION_STATUS.ASSET_UNREADABLE);
});

test("a model that refuses a HEAD probe is still attempted", async () => {
  // A 405 on the probe says nothing about whether the file exists, and
  // treating it as absent would permanently disable a model that is installed.
  const { session } = wiredSession({ model: "noVerb" });
  assert.ok(await session.load());
  assert.equal(session.status, SESSION_STATUS.READY);
});

test("a broken export fails soft and records why", async () => {
  const { session } = wiredSession({
    create: () => {
      throw new Error("Unrecognized opset 42");
    },
  });
  assert.equal(await session.load(), null);
  assert.equal(session.status, SESSION_STATUS.FAILED);
  assert.match(String(session.detail), /opset/);
});

test("a failed load is remembered instead of retried once per post", async () => {
  // A feed holds dozens of posts. Re-probing for each one turns a missing
  // asset into dozens of pointless imports per page.
  const { session, fetch } = wiredSession({ model: "404" });
  await session.load();
  await session.load();
  await session.load();
  assert.equal(fetch.state.heads, 1);
  assert.equal(await session.load(), null);
});

test("a forgotten failure can be retried after an operator installs a model", async () => {
  // Otherwise the popup would keep reporting a stale state until every open tab
  // was reloaded, which is exactly the moment someone gives up.
  const { session } = wiredSession({ model: "404" });
  await session.load();
  assert.equal(session.status, SESSION_STATUS.MISSING_ASSET);
  session.reset();
  assert.equal(session.status, SESSION_STATUS.IDLE);
  assert.equal(await session.load(), null, "the fake is still missing it, so still null");
  assert.equal(session.status, SESSION_STATUS.MISSING_ASSET);
});

test("a session that throws while running returns nothing rather than rejecting", async () => {
  // classify() treats a null return and a throw differently, and only one of
  // them is survivable from a content script.
  const { session } = wiredSession();
  await session.load();
  session.session = {
    run: () => {
      throw new Error("Invalid input shape");
    },
  };
  assert.equal(await session.run({}), null);
});

// --------------------------------------------------------------------------
// Correct plumbing
// --------------------------------------------------------------------------

test("int64 inputs are built as a BigInt64Array, not as numbers", async () => {
  // Sequence-classification graphs declare input_ids as int64. A plain number[]
  // is rejected by onnxruntime-web at run time, and a tensor with the right
  // values and the wrong type fails inside the runtime rather than here.
  const { session } = wiredSession();
  const tensor = await session.tensor("input_ids", [2, 10, 3], [1, 3]);
  assert.equal(tensor.type, "int64");
  assert.ok(tensor.data instanceof BigInt64Array);
  assert.deepEqual(Array.from(tensor.data, Number), [2, 10, 3]);
  assert.deepEqual(tensor.dims, [1, 3]);
});

test("toInt64Tensor returns null when the runtime has no Tensor constructor", () => {
  // No runtime means no Tensor. Returning a broken tensor would be worse than
  // returning nothing the caller can check.
  assert.equal(toInt64Tensor(null, "input_ids", [1], [1, 1]), null);
  assert.equal(toInt64Tensor(undefined, "input_ids", [1], [1, 1]), null);
});

test("a readiness check downloads nothing", async () => {
  // The popup renders one line of status. Streaming 100 MB of weights to do it
  // would make the popup slower than the thing it is describing.
  const { session, fetch } = wiredSession();
  const readiness = await session.readiness();
  assert.equal(readiness.ready, true);
  assert.equal(fetch.state.gets, 0, "the probe fetched the model");
  assert.equal(fetch.state.heads, 1);
  assert.equal(session.status, SESSION_STATUS.IDLE, "a probe must not start a load");
});

test("the runtime is told where its own wasm file lives", async () => {
  // onnxruntime-web resolves its .wasm relative to the page unless told
  // otherwise, and the vendored copy sits next to the bundle rather than at the
  // site root. Without this the session fails at instantiation with a fetch
  // error that does not mention the missing file.
  const runtime = fakeRuntime();
  const session = createOnnxSession({
    importImpl: () => runtime,
    fetchImpl: fakeFetch().impl,
  });
  await session.load();
  assert.match(String(runtime.env.wasm.wasmPaths), /vendor\/ort\//);
});

test("asset URLs are resolved through chrome.runtime when it is available", () => {
  // chrome.runtime.getURL is the only way to build a fetchable extension URL,
  // and it is available in content scripts as well as extension pages.
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: { getURL: (path) => `chrome-extension://abc/${path}` } };
  try {
    assert.equal(resolveAssetUrl(MODEL_PATH), `chrome-extension://abc/${MODEL_PATH}`);
  } finally {
    globalThis.chrome = previous;
  }
  // And a bare path is still usable when there is no chrome at all, which is the
  // only way these tests can run under Node.
  assert.ok(resolveAssetUrl(MODEL_PATH).endsWith(MODEL_PATH));
});

test("a probe that throws reports a failure rather than propagating", async () => {
  const result = await probeAsset("chrome-extension://abc/x.onnx", {
    fetchImpl: () => {
      throw new Error("refused");
    },
  });
  assert.equal(result.ok, false);
  // probed=false is the load-bearing field: it is how "the read was refused" is
  // told apart from "the server said 404".
  assert.equal(result.probed, false);
  assert.match(String(result.error), /refused/);
});

test("every status describes itself in a sentence a log can be read with", () => {
  // English on purpose: this text ends up in a log line, which has to stay
  // greppable long after the locale has changed.
  for (const status of Object.values(SESSION_STATUS)) {
    const described = describeSessionStatus(status);
    assert.ok(described.length > 10, `${status} has no useful description`);
    assert.ok(!/^[a-z-]+$/.test(described), `${status} description is a bare enum`);
  }
  assert.match(describeSessionStatus(SESSION_STATUS.FAILED, "opset 42"), /opset 42/);
});

// --------------------------------------------------------------------------
// Nothing binary is committed
// --------------------------------------------------------------------------

test("no model or runtime binary is committed to the repository", () => {
  // A small random-weight tensor would satisfy every interface and produce
  // confident, meaningless scores, which is worse than having no model at all.
  // The absence is a design decision, so it is asserted rather than assumed.
  const root = new URL("../../", import.meta.url);
  assert.equal(
    existsSync(new URL(MODEL_PATH, root)),
    false,
    "a model artefact was committed; see docs/models/README.md for the policy",
  );
  assert.equal(existsSync(new URL("vendor/ort/", root)), false);
  assert.equal(existsSync(new URL("models/vocab.txt", root)), false);
});

test("the operator-supplied model paths are gitignored", () => {
  // Otherwise the first person to follow docs/models/README.md commits 100 MB
  // to main, and the second commit in this repository's history is 100 MB of
  // weights nobody can audit.
  const gitignore = readFileSync(
    new URL("../../../../.gitignore", import.meta.url),
    "utf8",
  );
  assert.match(gitignore, /frontend\/extension\/vendor\/ort\//);
  assert.match(gitignore, /frontend\/extension\/models\//);
  assert.match(gitignore, /\*\.onnx/);
});

test("the manifest allows WebAssembly in extension pages", () => {
  // Manifest V3's default policy is "script-src 'self'; object-src 'self';",
  // which disables WebAssembly outright. onnxruntime-web then fails at
  // session-creation time, which is the most expensive possible place to find
  // out that a policy is missing.
  const manifest = JSON.parse(
    readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
  );
  const policy = manifest.content_security_policy?.extension_pages;
  assert.ok(policy, "no extension_pages policy, so WASM is disabled by default");
  assert.match(policy, /'wasm-unsafe-eval'/);
  // Chrome rejects the extension outright if anything beyond 'self' and
  // 'wasm-unsafe-eval' appears in script-src.
  assert.ok(
    !/'unsafe-eval'/.test(policy),
    "'unsafe-eval' makes the extension uninstallable",
  );
  assert.match(policy, /object-src 'self'/);
});

test("the manifest still declares no web-accessible resources", () => {
  // Reading a packaged model from a content script needs
  // web_accessible_resources. This repository does not add it: the placeholder
  // needs no web-accessible image, and exposing models/* would hand the weights
  // to every site the user visits. The consequence is documented, not fixed.
  const manifest = JSON.parse(
    readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.web_accessible_resources, undefined);
});

test("no new permission was added for the model", () => {
  // Reading a packaged file needs no permission at all, and the ONNX path is
  // optional. Requesting anything here would be a permanent grant for a
  // feature most users will never enable.
  const manifest = JSON.parse(
    readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(manifest.permissions, ["storage", "alarms"]);
});

test("the documented drop-in paths are the ones the loader looks for", () => {
  // A README that names different paths than the code is worse than no README:
  // the operator follows it, the model never loads, and the feature looks
  // broken rather than uninstalled.
  const readme = readFileSync(
    new URL("../../../../docs/models/README.md", import.meta.url),
    "utf8",
  );
  assert.ok(readme.includes(RUNTIME_MODULE_PATH), "the runtime path is not documented");
  assert.ok(readme.includes(MODEL_PATH), "the model path is not documented");
  assert.ok(readme.includes("models/vocab.txt"), "the vocabulary path is not documented");
});
