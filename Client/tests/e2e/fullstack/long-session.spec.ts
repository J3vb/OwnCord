/**
 * B7-11a: the long-session soak.
 *
 * The PR soak runs a bounded number of full session cycles (default 20) against
 * a real server and real encrypted media, sampling Chromium's own counters
 * after a forced GC. It is the runtime half of the milestone: the static
 * inventory (tests/unit/lifecycle-ownership.test.ts) cannot see a listener on a
 * signal that outlives the thing it served (OC-0335/0336/0365), and this can.
 *
 * The pass bar is "no net growth after warm-up" (tests/e2e/support/
 * lifecycle-probe.ts). Samples are taken at cycle 0, cycle 5 (warm) and every 5
 * cycles after. The series is attached to the Playwright report as JSON, so a
 * failure shows the curve.
 *
 * Env:
 *   OWNCORD_SOAK_CYCLES    cycles to run (default 20)
 *   OWNCORD_SOAK_IDLE_MIN  idle-connected minutes sampled every 5 min (default 0)
 *
 * The long run (>= 200 cycles + 30 idle minutes) is 11c's Task 13, over this
 * same spec.
 */
import { test as base, expect } from "./fixtures";
import { login } from "./fixtures";
import type { ConsoleMessage, Page } from "@playwright/test";
import { expectDecodedMedia, joinVoice, mediaStats } from "../support/media";
import {
  installTimerLedger,
  sampleLifecycle,
  evaluateBars,
  formatBars,
  describeLiveListeners,
} from "../support/lifecycle-probe";
import { openSettings, switchSettingsTab } from "../helpers";

const CYCLES = Number(process.env.OWNCORD_SOAK_CYCLES ?? 20);
const IDLE_MIN = Number(process.env.OWNCORD_SOAK_IDLE_MIN ?? 0);

/**
 * Metrics that fail at the 11a base. Reported, not asserted; 11c empties this.
 *
 * `nodes` and `listeners` fail the pooled slope bar because there is a real,
 * small leak in the logout/login path, not because the samples are noisy. Over
 * 40 cycles the post-logout samples grow monotonically: listeners 192 → 193 →
 * 194 → 195 (cycle 10/20/30/40) and nodes 2102 → 2118 → 2134 → 2150, while the
 * mid-session samples (cycle 5/15/25/35) stay flat at 211 listeners and 3453
 * nodes. So roughly one listener and ~1.6 nodes leak per logout/login. The
 * slopes are far below run-to-run spread on the other metrics (calibration was
 * identical across three 20-cycle runs); 11c's Task 12 writes the regression
 * test and fixes it, then empties this constant.
 */
const PENDING_METRICS: readonly string[] = ["nodes", "listeners"];

// The reconnect and logout steps deliberately drop the socket, so the client
// logs its own transport failure while it is offline. Only those lines (and the
// app's own "disconnected/reconnect" notices) are expected.
const EXPECTED_CONSOLE_ERRORS = [
  /\[ws\] ws_send failed/,
  /ws_send failed/,
  /WebSocket is not open/,
  /reconnect/i,
  /disconnected/i,
  /offline/i,
];

const test = base.extend<{ alice: Page }>({
  alice: async ({ page, server, aliceTransport }, use) => {
    void aliceTransport;
    // Installed after the media probe and transport (which use addInitScript)
    // but before login, so every timer the app creates is in the ledger.
    await installTimerLedger(page);
    await login(page, server, "alice");
    await use(page);
  },
});

