/**
 * Manifest and asset integrity.
 *
 * These are the checks that stop the manifest drifting from the code again, and
 * they are cheap to run.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const EXTENSION_ROOT = new URL("../../", import.meta.url);

function manifest() {
  return JSON.parse(readFileSync(new URL("manifest.json", EXTENSION_ROOT), "utf8"));
}

function read(file) {
  return readFileSync(new URL(file, EXTENSION_ROOT), "utf8");
}

/** Every non-test source file, excluding node_modules. */
function sourceFiles() {
  const out = ["background.js", "popup.js", "options.js", "src/script.js"];
  const libDir = new URL("src/lib/", EXTENSION_ROOT);
  for (const name of readdirSync(libDir)) {
    if (name.endsWith(".js")) out.push(`src/lib/${name}`);
  }
  return out;
}

// --------------------------------------------------------------------------
// Branding
// --------------------------------------------------------------------------

test("the extension is named uBlockAI everywhere", () => {
  const m = manifest();
  assert.equal(m.name, "uBlockAI");
  assert.equal(m.short_name, "uBlockAI");
  assert.equal(m.action.default_title, "uBlockAI");

  // The old placeholder name must not survive anywhere user-visible.
  for (const file of ["manifest.json", "popup.html", "options.html"]) {
    assert.ok(!read(file).includes("AIBot"), `${file} still refers to AIBot`);
  }
});

test("the description says what the extension does", () => {
  const m = manifest();
  assert.match(m.description, /misinformation/i);
  assert.ok(!/Your new AI Bot/.test(m.description));
});

// --------------------------------------------------------------------------
// Icons
// --------------------------------------------------------------------------

test("the icons object is populated and every file exists", () => {
  const m = manifest();
  assert.ok(m.icons && Object.keys(m.icons).length > 0, "manifest icons object is empty");
  for (const [size, path] of Object.entries(m.icons)) {
    assert.ok(
      existsSync(new URL(path, EXTENSION_ROOT)),
      `icon ${size} declared at ${path} does not exist`,
    );
  }
});

test("the declared icon sizes are the ones Chrome expects", () => {
  assert.deepEqual(Object.keys(manifest().icons).sort(), ["128", "16", "48"]);
});

test("each icon is a real PNG of the declared size", () => {
  for (const [size, path] of Object.entries(manifest().icons)) {
    const bytes = readFileSync(new URL(path, EXTENSION_ROOT));
    // PNG magic.
    assert.deepEqual(
      Array.from(bytes.subarray(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${path} is not a PNG`,
    );
    // IHDR width and height are big-endian uint32 at offsets 16 and 20.
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assert.equal(width, Number(size), `${path} is ${width}px wide, not ${size}`);
    assert.equal(height, Number(size), `${path} is ${height}px tall, not ${size}`);
  }
});

test("icons are not blank", () => {
  for (const [, path] of Object.entries(manifest().icons)) {
    const bytes = readFileSync(new URL(path, EXTENSION_ROOT));
    // A blank or single-colour PNG compresses to almost nothing.
    assert.ok(bytes.length > 200, `${path} is ${bytes.length} bytes: likely blank`);
  }
});

// --------------------------------------------------------------------------
// Permissions
// --------------------------------------------------------------------------

test("only permissions that are actually used are requested", () => {
  const declared = new Set(manifest().permissions);
  const used = new Set();
  for (const file of sourceFiles()) {
    for (const match of read(file).matchAll(/chrome\.([a-zA-Z]+)\./g)) {
      used.add(match[1]);
    }
  }

  // chrome.permissions and chrome.runtime are available to every extension
  // page without a declaration, so they are not a reason to request anything.
  //
  // chrome.tabs is exempt too, but for a specific reason rather than because
  // it is free: the popup calls chrome.tabs.query to read the active tab's URL,
  // and Chrome populates that field for any tab we hold a host permission for.
  // We hold one for Instagram and only Instagram, which is the single case the
  // value is used for. On every other tab the field is undefined, the popup
  // shows "Not on Instagram", and that is the correct answer. Requesting
  // "tabs" would grant URL read access to every site the user visits for no
  // benefit.
  const noPermissionNeeded = new Set([
    "runtime",
    "permissions",
    "i18n",
    "extension",
    "tabs",
  ]);
  const required = [...used].filter((api) => !noPermissionNeeded.has(api));

  for (const api of required) {
    assert.ok(
      declared.has(api),
      `code calls chrome.${api} but "${api}" is not in manifest permissions`,
    );
  }
});

test("the only URL the popup reads is covered by a host permission", () => {
  // Justifies the chrome.tabs exemption above: the value must be populated.
  const popup = read("popup.js");
  assert.match(popup, /chrome\.tabs\.query/);

  const hosts = manifest().host_permissions.join(" ");
  assert.ok(
    hosts.includes("instagram.com"),
    "the popup reads tab.url but no host permission covers the site it checks for",
  );
});

test("no permission is requested that the code never uses", () => {
  const source = sourceFiles().map(read).join("\n");
  for (const permission of manifest().permissions) {
    assert.ok(
      source.includes(`chrome.${permission}.`),
      `"${permission}" is requested but chrome.${permission} is never used`,
    );
  }
});

test("the broad permissions that were never needed are gone", () => {
  const declared = manifest().permissions;
  // activeTab and scripting were requested but never used; the content script
  // is declared declaratively, so neither is needed.
  assert.ok(!declared.includes("activeTab"));
  assert.ok(!declared.includes("scripting"));
  assert.ok(!declared.includes("tabs"));
  assert.ok(!declared.includes("<all_urls>"));
});

test("host permissions cover the default backend and the supported site only", () => {
  const m = manifest();
  assert.ok(
    m.host_permissions.includes("https://hack-ncstate-2026.onrender.com/*"),
    "the hosted backend must be reachable without a permission prompt",
  );
  assert.ok(m.host_permissions.some((h) => h.includes("instagram.com")));
  // Self-hosted backends are granted on demand from the options page, so the
  // wildcard must be optional rather than granted up front.
  assert.ok(
    m.optional_host_permissions?.length > 0,
    "no way to grant a self-hosted origin",
  );
  assert.ok(
    !m.host_permissions.includes("https://*/*"),
    "wildcard must not be pre-granted",
  );
});

// --------------------------------------------------------------------------
// Dead assets
// --------------------------------------------------------------------------

test("no declared web-accessible resource is left behind", () => {
  const m = manifest();
  assert.equal(
    m.web_accessible_resources,
    undefined,
    "the placeholder no longer renders a background image, so nothing needs to be web-accessible",
  );
});

test("every committed PNG is referenced by the manifest", () => {
  const declared = new Set(Object.values(manifest().icons));
  for (const name of readdirSync(EXTENSION_ROOT)) {
    if (!name.endsWith(".png")) continue;
    assert.ok(declared.has(name), `${name} is committed but nothing references it`);
  }
});
