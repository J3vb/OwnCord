import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

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
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
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
  {
    ignores: [
      "dist/",
      "src-tauri/",
      "node_modules/",
      "public/",
      "*.js",
      "*.cjs",
    ],
  },
);
