# E2E Test Status — 2026-08-05

**Verified against:** the 2026-08-05 closure-pass HEAD by an actual local run.
**Command:** `CI=1 npx playwright test --config=playwright.config.ts`
(headless Chromium, 1 worker, retries 2, the same knobs CI uses).

## Current status: 291 web tests, 291 passed (100%)

| Run | Result | Wall time |
| --- | ------ | --------- |
| Full web suite (`playwright.config.ts`) | **291 / 291 passed**, 0 flaky retries observed | 9.2 min |
| `@parity` subset (`--grep "@parity"` — mirrors the **blocking** `client-e2e-parity` CI job) | **15 / 15 passed** | 33 s |

Changes since the `914cdac` run (+15 tests, 3 new spec files — DC-04's last
client journeys plus the DC-13 smoke):

- `voice-e2ee-verify.spec.ts` (6): the voice E2EE identity-verification
  surface, driven through the production crypto path — verified badge +
  first-sight pin, legacy unverified, mismatch block, modal reject/trust,
  and the DC-08 fail-closed "could not check" state. Needed two harness
  additions: per-test identity-pin config on the mock
  (`identityPins`/`identityPinError`) and a WebSocket shim that parks
  LiveKit's `room.connect` so the voice session holds in "securing".
- `updater.spec.ts` (4): banner → download progress (percentage + MB
  fallback via real `update-progress` events) → automatic relaunch, the
  failure state, and both dismissal paths.
- `a11y-smoke.spec.ts` (5): axe-style structural checks for the DC-13 pass
  (dialog roles, focus trap/restore, tablist, combobox, live regions).
- The mock now records every IPC invoke in `window.__invokeLog`, so tests
  can assert side effects with no DOM footprint (pin writes, relaunch).

Earlier changes (2026-08-04 remediation): `cert-tofu.spec.ts` added (6 tests
covering the TOFU first-use/mismatch ceremony — DC-04), `server-strip.spec.ts`
renamed `sidebar-header.spec.ts`, and the mock exposes its event-listener
registry (`window.__tauriEventListeners`) so specs can wait for async listener
registration instead of racing it.

Flake accounting rule used here: a spec is *flaky* only if it failed and then
passed on retry within a run; a spec failing every attempt is *failing*, named
by file. This run had neither.

## Suite inventory

- **Web (mocked Tauri):** 40 spec files under `tests/e2e/`, 291 tests. Runs
  against the Vite dev server (`playwright.config.ts`) or the production
  bundle (`playwright.config.prod.ts`). Fifteen tests across
  `emoji-voicemod.parity.spec.ts`, `gating-badges.parity.spec.ts` and
  `social.parity.spec.ts` carry the `@parity` tag and gate CI.
- **Native (real Tauri binary via CDP):** 11 spec files under
  `tests/e2e/native/`, run by `playwright.config.native.ts` on Windows
  (WebView2) — all 11 matched by a project since 2026-08-04.
  **Deliberately not wired to CI.**

## CI wiring (`.github/workflows/ci.yml`)

| Job | Blocking? | What it runs |
| --- | --------- | ------------ |
| `client-e2e` | No (`continue-on-error`, pending a flakiness soak) | Full web suite, every PR |
| `client-e2e-parity` | **Yes** | The `@parity` subset |
| native config | not in CI | Windows-only; run manually |

## Known issues (open)

1. **`client-e2e` is still non-blocking.** The suite has been green since the
   mock repair that closed audit finding T-2026-07-25-21 (a `start_http_proxy`
   stub plus the voice-premise rewrite); promoting the job to blocking after a
   soak period is the remaining step (owner's call — this file just keeps
   adding green evidence).

## Resolved (2026-08-04 remediation)

- ~~Three native specs are never executed.~~ `dm-system.spec.ts`,
  `reconnection.spec.ts` and `theme-persistence.spec.ts` (14 tests) joined
  `native-authenticated`'s `testMatch` — all three use the persistent
  fixture + `ensureLoggedIn`, so the shared-exe project is where they belong.

## History (dispositions of the old contents of this file)

The previous revision of this file was dated 2026-03-18 and reported
"209/209 passed". Everything it tracked is long resolved and the counts are
historical only:

- The 2026-03 selector fixes, auto-select/settings-toggle/quick-switcher/
  member-list repairs: shipped, superseded by four months of suite growth
  (209 → 270 tests).
- The anti-flakiness config (`actionTimeout` 10 s, `navigationTimeout` 15 s,
  retries, video-on-retry) and the timing-safe helpers (`waitForWsReady()`,
  `navigateToMainPageReady()`, `emitWsMessageAndWait()`): still present in
  `playwright.config.ts` / `tests/e2e/helpers.ts`.
- The "Remaining Improvement Plan" pointed at
  `docs/brain/02-Tasks/PLAN-E2E-improvement.md`, which does not exist in this
  repository — reference dropped. Its themes (more `data-testid` selectors,
  page-object helpers, toast coverage) survive as ordinary test hygiene, and
  toast coverage has since landed (`toast.spec.ts`,
  `tests/unit/toast-coverage.test.ts`).
- The 229/255 breakage found by the 2026-07-25 coverage audit
  (T-2026-07-25-21) postdated the old file and never appeared in it; it is
  recorded and now closed in `docs/audit-test-coverage-2026-07-25.md`.

## Environment notes for local runs

- The dev-server config auto-starts Vite on port 1420; make sure it is free.
- `CI=1` gives the bounded CI profile (1 worker, `maxFailures: 20`, global
  timeout 20 min) — useful to keep a broken run from burning time.
- The native suite needs a Windows machine with the built Tauri exe and
  drives it over CDP; see `playwright.config.native.ts` for the two-project
  layout (fresh exe per test for auth flows, one shared exe + login for the
  rest, designed around the server's 5-logins/minute rate limit).
