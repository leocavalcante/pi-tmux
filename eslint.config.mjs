// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

// Test fixtures inspect dynamic package, subprocess, and protocol payloads; keep these relaxations test-only.
const testPayloadRules = Object.fromEntries(
  Object.keys(tseslint.plugin.rules)
    .filter(
      (name) =>
        name.startsWith("no-unsafe-") ||
        name === "no-explicit-any" ||
        name === "no-non-null-assertion",
    )
    .map((name) => [`@typescript-eslint/${name}`, "off"]),
);

export default defineConfig(
  { ignores: ["dist/", "coverage/"] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Node's test runner owns and reports promises returned by these declarations.
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              name: ["test", "it", "describe", "suite"],
              package: "node:test",
            },
          ],
        },
      ],
    },
  },
  {
    // This extension's runtime entry is index.ts rather than src/extension.ts.
    files: ["index.ts", "src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["bun", "bun:*"],
              message:
                "Pi runs extensions on Node.js. Use node:* APIs in src/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: [".github/scripts/**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      ...testPayloadRules,
      // Async test doubles intentionally retain Promise-shaped runtime contracts.
      "@typescript-eslint/require-await": "off",
    },
  },
  prettier,
);
