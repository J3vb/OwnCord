/**
 * B7-11 Task 14: the long-session soak over the Windows desktop shell.
 *
 * The same probe and bars as tests/e2e/fullstack/long-session.spec.ts, read
 * over WebView2's CDP port, so the real desktop adapters (`platform/desktop/*`,
 * the Rust HTTP and WebSocket transport) are exercised for a whole session.
 * One user and no second peer: the fullstack soak owns decoded two-party media.
 * The persistent fixture's page is already loaded when a spec starts, so the
 * timer ledger (an init script) is not installed and the timer counts read 0;
 * the fullstack soak covers timers for the same TypeScript.
 *
 * Ten cycles; the reconnect every 5th cycle goes through the fixture's TCP
 * gate. The within-page pair (cycles 6 and 9, after the reconnect) is what the
 * bars compare, at the plan's 0.05 per cycle.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../native-fixture-persistent";
import { ensureLoggedIn } from "./helpers";
import { openSettings, switchSettingsTab } from "../helpers";
import {
  evaluateBars,
  formatBars,
  sampleLifecycle,
  type LifecycleSample,
} from "../support/lifecycle-probe";
import { quiesce } from "../support/quiesce";

const CYCLES = 10;
const SAMPLED = new Set([0, 5, 6, 9, 10]);

async function runCycle(page: Page, cycle: number, purge: () => Promise<void>): Promise<void> {
  const input = page.locator("[data-testid='message-input'] textarea");
  const own = `native-soak-${cycle}-${crypto.randomUUID()}`;
  await input.fill(own);
  await input.press("Enter");
  const row = page.locator(".message", { has: page.locator(".msg-text", { hasText: own }) });
  await expect(row).not.toHaveClass(/pending/);
  await expect(row.locator(".msg-actions-bar")).toBeAttached();
  await row.hover();
  await row.locator("[data-testid^='msg-edit-']").click();
  await input.fill(`${own}-edited`);
  const edited = page.locator(".message", {
    has: page.locator(".msg-text", { hasText: `${own}-edited` }),
  });
  // The composer drops a submit within 200 ms of the last send (its
  // double-send guard); Enter again until the edit lands.
  await expect(async () => {
    await input.press("Enter");
    await expect(edited).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await edited.hover();
  await edited.locator("[data-testid^='msg-react-']").click();
  const picker = page.locator(".reaction-picker-wrap .emoji-picker.open");
  await expect(picker).toBeVisible();
  await picker.locator(".ep-emoji").first().click();
  await expect(edited.locator(".reaction-chip.me")).toHaveCount(1);
  await edited.locator(".reaction-chip.me").click();
  await expect(edited.locator(".reaction-chip.me")).toHaveCount(0);
  // Drained each cycle, as in the fullstack soak, so rows are not growth by
  // construction.
  await purge();
  await expect(edited).toHaveCount(0);

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
    "Account",
  ]) {
    await switchSettingsTab(page, tab);
  }
  await page.locator(".settings-close-btn").click();

  await page.keyboard.press("Control+k");
  await expect(page.locator(".quick-switcher-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".quick-switcher-overlay")).not.toBeVisible();
  await page.locator(".emoji-btn").click();
  await expect(page.locator(".emoji-picker.open")).toBeVisible();
  await page.locator(".chat-header").click();
  await expect(page.locator(".emoji-picker.open")).not.toBeVisible();
  await page
    .locator(".channel-item:not(.voice)", { hasText: "general" })
    .click({ button: "right" });
  await expect(page.locator("[data-testid='channel-context-menu']")).toBeVisible();
  await page.locator(".chat-header").click();
  await expect(page.locator("[data-testid='channel-context-menu']")).not.toBeVisible();

  // Voice join and leave over the real desktop voice path. The 60 s bound is
  // voice-controls.spec.ts's, for the same fixture.
  await page.locator(".channel-item.voice", { hasText: "voice-one" }).click();
  const widget = page.locator(".voice-widget.visible");
  await expect(widget).toContainText("Voice Connected", { timeout: 60_000 });
  await widget.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(widget).toBeHidden();
}

test("the desktop shell does not grow its lifecycle footprint within a session", async ({
  nativePage: page,
  nativeServer: server,
}) => {
  test.setTimeout(15 * 60_000);
  await ensureLoggedIn(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const cdp = await page.context().newCDPSession(page);
  const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
  const general = channels.find(
    (c: { name: string; type: string }) => c.name === "general" && c.type === "text",
  );
  const purge = async () => {
    await server.api(
      `/api/v1/channels/${general.id}/messages/purge`,
      { limit: 100 },
      server.owner!.token,
    );
  };

  const samples: LifecycleSample[] = [];
  try {
    await quiesce(page);
    samples.push(await sampleLifecycle(page, cdp, 0));
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      await runCycle(page, cycle, purge);
      if (cycle % 5 === 0) {
        server.network.offline();
        try {
          await expect(page.locator(".reconnecting-banner")).toBeVisible();
        } finally {
          server.network.online();
        }
        await expect(page.locator(".reconnecting-banner")).not.toBeVisible({ timeout: 30_000 });
      }
      if (SAMPLED.has(cycle)) {
        await quiesce(page);
        samples.push(await sampleLifecycle(page, cdp, cycle));
      }
    }
  } finally {
    await test.info().attach("lifecycle-samples", {
      body: JSON.stringify(samples, null, 2),
      contentType: "application/json",
    });
    await cdp.detach().catch(() => {});
  }

  const bars = evaluateBars(samples);
  console.log(`native lifecycle soak (${CYCLES} cycles):\n${formatBars(bars)}`);
  expect(pageErrors, "no page errors across the run").toEqual([]);
  expect(
    bars.filter((bar) => !bar.pass).map((bar) => `${bar.metric}: ${bar.bar}`),
    "metric bars",
  ).toEqual([]);
});
