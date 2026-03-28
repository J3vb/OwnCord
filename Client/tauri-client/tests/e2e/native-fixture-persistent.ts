/**
 * Persistent Playwright fixture for native E2E tests.
 *
 * Unlike native-fixture.ts (which launches a fresh Tauri exe per test),
 * this fixture launches the exe ONCE per worker and reuses it across all
 * tests in the same project. This eliminates repeated login attempts
 * that trigger server rate limiting (5 logins/min, 10-failure lockout).
 *
 * Usage:
 * - Import { test, expect } from "../native-fixture-persistent"
 * - The `nativePage` fixture is worker-scoped: same process, same page
 * - Tests run serially (workers: 1) to share the single app instance
 */

import { test as base, type Page, type BrowserContext, type Browser } from "@playwright/test";
import { chromium } from "@playwright/test";
import { type ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Path to the built Tauri exe (release build). */
const TAURI_EXE = path.resolve(
  __dirname,
  "../../src-tauri/target/release/owncord-client.exe",
);

/** CDP port for WebView2 remote debugging. */
const CDP_PORT = parseInt(process.env.CDP_PORT ?? "9222", 10);

/** Max time to wait for WebView2 to start accepting CDP connections. */
const CDP_CONNECT_TIMEOUT = 30_000;

/** Polling interval when waiting for CDP endpoint. */
const CDP_POLL_INTERVAL = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for the CDP endpoint to become available by polling the /json/version endpoint.
 */
async function waitForCdpEndpoint(port: number, timeout: number): Promise<void> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Connection refused — WebView2 not ready yet
    }
    await new Promise((r) => setTimeout(r, CDP_POLL_INTERVAL));
  }

  throw new Error(
    `CDP endpoint at port ${port} did not become available within ${timeout}ms. ` +
    `Make sure the Tauri app was built (npm run tauri build) and the exe exists at: ${TAURI_EXE}`,
  );
}

/**
 * Create a unique temporary directory for WebView2 user data.
 */
function createUserDataDir(workerIndex: number): string {
  const dir = path.join(os.tmpdir(), `owncord-native-e2e-persistent-${workerIndex}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Clean up the temporary user data directory.
 */
function cleanupUserDataDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup — Windows may hold locks briefly
  }
}

// ---------------------------------------------------------------------------
// Worker-scoped state
// ---------------------------------------------------------------------------

/**
 * Shared state for the persistent Tauri process.
 * This is managed at the worker level so it persists across all tests.
 */
interface PersistentState {
  tauriProcess: ChildProcess;
  browser: Browser;
  page: Page;
  context: BrowserContext;
  userDataDir: string;
}

let sharedState: PersistentState | null = null;
let refCount = 0;

async function acquirePersistentPage(workerIndex: number): Promise<PersistentState> {
  refCount++;

  if (sharedState) {
    return sharedState;
  }

  // Validate exe exists
  if (!fs.existsSync(TAURI_EXE)) {
    throw new Error(
      `Tauri exe not found at: ${TAURI_EXE}\n` +
      `Run 'npm run tauri build' first to create the production build.`,
    );
  }

  const port = CDP_PORT + workerIndex;
  const userDataDir = createUserDataDir(workerIndex);

  // Launch Tauri app with CDP enabled
  const tauriProcess = spawn(TAURI_EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: userDataDir,
    },
    stdio: "pipe",
  });

  // Log output for debugging (to stderr so it appears in test output)
  tauriProcess.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) process.stderr.write(`[tauri-stdout] ${msg}\n`);
  });
  tauriProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) process.stderr.write(`[tauri-stderr] ${msg}\n`);
  });

  // Wait for WebView2 to start accepting CDP connections
  await waitForCdpEndpoint(port, CDP_CONNECT_TIMEOUT);

  // Connect Playwright to the WebView2 instance via CDP
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

  // Get the existing context and page (WebView2 creates one automatically)
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No browser context found after CDP connection");
  }

  const page = context.pages()[0];
  if (!page) {
    throw new Error("No page found in browser context after CDP connection");
  }

  sharedState = { tauriProcess, browser, page, context, userDataDir };
  return sharedState;
}

async function releasePersistentPage(): Promise<void> {
  refCount--;

  if (refCount <= 0 && sharedState) {
    const { browser, tauriProcess, userDataDir } = sharedState;
    sharedState = null;
    refCount = 0;

    try {
      await browser.close();
    } catch {
      // Browser may already be closed
    }

    tauriProcess.kill();

    // Give the process a moment to release file locks
    await new Promise((r) => setTimeout(r, 1000));
    cleanupUserDataDir(userDataDir);
  }
}

// ---------------------------------------------------------------------------
// Fixture type definitions
// ---------------------------------------------------------------------------

type PersistentNativeFixtures = {
  /** The Playwright page connected to the real Tauri WebView2 window (worker-scoped). */
  nativePage: Page;
  /** The browser context from the CDP connection. */
  nativeContext: BrowserContext;
};

// ---------------------------------------------------------------------------
// Test fixture — worker-scoped persistence
// ---------------------------------------------------------------------------

export const test = base.extend<PersistentNativeFixtures>({
  // eslint-disable-next-line no-empty-pattern
  nativePage: async ({}, use, testInfo) => {
    const state = await acquirePersistentPage(testInfo.workerIndex);
    await use(state.page);
    await releasePersistentPage();
  },

  nativeContext: async ({ nativePage }, use) => {
    const context = nativePage.context();
    await use(context);
  },
});

export { expect } from "@playwright/test";
