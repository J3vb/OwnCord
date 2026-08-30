import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import localRules from "./eslint-rules.js";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Key rules from T-191 ---
      "@typescript-eslint/no-floating-promises": "error",
      // A switch over a union that misses a member is a silent drop, not a type error.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "consistent-return": "error",

      // --- Relax rules that conflict with project style ---
      // Project uses `any` sparingly with eslint-disable comments
      "@typescript-eslint/no-explicit-any": "warn",
      // Project uses non-null assertions intentionally
      "@typescript-eslint/no-non-null-assertion": "off",
      // Empty functions are used for no-op callbacks
      "@typescript-eslint/no-empty-function": "off",
      // Project uses void for fire-and-forget promises intentionally
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      // Allow require() in config files
      "@typescript-eslint/no-require-imports": "off",
      // Unbound methods used in singleton export pattern (bind at export)
      "@typescript-eslint/unbound-method": "off",
      // Allow unsafe member access on `any` — project narrows manually
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Redundant type constituents show up in union types with branded types
      "@typescript-eslint/no-redundant-type-constituents": "off",
      // Permissions use number bitmasks compared with enum values — intentional
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      // Interface-conforming async methods don't always need await
      "@typescript-eslint/require-await": "off",
      // Re-throwing with different message is a project pattern
      "preserve-caught-error": "off",
      // Promise rejection with string literals is used in some UI code
      "@typescript-eslint/prefer-promise-reject-errors": "off",
    },
  },
  {
    // Test files get relaxed rules
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "consistent-return": "off",
    },
  },
  // --- Local rules: three CLAUDE.md invariants enforced as lint rules ---
  // See eslint-rules.js for each rule's rationale and the historical bug
  // shape it catches. Each is scoped to only the module(s) its invariant
  // governs.
  {
    files: ["src/lib/livekitSession.ts"],
    plugins: { local: localRules },
    rules: {
      "local/no-leave-voice-when-superseded": "error",
    },
  },
  {
    files: ["src/lib/livekitE2EE.ts"],
    plugins: { local: localRules },
    rules: {
      "local/e2ee-epoch-needs-keypair-check": "error",
      "local/e2ee-verified-status-literal": "error",
      "local/no-identity-scope-fallback": "error",
    },
  },
  {
    files: ["src/lib/identity.ts"],
    plugins: { local: localRules },
    rules: {
      "local/no-identity-scope-fallback": "error",
    },
  },
  {
    // dispatcher.ts IS the allowed entry point, so it is exempt from its own rule.
    files: ["src/**/*.ts"],
    ignores: ["src/lib/dispatcher.ts"],
    plugins: { local: localRules },
    rules: {
      "local/no-store-write-in-ws-on": "error",
    },
  },
  {
    ignores: ["dist/", "src-tauri/", "node_modules/", "public/", "*.js", "*.cjs"],
  },
);