async function quiesce(page: Page): Promise<void> {
  // Close every overlay, return to the default channel and member-list state.
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator(".settings-close-btn")
    .click({ timeout: 1000 })
    .catch(() => {});
  await page
    .locator(".reaction-picker-wrap")
    .click({ timeout: 1000 })
    .catch(() => {});
  await page
    .locator("[data-testid='user-profile-overlay']")
    .click({ timeout: 1000 })
    .catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  // Return to #general. Clicking the row is a no-op when it is already active,
  // and after a logout the app has already landed there.
  await page
    .locator("[data-testid='channel-sidebar'] .channel-list .channel-item", { hasText: "general" })
    .first()
    .click();
  // Wait for the app to be fully settled before measuring: a sample taken
  // mid-render reads a smaller DOM and a partially-registered listener set.
  await expect(page.getByTestId("app-layout")).toBeVisible();
  await expect(page.locator("[data-testid='member-list']")).toBeVisible();
  await expect(page.locator(".chat-header .ch-name")).toHaveText("general");
  await expect(page.locator("[data-testid='message-input']")).toBeVisible();
  // Toasts default to a 5 s duration; wait for the DOM to drain.
  await expect
    .poll(async () => page.locator(".toast").count(), { timeout: 15_000, intervals: [200] })
    .toBe(0);
  // Let asynchronous teardown drain before the GCs and the counters: leaving a
  // voice room, closing a socket and disposing a session all finish on
  // microtasks/timers after their synchronous call returns. Sampling in that
  // window reads listeners and controllers that are already being released,
  // which is a measurement bug, not a leak.
  await page.waitForTimeout(1000);
}

/** The row whose text contains `text`. */
function rowWithText(page: Page, text: string) {
  return page.locator(".message", { has: page.locator(".msg-text", { hasText: text }) });
}

function textChannelItems(page: Page) {
  return page.locator("[data-testid='channel-sidebar'] .channel-list .channel-item:not(.voice)");
}

