import { configDefaults, defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve } from "path";
import { changelogModule } from "./vite.config.ts";
import { browserPlatform } from "./vite.config.web.ts";

// D7 of the check-reliability pain-points report: the aggregate statements floor
// lived in two places, and they disagreed — `coverage-floor.json` said 93.0 for
// CI's `scripts/coverage-floor.sh`, while the vitest threshold below said 90.
// A local run at 91% therefore passed `npm run test:coverage` and then went red
// in CI. The JSON file is the single source of truth (the server's floor script
// reads the same shape); the statements threshold is derived from it here so the
// two can no longer drift.
const AGGREGATE_FLOOR: number = JSON.parse(
  readFileSync(new URL("./coverage-floor.json", import.meta.url), "utf8"),
).aggregate;

// Node >= 22.4 ships its own Web Storage, and vitest's jsdom environment makes
// `window === globalThis` — so Node's `localStorage` AND its `Storage` class
// shadow jsdom's. `localStorage` then returns undefined without
// `--localstorage-file`, and `Storage` names Node's class, which silently
// defeats every `vi.spyOn(Storage.prototype, ...)` in the suite (OC-0415).
// Switching Node's implementation off leaves jsdom's as the only one, which is
// what the suite has always assumed and what CI's Node 26 happened to give.
//
// This module is evaluated in vitest's parent process, and the worker
// processes inherit its environment — `poolOptions.forks.execArgv` does NOT
// work here, vitest replaces execArgv with its own list. tests/setup.ts fails
// loudly if the flag does not arrive, so this can never degrade in silence.
const WEBSTORAGE_OFF = "--no-experimental-webstorage";
if (!(process.env.NODE_OPTIONS ?? "").includes(WEBSTORAGE_OFF)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${WEBSTORAGE_OFF}`.trim();
}

// Files that still need a whole Node process each (the `desktop-node`
// project). Everything else runs in the `vmForks` pool: one jsdom VM context
// per file inside reused worker processes, which skips a process spawn and a
// jsdom import per file and took the suite from 455 s to under 2 min on a
// 4-core box. A file belongs here only when the VM context changes what it
// measures:
// - it builds its own JSDOM, runs a bundler or other Node tooling, and those
//   CommonJS packages cannot load inside the VM context;
// - it imports Playwright (directly or through tests/e2e/support), which
//   refuses to load a second time in one process;
// - it redefines `window.location`, which jsdom's VM window keeps
//   non-configurable;
// - it checks an error or buffer against the page's constructors
//   (`instanceof SyntaxError`, `expect.any(Error)`, `instanceof ArrayBuffer`)
//   while the value comes from Node's realm (fetch, vi.mock, Node streams).
// Shrink-only: move a file back by fixing it, never add one to dodge a failure
// that also happens in the forks pool.
const NODE_PROCESS_FILES = [
  "tests/contract/server-admin-*.test.ts",
  "tests/contract/serverAdminStaticPanel/*.test.ts",
  "tests/unit/api/infraAndTransport.test.ts",
  "tests/unit/app-deepLinks.test.ts",
  "tests/unit/app-globalGuards.test.ts",
  "tests/unit/app-router.test.ts",
  "tests/unit/artifact-cert-pin.test.ts",
  "tests/unit/artifact-updater-restart.test.ts",
  "tests/unit/artifact-webview2-policy.test.ts",
  "tests/unit/layer-baseline.test.ts",
  "tests/unit/lifecycle-ownership.test.ts",
  "tests/unit/lifecycle-probe.test.ts",
  "tests/unit/main/linksAndRecovery.test.ts",
  "tests/unit/native-artifacts.test.ts",
  "tests/unit/native-launch.test.ts",
  "tests/unit/noise-suppression-bytes-cache.test.ts",
  "tests/unit/platform/browser-registry.test.ts",
  "tests/unit/platform/socket.browser.test.ts",
  "tests/unit/playwright-devserver-v8-flag.test.ts",
  "tests/unit/process-nonloopback.test.ts",
  "tests/unit/soak-console-errors.test.ts",
  "tests/unit/web-build.test.ts",
];

export default defineConfig({
  plugins: [changelogModule()],
  define: { __OWNCORD_WEB__: false },
  resolve: {
    alias: {
      "@lib": resolve(import.meta.dirname, "src/lib"),
      "@stores": resolve(import.meta.dirname, "src/stores"),
      "@components": resolve(import.meta.dirname, "src/components"),
      "@pages": resolve(import.meta.dirname, "src/pages"),
      "@styles": resolve(import.meta.dirname, "src/styles"),
    },
  },
  test: {
    environment: "jsdom",
    // Child processes, never worker threads: `process.env.TZ` only reaches
    // Date's local-time engine on a process main thread, so the TZ-pinned
    // regression blocks in tests/unit/{dispatcher,renderers}.test.ts measure
    // nothing under threads (tests/helpers/tz-pin.ts throws rather than
    // skipping if that happens), and the NODE_OPTIONS flag above is a process
    // start-up flag. `vmForks` keeps both: forked workers, each test file in a
    // fresh VM context with its own module graph. `desktop-node` below keeps
    // the few files that need a whole process each on `forks`.
    pool: "vmForks",
    // V8 coverage reports every script still alive in a worker, so a VM
    // worker that keeps the contexts of earlier files makes each later
    // report bigger. Recycling at 300 MB took the coverage run from 441 s to
    // 263 s with the same numbers; the plain run does not notice it.
    vmMemoryLimit: "300MB",
    // Asserts the NODE_OPTIONS flag below actually arrived; see its comment
    // and tests/setup.ts's header.
    setupFiles: ["./tests/setup.ts"],
    // The per-test budget. A test that needs longer waits on the fake clock
    // instead of the real one, or, when its cost is real work (a lint pass
    // over src/, hundreds of DOM rebuilds), says so with its own `timeout`.
    testTimeout: 2_000,
    // Three projects over one config (WP 6.13e): `desktop` is the suite as it
    // always was, with `__OWNCORD_WEB__` false, and `desktop-node` is the same
    // suite for NODE_PROCESS_FILES. `web` builds the portal's
    // branches in (`__OWNCORD_WEB__` true, the platform registry swapped for
    // the browser one exactly as `vite.config.web.ts` does) and runs only
    // tests/web/. A plain `vitest run` runs both. `include` and `exclude` live
    // in the projects, not here: `extends` concatenates arrays, so a root
    // `include` would run the whole desktop suite in the web project too.
    projects: [
      {
        extends: true,
        test: {
          name: "desktop",
          // Both the `tests/**/*.test.ts` suite and component-local
          // `src/**/*.test.ts` files are picked up.
          include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
          // tests/browser/ runs real browser APIs (AudioContext, WASM) under
          // vitest.config.browser.ts (`npm run test:browser`); it cannot pass
          // in jsdom and is not part of this suite.
          exclude: [
            ...configDefaults.exclude,
            "tests/browser/**",
            "tests/web/**",
            ...NODE_PROCESS_FILES,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "desktop-node",
          pool: "forks",
          include: NODE_PROCESS_FILES,
          exclude: [...configDefaults.exclude],
        },
      },
      {
        extends: true,
        plugins: [browserPlatform()],
        define: { __OWNCORD_WEB__: true },
        test: {
          name: "web",
          include: ["tests/web/**/*.test.ts"],
          exclude: [...configDefaults.exclude],
        },
      },
    ],
    coverage: {
      provider: "v8",
      // json-summary emits coverage/coverage-summary.json, which
      // scripts/coverage-floor.sh reads. It is NOT in vitest's defaults
      // (text, html, clover, json), so without it the floor gate exits 2 with
      // "no such file" — a broken gate that looks like a coverage failure.
      reporter: ["text", "html", "clover", "json", "json-summary"],
      include: ["src/**/*.ts"],
      // Keep this list minimal and justified. An unexplained entry hides a
      // real gap: window-state.ts, credentials.ts, updater.ts and
      // UpdateNotifier.ts each sat here while having (or gaining) tests, so
      // their coverage never showed up in any report.
      exclude: [
        // Type declarations only: no runtime statements to cover.
        "src/**/*.d.ts",
        // App bootstrap: wires the DOM, router and stores together at startup.
        // Has no seam to test below the e2e level; covered by tests/e2e.
        "src/main.ts",
        // Top-level page orchestrator, likewise covered at the e2e level.
        // Tracked for unit coverage — remove this entry once it has tests.
        "src/pages/MainPage.ts",
        // RNNoise AudioWorklet host: needs a real AudioContext/WASM runtime
        // that jsdom cannot provide. Exercised by tests/browser and e2e.
        "src/lib/voice/noiseSuppression.ts",
      ],
      thresholds: {
        statements: AGGREGATE_FLOOR,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
});
