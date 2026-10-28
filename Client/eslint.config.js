import { readFileSync } from "node:fs";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import localRules from "./eslint-rules.js";

// Upward imports that predate local/layer-direction; shrink-only
// (tests/unit/layer-baseline.test.ts).
const layerBaseline = JSON.parse(
  readFileSync(new URL("./scripts/layer-baseline.json", import.meta.url), "utf8"),
);

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

      // `any` is banned in src/ (CLAUDE.md, "AI Quality Guardrails"). The
      // residue in lib/livekitReconnect.ts carries a reasoned eslint-disable
      // and only shrinks; a new `any` fails the build.
      "@typescript-eslint/no-explicit-any": "error",

      // --- Relax rules that conflict with project style ---
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
    // livekitReconnect.ts owns the reconnect loop and joinOrchestration.ts the
    // connect/supersession checkpoints, both extracted out of
    // livekitSession.ts — the supersession invariant travelled with them, so
    // the rule must cover every file or those paths go unguarded.
    files: [
      "src/lib/livekitSession.ts",
      "src/lib/livekitReconnect.ts",
      "src/features/voice/joinOrchestration.ts",
    ],
    plugins: { local: localRules },
    rules: {
      "local/no-leave-voice-when-superseded": "error",
    },
  },
  {
    // E2EEManager (livekitE2EE.ts) delegates to ownership modules extracted
    // under src/features/voice/ — the epoch/keypair, verified-status and
    // identity-scope invariants travelled with that code, so every one of
    // those files is listed or the moved guards go unchecked.
    files: [
      "src/lib/livekitE2EE.ts",
      "src/features/voice/e2eeIdentity.ts",
      "src/features/voice/e2eeEpoch.ts",
      "src/features/voice/e2eePeerState.ts",
      "src/features/voice/e2eeWorker.ts",
      "src/features/voice/e2eeOffer.ts",
    ],
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
    // Layers import downward or sideways only (rank list in eslint-rules.js).
    // Tests are exempt; the baseline lists the pre-existing upward imports.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    plugins: { local: localRules },
    rules: {
      "local/layer-direction": ["error", { baseline: layerBaseline }],
    },
  },
  {
    // nativeInvoke.ts is the shared door the rest of the folder calls through;
    // its own `invoke` sits in tryInvoke's try.
    files: ["src/platform/desktop/**/*.ts"],
    ignores: ["src/platform/desktop/nativeInvoke.ts"],
    plugins: { local: localRules },
    rules: {
      "local/invoke-needs-try-catch": "error",
    },
  },
  {
    // Raw HTML sinks (ARCH-038). icons.ts writes static Lucide path data into
    // an <svg>; nothing else may parse markup.
    files: ["src/**/*.ts"],
    ignores: ["src/lib/icons.ts", "src/**/*.test.ts"],
    plugins: { local: localRules },
    rules: {
      "local/no-raw-html-sink": "error",
    },
  },
  {
    // Tests discard subscriptions on purpose and build DOM fixtures from markup.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    plugins: { local: localRules },
    rules: {
      "local/subscription-result-kept": "error",
    },
  },
  // --- Native imports stay behind the desktop seam (B7-1) ---
  // B7-5 moved the last call site behind src/platform/, so the seam is the only
  // exemption. no-restricted-imports covers static imports and
  // no-restricted-syntax covers a dynamic `import()`.
  {
    files: ["src/**/*.ts"],
    ignores: [
      // The seam itself: the desktop implementations are the only place a
      // native import belongs.
      "src/platform/desktop/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tauri-apps/*"],
              message:
                "Native imports belong in src/platform/desktop (B7-4/B7-5). See docs/architecture/platform-contracts.md.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^@tauri-apps\\//]",
          message:
            "Native imports belong in src/platform/desktop (B7-4/B7-5). See docs/architecture/platform-contracts.md.",
        },
      ],
    },
  },
  // --- Row views draw from a model and never read a store (5.4e) ---
  // This block replaces the native-import config above for view files, so it
  // repeats that ban. no-restricted-syntax covers a dynamic `import()`.
  {
    files: ["src/**/*.view.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tauri-apps/*"],
              message:
                "Native imports belong in src/platform/desktop (B7-4/B7-5). See docs/architecture/platform-contracts.md.",
            },
            {
              group: [
                "@stores/*",
                "**/stores/*",
                "@features/*/store",
                "**/features/*/store",
                "./store",
                "**/store",
                "@lib/livekitSession",
                "**/lib/livekitSession",
              ],
              message:
                "A *.view.ts draws from its row model and imports no store or voice session; build the model in the caller (5.4e).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^@tauri-apps\\//]",
          message:
            "Native imports belong in src/platform/desktop (B7-4/B7-5). See docs/architecture/platform-contracts.md.",
        },
        {
          selector:
            "ImportExpression[source.value=/(^@stores\\/|\\/stores\\/|(^|\\/)store$|livekitSession$)/]",
          message:
            "A *.view.ts draws from its row model and imports no store or voice session; build the model in the caller (5.4e).",
        },
      ],
    },
  },
  {
    ignores: ["dist/", "dist-web/", "src-tauri/", "node_modules/", "public/", "*.js", "*.cjs"],
  },
);
