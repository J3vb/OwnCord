/**
 * B7-11a: the long-session soak.
 *
 * The PR soak runs a bounded number of full session cycles (default 20) against
 * a real server and real encrypted media, sampling Chromium's own counters
 * after a forced GC. It is the runtime half of the milestone: the static
 * inventory (tests/unit/lifecycle-ownership.test.ts) cannot see a listener on a
 * signal that outlives the thing it served (OC-0335/0336/0365).
 *
 * The pass bar is "no net growth after warm-up" (tests/e2e/support/
 * lifecycle-probe.ts). `login()` navigates, so every 10-cycle generation is a
 * fresh page. Samples are taken at cycle 0 and every 5 cycles (right after the
 * reconnect or the logout), which compare like-for-like across pages, plus at
 * cycles 6 and 9 of every page, which compare like-for-like within one page:
 * both come after that page's reconnect and neither directly follows one. A
 * leak that the re-login navigation releases shows only in that within-page
 * pair. The series is attached to the Playwright report as JSON, so a failure
 * shows the curve.
 *
 * Env:
 *   OWNCORD_SOAK_CYCLES    cycles to run (default 20)
 *   OWNCORD_SOAK_IDLE_MIN  idle-connected minutes sampled every 5 min (default 0)
 *
 * The long run (>= 200 cycles + 30 idle minutes) is `npm run test:e2e:soak`,
 * over this same spec.
 */
import { test as base, expect } from "./fixtures";
import { login } from "./fixtures";
import type { ConsoleMessage, Page } from "@playwright/test";
import { expectDecodedMedia, joinVoice, mediaStats } from "../support/media";
import type { TestServer } from "../support/server";
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
/** Phases of the 10-cycle page (`cycle % 10`) sampled for the within-page pair. */
const WITHIN_PAGE_PHASES = new Set([6, 9]);

// The reconnect and logout steps deliberately drop the socket, so the client
// logs its own transport failure while it is offline. Only the exact messages
// those steps emit are expected; a genuine error that merely mentions
// "reconnect" must still fail the run. Both were observed in calibration runs
// and are listed by their real text.
const EXPECTED_CONSOLE_ERRORS = [
  // `ws_send` on a closed socket (lib/ws.ts:539).
  /\[ws\] ws_send failed \{error: WS is not open/,
  // LiveKit's signaling socket, dropped by the every-5th-cycle reconnect; the
  // message's own text, not a bare "reconnect" substring.
  /error reading from signal stream \{room: channel-\d+.*WS closed unexpectedly with code 100[06]/,
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

/** Log out from settings and log back in, as a user would. */
async function relogin(page: Page, server: TestServer): Promise<void> {
  await openSettings(page);
  await page.locator(".settings-nav-item.danger").click();
  await expect(page.locator("#host")).toBeVisible({ timeout: 30_000 });
  await login(page, server, "alice");
  await expect(page.locator(".channel-item:not(.voice)", { hasText: "general" })).toBeVisible();
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
    // Back to the first tab: the last tab stays mounted while settings is
    // closed, and the Logs view renders the logger's whole ring buffer
    // (MAX_LOG_BUFFER, 500 entries), so ending on it would sample the ring's
    // fill level, not a leak.
    "Account",
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
  const dmHeader = page.locator("[data-testid='dm-back-header']");
  await expect(async () => {
    if (await dmHeader.isVisible()) return;
    await page.keyboard.press("Escape");
    await page.locator(".member-item", { hasText: "bob" }).first().click({ timeout: 5_000 });
    const popup = page.locator("[data-testid='user-profile-popup'].open");
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.locator("[data-testid='upp-message-btn']").click({ timeout: 5_000 });
    await expect(dmHeader).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
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
  test.setTimeout(CYCLES * 30_000 + IDLE_MIN * 60_000 + 180_000);
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

  // The first login in a fresh browser has no saved server profile yet, so the
  // connect page has not fetched the server info that later pages render (the
  // Account tab's retention notice). One relogin up front makes every sampled
  // page start from the same stored state.
  await relogin(alice, server);

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
      if (cycle % 10 === 0) await relogin(alice, server);

      if (cycle % 5 === 0 || WITHIN_PAGE_PHASES.has(cycle % 10)) {
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

    // The idle-connected phase: with no user activity, every count metric must
    // be exactly equal across the idle samples — a poller that allocates per
    // tick (health, connection stats, presence, heartbeat) shows up here. The PR
    // soak does not run it (OWNCORD_SOAK_IDLE_MIN defaults to 0); the long run
    // does.
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

  // Every metric is asserted at the plan's bar.
  expect(
    bars
      .filter((bar) => !bar.pass)
      .map((bar) => `${bar.metric}: ${bar.final} vs warm ${bar.warm} (slope ${bar.slope})`),
    "metric bars",
  ).toEqual([]);

  // A short run (below the warm + 1 sample) has nothing to compare; a 20-cycle
  // PR soak always does, so this catches a harness that measured nothing.
  if (CYCLES >= 10) expect(bars.length, "at least one metric was asserted").toBeGreaterThan(0);

  // The idle-connected phase (long run only): no count may move across the idle
  // samples at all. `documents` and `intervals` are already checked exactly by
  // `evaluateBars`; here every count metric is.
  const idle = samples.filter((s) => s.cycle === -1);
  if (idle.length > 1) {
    const countMetrics = [
      "documents",
      "nodes",
      "listeners",
      "abortControllers",
      "intervals",
      "timeouts",
      "sockets",
      "peerConnections",
      "tracks",
      "audioContexts",
    ] as const;
    const drifted: string[] = [];
    for (const metric of countMetrics) {
      const first = idle[0]![metric];
      if (!idle.every((s) => s[metric] === first))
        drifted.push(`${metric}: ${idle.map((s) => s[metric]).join("→")}`);
    }
    expect(drifted, "idle-phase counts must be exactly equal").toEqual([]);
  }
});
