/**
 * The sign-in budget: how long from clicking Sign in until the first message
 * row of the opened channel has been painted. It covers the REST login, the
 * WebSocket handshake and ready payload, the lazy main page chunk, the first
 * history page and the render.
 *
 * Timing runs in the page (performance.now at the click and after the frame
 * that shows the first row), so Playwright's polling does not add to it. Each
 * sample is a fresh page load and a fresh sign-in; the median of seven is held
 * to the budget in Client/main-page-budget.json and every sample is attached
 * to the report.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import { generalId, relaxedAuthTest } from "./serverApi";
import { TEST_PASSWORD, type TestServer } from "../support/server";
import { rawSocket } from "../support/raw-socket";

// Seven sign-ins in a row are more than one IP gets a minute.
const test = relaxedAuthTest;

test.setTimeout(180_000);

const SAMPLES = 7;
const HISTORY = 50;
const { budgetMs } = JSON.parse(
  readFileSync(new URL("../../../main-page-budget.json", import.meta.url), "utf8"),
) as { budgetMs: number };

type Probe = { start: number | null; painted: number | null };

/** Installed before every page load: stamps the Sign in click and the frame
 *  after the first message row appears. */
function installProbe(): void {
  const state: Probe = { start: null, painted: null };
  (window as unknown as { __signIn: Probe }).__signIn = state;
  document.addEventListener(
    "click",
    (event) => {
      if (
        state.start === null &&
        event.target instanceof Element &&
        event.target.closest("button[type='submit']")
      ) {
        state.start = performance.now();
      }
    },
    true,
  );
  const observer = new MutationObserver(() => {
    if (state.start === null || state.painted !== null) return;
    if (!document.querySelector(".message .msg-text")) return;
    observer.disconnect();
    // A timeout queued from a frame callback runs after that frame's paint.
    requestAnimationFrame(() =>
      setTimeout(() => {
        state.painted = performance.now();
      }, 0),
    );
  });
  observer.observe(document, { childList: true, subtree: true });
}

async function timeSignIn(page: Page, server: TestServer): Promise<number> {
  await page.goto("/");
  await page.locator("#host").fill(`127.0.0.1:${server.port}`);
  await page.locator("#username").fill("alice");
  await page.locator("#password").fill(TEST_PASSWORD);
  // The stored token survives page.goto, so auto connect would resume
  // instead of signing in.
  await page.locator("#auto-connect").uncheck();
  await page.locator("button[type='submit']").click();
  let elapsed = 0;
  await expect
    .poll(
      async () => {
        const probe = await page.evaluate(
          () => (window as unknown as { __signIn: Probe }).__signIn,
        );
        if (probe.start === null || probe.painted === null) return false;
        elapsed = probe.painted - probe.start;
        return true;
      },
      { intervals: [50], timeout: 30_000 },
    )
    .toBe(true);
  return Math.round(elapsed);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

test("signing in paints the first message row within the budget", async ({
  page,
  server,
  aliceTransport,
}, info) => {
  void aliceTransport;
  const bob = await rawSocket(server, "bob");
  const general = await generalId(server);
  const texts = Array.from({ length: HISTORY }, (_, n) => `history row ${n + 1}.`);
  for (const text of texts) await bob.post(general, [text]);
  bob.close();

  await page.addInitScript(installProbe);
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    samples.push(await timeSignIn(page, server));
    await expect(page.getByText(texts[0]!, { exact: true })).toBeVisible();
  }

  const medianMs = median(samples);
  const result = { samplesMs: samples, medianMs, budgetMs };
  console.log(`main-page: ${JSON.stringify(result)}`);
  await info.attach("main-page", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(medianMs, `median sign-in ${medianMs} ms over budget ${budgetMs} ms`).toBeLessThanOrEqual(
    budgetMs,
  );
});
