/**
 * Fullstack: the B9-7 NSFW consent gate against the real Go server
 * (counterpart to the mocked `b9-nsfw-consent.spec.ts`).
 *
 * The label, the acknowledgement row, the nsfw_ack fan-out and the server's
 * refusal of pre-consent reads are all the real server's; the client under
 * test only sees them through production routes and frames. Every first-party
 * content request and every external-content broker call bob's pages make is
 * recorded at the IPC seam, so "nothing loads before consent" is observed.
 */

import type { Browser, Page } from "@playwright/test";
import { test, expect, login } from "./fixtures";
import { installRealTransport } from "../support/real-transport";
import type { TestServer } from "../support/server";
import { openSettings } from "../helpers";

const EVIDENCE = process.env.OWNCORD_E2E_EVIDENCE_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}.png` });
}

/** Record every HTTP request and broker invocation the page makes from now on. */
async function recordTraffic(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
      __traffic: string[];
    };
    w.__traffic = [];
    const inner = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    w.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      if (command === "plugin:http|fetch") {
        const { method, url } = args.clientConfig as { method: string; url: string };
        w.__traffic.push(`${method} ${new URL(url).pathname}${new URL(url).search}`);
      } else if (command.startsWith("external_")) {
        w.__traffic.push(`broker ${command}`);
      }
      return inner(command, args);
    };
  });
}

/** Content requests (history, pins, search, attachments) and broker calls for `channelId`. */
async function contentTraffic(page: Page, channelId: number): Promise<string[]> {
  const all = await page.evaluate(() => (window as unknown as { __traffic: string[] }).__traffic);
  return all.filter(
    (line) =>
      line.startsWith("broker ") ||
      line.includes(`/channels/${channelId}/messages`) ||
      line.includes(`/channels/${channelId}/pins`) ||
      line.includes("/search") ||
      line.includes("/files/") ||
      line.includes("/attachments"),
  );
}

async function clearTraffic(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __traffic: string[] }).__traffic.length = 0;
  });
}

async function secondDevice(browser: Browser, server: TestServer) {
  const context = await browser.newContext({ baseURL: "http://localhost:4173" });
  const page = await context.newPage();
  const transport = await installRealTransport(page, server);
  await login(page, server, "bob");
  return { page, transport, context };
}

const channelItem = (page: Page, name: string) =>
  page.locator(".channel-item:not(.voice)").filter({ hasText: name });
const gate = (page: Page) => page.getByTestId("nsfw-gate");
const bar = (page: Page) => page.getByTestId("nsfw-consent-bar");

test.describe("B9-7 NSFW consent gate (real server)", () => {
  test("label, decline, failed acknowledgement, accept, second device, revoke, reconnect, unlabel", async ({
    browser,
    alice,
    bob,
    bobTransport,
    server,
  }) => {
    const owner = server.owner!.token;
    const channels = (await server.api("/api/v1/channels/", undefined, owner)) as {
      id: number;
      name: string;
      type: string;
    }[];
    const general = channels.find((c) => c.name === "general" && c.type === "text")!;
    await server.api("/admin/api/channels", { name: "random", type: "text" }, owner);
    await expect(channelItem(bob, "random")).toBeVisible();

    // Content exists before the label: alice posts, bob reads it.
    const secret = `nsfw-content-${Date.now()}`;
    await channelItem(alice, "general").click();
    await alice.locator("[data-testid='message-input'] textarea").fill(secret);
    await alice.locator("[data-testid='message-input'] textarea").press("Enter");
    await channelItem(bob, "general").click();
    await expect(bob.locator(".msg-text", { hasText: secret })).toHaveCount(1);
    await recordTraffic(bob);

    // 1. A moderator labels the channel bob is reading: his view regates live
    //    and the already-rendered content leaves the DOM.
    await server.api(`/admin/api/channels/${general.id}`, { nsfw: true }, owner, "PATCH");
    await expect(gate(bob)).toBeVisible();
    await expect(bob.locator(".msg-text", { hasText: secret })).toHaveCount(0);
    await expect(gate(bob)).toContainText("#general is age-restricted");
    await expect(gate(bob)).toContainText("applies on every device");
    await shot(bob, "01-relabel-live-gate");
    // The moderator who labelled it is gated like anyone else.
    await expect(gate(alice)).toBeVisible();

    // The server itself refuses bob's pre-consent read.
    const bobLogin = (await server.api("/api/v1/auth/login", {
      username: "bob",
      password: "OwnCord-E2E-pass-123!",
    })) as { token: string };
    await expect(
      server.api(`/api/v1/channels/${general.id}/messages`, undefined, bobLogin.token),
    ).rejects.toThrow(/NSFW_ACKNOWLEDGEMENT_REQUIRED/);

    // Alternate entry points behind the gate: pins fetch nothing, and search
    // (server-wide only here) does not surface the labelled channel's text.
    await bob.getByTestId("pin-btn").click();
    await bob.getByTestId("search-input").focus();
    await bob.getByTestId("search-overlay-input").fill(secret);
    await expect(bob.locator(".search-overlay")).toBeVisible();
    await bob.waitForTimeout(1_500);
    await expect(bob.locator(".search-result-item", { hasText: secret })).toHaveCount(0);
    await shot(bob, "01b-gated-search-no-result");
    await bob.keyboard.press("Escape");
    await expect(bob.locator(".search-overlay")).toHaveCount(0);
    // Only an unscoped search may leave; nothing names the gated channel.
    const gatedTraffic = await contentTraffic(bob, general.id);
    expect(gatedTraffic.filter((l) => !/^GET \/api\/v1\/search\?/.test(l))).toEqual([]);
    expect(gatedTraffic.filter((l) => l.includes(`channel_id=${general.id}`))).toEqual([]);
    await clearTraffic(bob);

    // 2. Decline leaves the channel; re-entering shows the gate again.
    await bob.getByTestId("nsfw-gate-back").click();
    await expect(gate(bob)).toHaveCount(0);
    // Focus falls back to the sidebar, not <body>.
    await expect(bob.locator(".unified-sidebar :focus")).toHaveCount(1);
    await shot(bob, "02-declined");
    await channelItem(bob, "general").click();
    await expect(gate(bob)).toBeVisible();
    // Keyboard: focus lands on the heading, Escape declines.
    await expect(bob.locator(".nsfw-gate-title")).toBeFocused();
    await bob.keyboard.press("Escape");
    await expect(gate(bob)).toHaveCount(0);
    await expect(bob.locator(".unified-sidebar :focus")).toHaveCount(1);
    await channelItem(bob, "general").click();
    await expect(gate(bob)).toBeVisible();

    // 3. A failed acknowledgement keeps the gate up with an error.
    bobTransport.failHttpRequests(
      (r) => r.method === "PUT" && r.path.endsWith("/nsfw-acknowledgement"),
    );
    await bob.getByTestId("nsfw-gate-continue").click();
    await expect(bob.getByTestId("nsfw-gate-error")).toContainText("could not be saved");
    await expect(gate(bob)).toBeVisible();
    await shot(bob, "03-ack-failed");
    expect(await contentTraffic(bob, general.id)).toEqual([]);
    // Still refused by the server: the failed PUT recorded nothing.
    await expect(
      server.api(`/api/v1/channels/${general.id}/messages`, undefined, bobLogin.token),
    ).rejects.toThrow(/NSFW_ACKNOWLEDGEMENT_REQUIRED/);

    // 4. Accept: content loads only after the server's 204.
    bobTransport.failHttpRequests(undefined);
    await bob.getByTestId("nsfw-gate-continue").click();
    await expect(bob.locator(".msg-text", { hasText: secret })).toHaveCount(1);
    await expect(bar(bob)).toBeVisible();
    // Focus moves from the removed gate button to the new composer.
    await expect(bob.locator("[data-testid='message-input'] textarea")).toBeFocused();
    await shot(bob, "04-accepted");
    const afterAccept = await bob.evaluate(
      () => (window as unknown as { __traffic: string[] }).__traffic,
    );
    const put = afterAccept.findIndex(
      (l) => l.startsWith("PUT") && l.includes("nsfw-acknowledgement"),
    );
    const firstRead = afterAccept.findIndex((l) => l.includes(`/channels/${general.id}/messages`));
    expect(put).toBeGreaterThanOrEqual(0);
    expect(firstRead).toBeGreaterThan(put);
    // Control for the gated search above: with consent the same query finds it.
    await bob.getByTestId("search-input").focus();
    await bob.getByTestId("search-overlay-input").fill(secret);
    await expect(bob.locator(".search-result-item", { hasText: secret })).toHaveCount(1);
    await shot(bob, "04b-consented-search-finds-it");
    await bob.keyboard.press("Escape");
    await expect(bob.locator(".search-overlay")).toHaveCount(0);

    // 5. A second device inherits the server's consent without a prompt.
    //    (The server keeps one live socket per account, so device 1 is
    //    displaced and shows "Signed in elsewhere".)
    const device2 = await secondDevice(browser, server);
    try {
      await channelItem(device2.page, "general").click();
      await expect(device2.page.locator(".msg-text", { hasText: secret })).toHaveCount(1);
      await expect(gate(device2.page)).toHaveCount(0);
      await expect(bar(device2.page)).toBeVisible();
      await shot(device2.page, "05-second-device-inherits");

      // 6. Pins open, then revoke: the channel regates and the pins panel
      //    closes with it.
      await recordTraffic(device2.page);
      await device2.page.getByTestId("pin-btn").click();
      await expect(device2.page.locator(".pinned-panel")).toBeVisible();
      await clearTraffic(device2.page);
      await device2.page.getByTestId("nsfw-consent-revoke").click();
      await expect(gate(device2.page)).toBeVisible();
      await expect(device2.page.locator(".msg-text", { hasText: secret })).toHaveCount(0);
      await expect(device2.page.locator(".pinned-panel")).toHaveCount(0);
      await shot(device2.page, "06-revoked-pins-closed");
      expect(await contentTraffic(device2.page, general.id)).toEqual([]);
      await expect(
        server.api(`/api/v1/channels/${general.id}/messages`, undefined, bobLogin.token),
      ).rejects.toThrow(/NSFW_ACKNOWLEDGEMENT_REQUIRED/);

      // 7. Device 1 reconnects ("Use here"): the authoritative ready carries
      //    the revoke, so the content it showed is unmounted and nothing is
      //    fetched.
      await expect(bob.getByRole("button", { name: "Use here" })).toBeVisible();
      await shot(bob, "07a-device1-displaced-before-reconnect");
      await clearTraffic(bob);
      await bob.getByRole("button", { name: "Use here" }).click();
      await expect(gate(bob)).toBeVisible({ timeout: 30_000 });
      await expect(bob.locator(".msg-text", { hasText: secret })).toHaveCount(0);
      await bob.waitForTimeout(3_000);
      await expect(gate(bob)).toBeVisible();
      await shot(bob, "07b-device1-reconnected-gated");
      expect(await contentTraffic(bob, general.id)).toEqual([]);

      // 8. Accept again, then a moderator removes the label: the withdraw
      //    bar goes away rather than offering a 409-bound withdraw.
      await bob.getByTestId("nsfw-gate-continue").click();
      await expect(bar(bob)).toBeVisible();
      await expect(bob.locator(".msg-text", { hasText: secret })).toHaveCount(1);
      // A half-typed message survives the unlabel: only the bar is removed.
      const composer = bob.locator("[data-testid='message-input'] textarea");
      await composer.fill("draft kept across unlabel");
      await server.api(`/admin/api/channels/${general.id}`, { nsfw: false }, owner, "PATCH");
      await expect(bar(bob)).toHaveCount(0);
      await expect(bob.locator(".msg-text", { hasText: secret })).toHaveCount(1);
      await expect(composer).toHaveValue("draft kept across unlabel");
      await shot(bob, "08-unlabelled-no-bar");
    } finally {
      await device2.transport.close();
      await device2.context.close();
      expect(device2.transport.errors).toEqual([]);
    }
  });
});

test.describe("B9-7 NSFW remote regate focus (real server)", () => {
  test("a remote regate moves focus from the replaced composer to the gate, never out of an open dialog", async ({
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    const channels = (await server.api("/api/v1/channels/", undefined, owner)) as {
      id: number;
      name: string;
      type: string;
    }[];
    const general = channels.find((c) => c.name === "general" && c.type === "text")!;
    const bobApi = (
      (await server.api("/api/v1/auth/login", {
        username: "bob",
        password: "OwnCord-E2E-pass-123!",
      })) as { token: string }
    ).token;
    const composer = bob.locator("[data-testid='message-input'] textarea");
    const withdrawElsewhere = () =>
      server.api(
        `/api/v1/channels/${general.id}/nsfw-acknowledgement`,
        undefined,
        bobApi,
        "DELETE",
      );

    // 1. A moderator labels the channel while bob types: the composer is
    //    removed with the content, so focus goes to the gate heading.
    await channelItem(bob, "general").click();
    await composer.click();
    await composer.fill("typing when labelled");
    await server.api(`/admin/api/channels/${general.id}`, { nsfw: true }, owner, "PATCH");
    await expect(gate(bob)).toBeVisible();
    await expect(bob.locator(".nsfw-gate-title")).toBeFocused();
    await shot(bob, "09-relabel-while-typing-focus-on-gate");

    // 2. Consent, then withdraw from another session while typing: the
    //    nsfw_ack frame regates this device and focus follows to the heading.
    await bob.getByTestId("nsfw-gate-continue").click();
    await expect(composer).toBeFocused();
    await composer.fill("typing when withdrawn elsewhere");
    await withdrawElsewhere();
    await expect(gate(bob)).toBeVisible();
    await expect(composer).toHaveCount(0);
    await expect(bob.locator(".nsfw-gate-title")).toBeFocused();
    await shot(bob, "10-remote-withdraw-while-typing-focus-on-gate");

    // 3. Consent again, open Settings, withdraw elsewhere: the channel regates
    //    behind the dialog and focus stays inside it.
    await bob.getByTestId("nsfw-gate-continue").click();
    await expect(bar(bob)).toBeVisible();
    await openSettings(bob);
    const overlay = bob.getByTestId("settings-overlay");
    const focusInDialog = () =>
      bob.evaluate(() =>
        Boolean(
          document
            .querySelector("[data-testid='settings-overlay']")
            ?.contains(document.activeElement),
        ),
      );
    await expect.poll(focusInDialog).toBe(true);
    await withdrawElsewhere();
    await expect(gate(bob)).toBeAttached();
    await expect(bar(bob)).toHaveCount(0);
    await bob.waitForTimeout(500);
    expect(await focusInDialog()).toBe(true);
    await expect(bob.locator(".nsfw-gate-title")).not.toBeFocused();
    await shot(bob, "11-remote-withdraw-settings-keeps-focus");
    await bob.keyboard.press("Escape");
    await expect(overlay).not.toHaveClass(/open/);
    await expect(gate(bob)).toBeVisible();
    await shot(bob, "12-settings-closed-gate-behind");
  });
});
