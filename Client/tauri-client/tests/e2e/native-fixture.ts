/**
 * Custom Playwright fixture for testing the real Tauri production app.
 *
 * Launches the built OwnCord exe with WebView2 remote debugging enabled,
 * connects Playwright to the WebView2 window via Chrome DevTools Protocol,
 * and provides the page object to tests.
 *
 * Based on:
 * - https://playwright.dev/docs/webview2
 * - https://github.com/Haprog/playwright-cdp
 */

import { test as base, type Page, type BrowserContext } from "@playwright/test";
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
const CDP_CONNECT_TIMEOUT = 60_000;

/** Initial polling interval when waiting for CDP endpoint (exponential backoff). */
const CDP_POLL_INTERVAL_INITIAL = 100;

/** Maximum polling interval cap. */
const CDP_POLL_INTERVAL_MAX = 2_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for the CDP endpoint to become available by polling the /json/version endpoint.
 * WebView2 needs time to initialize before it accepts CDP connections.
 */
async function waitForCdpEndpoint(port: number, timeout: number): Promise<void> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/json/version`;
  let pollInterval = CDP_POLL_INTERVAL_INITIAL;

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Connection refused — WebView2 not ready yet
    }
    await new Promise((r) => setTimeout(r, pollInterval));
    pollInterval = Math.min(pollInterval * 1.5, CDP_POLL_INTERVAL_MAX);
  }

  throw new Error(
    `CDP endpoint at port ${port} did not become available within ${timeout}ms. ` +
    `Make sure the Tauri app was built (npm run tauri build) and the exe exists at: ${TAURI_EXE}`,
  );
}

/**
 * Create a unique temporary directory for WebView2 user data.
 * Each test worker gets its own directory to avoid state leakage.
 */
function createUserDataDir(workerIndex: number): string {
  const dir = path.join(os.tmpdir(), `owncord-native-e2e-${workerIndex}-${Date.now()}`);
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
// Fixture type definitions
// ---------------------------------------------------------------------------

type NativeFixtures = {
  /** The Playwright page connected to the real Tauri WebView2 window. */
  nativePage: Page;
  /** The browser context from the CDP connection. */
  nativeContext: BrowserContext;
  /** The Tauri app child process (for lifecycle control). */
  tauriProcess: ChildProcess;
};

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

export const test = base.extend<NativeFixtures>({
  // eslint-disable-next-line no-empty-pattern
  nativePage: async ({}, use, testInfo) => {
    // Validate exe exists
    if (!fs.existsSync(TAURI_EXE)) {
      throw new Error(
        `Tauri exe not found at: ${TAURI_EXE}\n` +
        `Run 'npm run tauri build' first to create the production build.`,
      );
    }

    const workerIndex = testInfo.workerIndex;
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

    // Log stdout/stderr for debugging
    tauriProcess.stdout?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) testInfo.attach("tauri-stdout", { body: msg, contentType: "text/plain" });
    });
    tauriProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) testInfo.attach("tauri-stderr", { body: msg, contentType: "text/plain" });
    });

    let browser;
    try {
      // Wait for WebView2 to start accepting CDP connections
      await waitForCdpEndpoint(port, CDP_CONNECT_TIMEOUT);

      // Connect Playwright to the WebView2 instance via CDP
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

      // Get the existing context and page (WebView2 creates one automatically)
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("No browser context found after CDP connection");
      }

      const page = context.pages()[0];
      if (!page) {
        throw new Error("No page found in browser context after CDP connection");
      }

      // Provide the page to the test
      await use(page);
    } finally {
      // Cleanup: close browser connection, kill process, remove temp dir
      if (browser) {
        try {
          await browser.close();
        } catch {
          // Browser may already be closed
        }
      }

      tauriProcess.kill();

      // Give the process a moment to release file locks
      await new Promise((r) => setTimeout(r, 1000));
      cleanupUserDataDir(userDataDir);
    }
  },

  nativeContext: async ({ nativePage }, use) => {
    const context = nativePage.context();
    await use(context);
  },

  tauriProcess: async ({ nativePage }, use) => {
    // This is a convenience fixture — the process is managed by nativePage
    // We expose it so tests can check process state if needed
    await use(undefined as unknown as ChildProcess);
  },
});

export { expect } from "@playwright/test";
