# OwnCord Client (Tauri v2)

TypeScript frontend (Vite, vanilla TS — no React/Vue) + minimal Rust backend in `src-tauri/` (native APIs only). LiveKit for voice/video, zod for validation.

## Layout

- `src/` app code · `src/lib/protocolTypes.ts` is **generated** from `../../docs/protocol-schema.json` — never edit by hand
- `src/generated/` Tauri IPC bindings from `tauri-typegen` (CI patches known typegen bugs — see ci.yml)
- `tests/unit`, `tests/integration` (vitest, jsdom) · `tests/e2e` (Playwright) · `tests/browser` (vitest browser mode)
- `src-tauri/` Rust: keep minimal; `cargo clippy -- -D warnings` and `cargo audit` gate CI

## Rules

- **The unit suite is GREEN and must stay green** (`npm test` must pass 100%). Never make a failing test green by weakening assertions; new tests must pass. Run a single file with `npm run test:unit -- tests/unit/<file>`.
  - On Node 22+, native Web Storage shadows jsdom's `localStorage` and fails ~478 tests that have nothing to do with your change. That is a local toolchain artifact, not a regression — run `NODE_OPTIONS=--no-experimental-webstorage npm test` (or use Node 20, which CI pins). Do not "fix" those failures.
- Static gates that must pass: `npm run typecheck`, `npm run lint` (oxlint then type-aware eslint), `npm run format:check` (prettier: double quotes, semi, width 100).
- `knip` and stryker mutation testing exist but are advisory.
- Full desktop builds (`npm run tauri build`) only run in CI on PRs to `main`; don't attempt them in sandboxed sessions — Rust/system deps are heavy.