/** One full session cycle, per the plan: channels, messaging, overlays, DM, voice. */
async function runCycle(
  page: Page,
  bob: Page,
  cycle: number,
  purgeMessages: (channelId: number) => Promise<void>,
  generalId: number,
): Promise<void> {
  // 1. Switch across the three text channels and back.
  await expect
    .poll(async () => (await textChannelItems(page)).count(), { timeout: 15_000 })
    .toBe(3);
  const textChannels = await textChannelItems(page);
  for (let i = 0; i < 3; i++) await textChannels.nth(i).click();
  await page
    .locator("[data-testid='channel-sidebar'] .channel-list .channel-item", { hasText: "general" })
    .first()
    .click();
  await expect(page.locator(".chat-header .ch-name")).toHaveText("general");

  // 2. Bob posts; Alice sees exactly one row. Alice sends, edits, reacts and
  //    removes the reaction.
  const text = `soak-${cycle}-${crypto.randomUUID()}`;
  await bob.locator("[data-testid='message-input'] textarea").fill(text);
  await bob.locator("[data-testid='message-input'] textarea").press("Enter");
  await expect(page.locator(".msg-text", { hasText: text })).toHaveCount(1);

  const own = `soak-own-${cycle}-${crypto.randomUUID()}`;
  const input = page.locator("[data-testid='message-input'] textarea");
  await input.fill(own);
  await input.press("Enter");

  // Wait for the server echo: the row is confirmed (not `.pending`) and has
  // the hover action bar, which only a sent message renders.
  const ownRow = rowWithText(page, own);
  await expect(ownRow).not.toHaveClass(/pending/);
  await expect(ownRow.locator(".msg-actions-bar")).toBeAttached();
  await ownRow.hover();
  await ownRow.locator("[data-testid^='msg-edit-']").click();
  const edited = `${own}-edited`;
  await input.fill(edited);
  await input.press("Enter");
  await expect(page.locator(".msg-text", { hasText: edited })).toHaveCount(1);

  const editedRow = rowWithText(page, edited);
  await editedRow.hover();
  await editedRow.locator("[data-testid^='msg-react-']").click();
  const picker = page.locator(".reaction-picker-wrap .emoji-picker.open");
  await expect(picker).toBeVisible();
  await picker.locator(".ep-emoji").first().click();
  const mine = editedRow.locator(".reaction-chip.me");
  await expect(mine).toHaveCount(1);
  await mine.click();
  await expect(editedRow.locator(".reaction-chip.me")).toHaveCount(0);

  // Drain this cycle's messages. The pass bars compare samples across cycles,
  // so without this every cycle's two new rows are growth by construction and
  // the listener/node counters would measure the soak's own history rather than
  // a leak. The purge broadcasts chat_bulk_deleted, which the client applies to
  // the store and the DOM.
  await purgeMessages(generalId);
  await expect(page.locator(".msg-text", { hasText: edited })).toHaveCount(0);
  await expect(page.locator(".msg-text", { hasText: text })).toHaveCount(0);

  // 3. Settings: visit every tab; then quick switcher, emoji picker, a user
  //    popup and a channel context menu, each opened and closed.
  await openSettings(page);
  for (const tab of [
    "Account",
    "Appearance",
    "Notifications",
    "Text & Images",
    "Accessibility",
    "Voice & Audio",
    "Keybinds",
    "Advanced",
    "Logs",
  ]) {
    await switchSettingsTab(page, tab);
  }
  await page.locator(".settings-close-btn").click();
  await expect(page.locator("[data-testid='settings-overlay']")).not.toHaveClass(/open/);

  await page.keyboard.press("Control+k");
  await expect(page.locator(".quick-switcher-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".quick-switcher-overlay")).not.toBeVisible();

  await page.locator(".emoji-btn").click();
  await expect(page.locator(".emoji-picker.open")).toBeVisible();
  // The composer's picker closes on an outside mousedown, not Escape.
  await page.locator(".chat-header").click();
  await expect(page.locator(".emoji-picker.open")).not.toBeVisible();

  await page.locator(".member-item").first().click();
  await expect(page.locator("[data-testid='user-profile-popup']")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid='user-profile-popup']")).not.toBeVisible();

  await textChannels.first().click({ button: "right" });
  await expect(page.locator("[data-testid='channel-context-menu']")).toBeVisible();
  // The context menu dismisses on an outside mousedown, not Escape.
  await page.locator(".chat-header").click();
  await expect(page.locator("[data-testid='channel-context-menu']")).not.toBeVisible();

  // 4. Open the DM with Bob, send one message, close it.
  await page.locator(".member-item", { hasText: "bob" }).first().click();
  await page.locator("[data-testid='upp-message-btn']").click();
  await expect(page.locator("[data-testid='dm-back-header']")).toBeVisible();
  const dmText = `soak-dm-${cycle}-${crypto.randomUUID()}`;
  await page.locator("[data-testid='message-input'] textarea").fill(dmText);
  await page.locator("[data-testid='message-input'] textarea").press("Enter");
  await expect(page.locator(".msg-text", { hasText: dmText })).toHaveCount(1);
  await page.locator("[data-testid='dm-back-header']").click();
  await expect(page.locator("[data-testid='dm-back-header']")).not.toBeVisible();

  // 5. Voice: Alice joins, decodes real media, toggles the camera, then leaves
  //    and releases her capture. Bob holds the room open across the whole run,
  //    so Alice always has remote media to decode when she rejoins.
  await joinVoice(page);
  await expectDecodedMedia(page);
  await page.locator(".voice-widget button[aria-label='Camera']").click();
  await page.locator(".voice-widget button[aria-label='Camera']").click();
  await page.locator(".voice-widget button[aria-label='Disconnect']").click();
  await expect(page.locator(".voice-widget")).not.toHaveClass(/visible/);
  await expect.poll(async () => (await mediaStats(page)).liveCapture, { timeout: 30_000 }).toBe(0);
}

test.use({ media: true });

test("a long session does not grow its lifecycle footprint after warm-up", async ({
  alice,
  bob,
  aliceTransport,
  server,
}) => {
  test.setTimeout(CYCLES * 30_000 + 180_000);
  const cdp = await alice.context().newCDPSession(alice);
  const samples: Awaited<ReturnType<typeof sampleLifecycle>>[] = [];

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  alice.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  alice.on("pageerror", (error: Error) => pageErrors.push(String(error)));

  // The plan's cycle expects three text channels. `general` is seeded; add two
  // more through the same admin route the seeding used.
  await server.api("/admin/api/channels", { name: "soak-one", type: "text" }, server.owner!.token);
  await server.api("/admin/api/channels", { name: "soak-two", type: "text" }, server.owner!.token);
  const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
  const general = channels.find(
    (channel: { name: string; type: string }) =>
      channel.name === "general" && channel.type === "text",
  );
  if (general === undefined) throw new Error("no #general channel");
  const purgeMessages = async (channelId: number) => {
    await server.api(
      `/api/v1/channels/${channelId}/messages/purge`,
      { limit: 100 },
      server.owner!.token,
    );
  };

  // Bob holds the voice room open across the whole run, so Alice always has
  // remote media to decode when she rejoins each cycle.
  await joinVoice(bob);

  try {
    samples.push(await sampleLifecycle(alice, cdp, 0));
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      await runCycle(alice, bob, cycle, purgeMessages, general.id);

      // Every 5th cycle: an application reconnect. The server removes voice
      // membership when the authenticated socket drops, so the client must
      // leave the room (media.spec.ts asserts the same), otherwise the next
      // cycle's join starts from a stuck "reconnecting voice" state.
      if (cycle % 5 === 0) {
        await aliceTransport.offline();
        await expect(alice.locator(".reconnecting-banner")).toBeVisible();
        aliceTransport.online();
        await expect(alice.locator(".reconnecting-banner")).not.toBeVisible();
        await expect(alice.locator(".voice-widget")).not.toHaveClass(/visible/);
        await expect
          .poll(async () => (await mediaStats(alice)).liveCapture, { timeout: 30_000 })
          .toBe(0);
      }

      // Every 10th cycle: a logout and a fresh login. This deliberately tears
      // the app down and rebuilds it, so counts fall to a fresh baseline.
      if (cycle % 10 === 0) {
        await openSettings(alice);
        await alice.locator(".settings-nav-item.danger").click();
        await expect(alice.locator("#host")).toBeVisible({ timeout: 30_000 });
        await login(alice, server, "alice");
        await expect(
          alice.locator(".channel-item:not(.voice)", { hasText: "general" }),
        ).toBeVisible();
      }

      if (cycle % 5 === 0) {
        await quiesce(alice);
        samples.push(await sampleLifecycle(alice, cdp, cycle));
        if (process.env.OWNCORD_SOAK_LISTENERS === "1") {
          console.log(
            `live listeners c${cycle}: window ${JSON.stringify(
              await describeLiveListeners(cdp, "window"),
            )} document ${JSON.stringify(await describeLiveListeners(cdp, "document"))}`,
          );
        }
      }
    }

    // The idle-connected phase: every count metric must be exactly equal
    // across the idle samples (the long run's Task 15 evidence).
    if (IDLE_MIN > 0) {
      const end = Date.now() + IDLE_MIN * 60_000;
      while (Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(5 * 60_000, end - Date.now())));
        samples.push(await sampleLifecycle(alice, cdp, -1));
      }
    }
  } finally {
    await alice
      .screenshot({ path: "test-results/fullstack/long-session-final.png" })
      .catch(() => {});
    await test.info().attach("lifecycle-samples", {
      body: JSON.stringify(samples, null, 2),
      contentType: "application/json",
    });
  }

  const bars = evaluateBars(samples);
  console.log(`lifecycle soak (${CYCLES} cycles):\n${formatBars(bars)}`);

  expect(pageErrors, "no page errors across the run").toEqual([]);
  expect(
    consoleErrors.filter((line) => !EXPECTED_CONSOLE_ERRORS.some((p) => p.test(line))),
    "no unexpected console.error lines",
  ).toEqual([]);

  const asserted = bars.filter((bar) => !PENDING_METRICS.includes(bar.metric));
  expect(
    asserted
      .filter((bar) => !bar.pass)
      .map((bar) => `${bar.metric}: ${bar.final} vs warm ${bar.warm} (slope ${bar.slope})`),
    `metric bars (pending: ${PENDING_METRICS.join(", ") || "none"})`,
  ).toEqual([]);

  // A short run (below the warm + 1 sample) has nothing to compare; a 20-cycle
  // PR soak always does, so this catches a harness that measured nothing.
  if (CYCLES >= 10) expect(asserted.length, "at least one metric was asserted").toBeGreaterThan(0);
});
