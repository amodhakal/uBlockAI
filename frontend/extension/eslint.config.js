import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "*.png"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
      },
    },
    rules: {
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "no-implicit-globals": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "require-await": "error",
      "no-return-await": "error",
    },
  },
  {
    // The content script and service worker run in extension contexts, not the
    // page, so top-level await and globals are expected there.
    files: ["src/**/*.js", "background.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
      },
    },
  },
];
