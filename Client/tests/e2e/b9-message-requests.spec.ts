/**
 * B9-5: the Message Requests inbox in the real shell (Q2).
 *
 * Journey: open a first-contact request, read the sender and the plain text,
 * leave, and reconnect, without accepting it or fetching anything on the
 * stranger's behalf. The fetch spies are the Tauri IPC log (every HTTP call,
 * the external-content broker, notifications) and the browser's own request
 * events (an <img>, a CSS url(), a prefetch).
 */
import type { Page, Request } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  emitWsEvent,
  emitWsMessage,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  submitLogin,
  waitForWsReady,
} from "./helpers";
import {
  findUnnamedControls,
  focusIndicator,
  Q1,
  setAppearance,
  textContrast,
} from "./support/b9-accessibility";

const HOSTILE = [
  "hey, check this out https://evil.example/cat.gif",
  "![img](https://evil.example/pixel.png) <img src=https://evil.example/x.png>",
  ":party_parrot: @everyone [file](/api/v1/files/42/download)",
  "averyveryverylongunbrokenwordthatmustwrapinsteadofpushingthelayoutsidewaysaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
].join("\n");

const REQUESTS = [
  {
    id: 2,
    channel_id: 202,
    sender: {
      id: 12,
      username: "stranger",
      display_name: "A Stranger",
      avatar: "https://tracker.example/avatar.png",
    },
    preview: { message_id: 902, content: HOSTILE, timestamp: "2026-09-05T12:00:00Z" },
    created_at: "2026-09-05T12:00:00Z",
  },
  {
    // An erased sender with an attachment-only first message.
    id: 1,
    channel_id: 201,
    sender: { id: 11, username: "", display_name: "", avatar: "" },
    preview: null,
    created_at: "2026-09-04T09:30:00Z",
  },
];

const DM_CHANNELS = [
  {
    channel_id: 100,
    recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 0,
  },
];

function mockScript(): string {
  return buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
      { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
      { pattern: "/api/v1/dm-requests", status: 200, body: { requests: REQUESTS } },
    ],
    simulateWsFlow: true,
    readyOverrides: { dm_channels: DM_CHANNELS },
  });
}

async function signIn(page: Page): Promise<void> {
  await submitLogin(page);
  await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
  await waitForWsReady(page);
  await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("general");
}

interface IpcCall {
  readonly cmd: string;
  readonly args?: { clientConfig?: { url?: string } };
}

async function ipcLog(page: Page): Promise<IpcCall[]> {
  return page.evaluate(() => (window as unknown as { __invokeLog: IpcCall[] }).__invokeLog);
}

const httpUrls = (calls: readonly IpcCall[]): string[] =>
  calls.filter((c) => c.cmd === "plugin:http|fetch").map((c) => c.args?.clientConfig?.url ?? "");

const inboxReads = async (page: Page): Promise<number> =>
  httpUrls(await ipcLog(page)).filter((u) => u.includes("/api/v1/dm-requests")).length;

/** Go to DM mode, where "Message Requests (N)" sits at the top. */
async function toDmMode(page: Page): Promise<void> {
  await page.locator("[data-testid='dm-entry']").first().click();
  await expect(page.locator("[data-testid='dm-back-header']")).toBeVisible();
}

const view = (page: Page) => page.getByRole("region", { name: "Message Requests" });
const entry = (page: Page) => page.locator("[data-testid='dm-requests-entry']");
const items = (page: Page) => page.locator("[data-testid='request-item']");

test.describe("B9-5 Message Requests inbox", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(mockScript());
    await page.goto("/");
    await signIn(page);
  });

  test("open a request, read it as plain text, leave — nothing fetched, nothing accepted", async ({
    page,
  }) => {
    // The DM header badge counts requests apart from unread (Q2).
    const badge = page.locator("[data-testid='dm-requests-badge']");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("22 pending message requests");
    await expect(page.locator(".dm-header-unread-badge")).toBeHidden();

    await toDmMode(page);
    await expect(entry(page)).toHaveText("Message Requests (2)");

    // Everything the stranger's content could make the app load, from here on.
    const before = (await ipcLog(page)).length;
    const browserLoads: string[] = [];
    const onRequest = (r: Request): void => {
      browserLoads.push(r.url());
    };
    page.on("request", onRequest);

    // Keyboard open: the heading takes focus inside the named region.
    await entry(page).focus();
    await page.keyboard.press("Enter");
    await expect(view(page)).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Message Requests" })).toBeFocused();
    await expect(entry(page)).toHaveAttribute("aria-current", "page");

    // Sender and text, as text.
    await expect(items(page)).toHaveCount(2);
    const first = items(page).nth(0);
    await expect(first.getByRole("heading", { level: 3 })).toHaveText("A Stranger");
    await expect(first.locator(".requests-username")).toHaveText("@stranger");
    await expect(first.locator(".requests-preview")).toHaveText(HOSTILE);
    const erased = items(page).nth(1);
    await expect(erased.getByRole("heading", { level: 3 })).toHaveText("Unknown user");
    await expect(erased.locator(".requests-preview")).toHaveText(
      "This message has no text to preview.",
    );
    await expect(
      view(page).locator("img, a, iframe, video, audio, picture, object, embed"),
    ).toHaveCount(0);
    expect(await findUnnamedControls(view(page))).toEqual([]);

    // Tab order: heading, Close, then the list, which scrolls by keyboard.
    // Both rings meet Q1.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Close Message Requests" })).toBeFocused();
    expect((await focusIndicator(page)).problems).toEqual([]);
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-testid='requests-list']")).toBeFocused();
    expect((await focusIndicator(page)).problems).toEqual([]);
    await page.keyboard.press("End");

    // Leave: Escape takes the channelBeforeDm path back to #general.
    await page.keyboard.press("Escape");
    await expect(view(page)).toBeHidden();
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("general");
    await expect(page.locator("[data-testid='chat-area'] textarea")).toBeFocused();

    page.off("request", onRequest);
    const after = (await ipcLog(page)).slice(before);
    expect(after.filter((c) => c.cmd.startsWith("external_"))).toEqual([]);
    expect(after.filter((c) => c.cmd.startsWith("plugin:notification"))).toEqual([]);
    // Returning to #general reloads the shell's own data. Nothing goes out
    // for a request: no decision, no history of its channel, no file, no
    // sender profile, no stranger URL.
    const urls = httpUrls(after);
    expect(urls.length).toBeGreaterThan(0);
    expect(
      urls.filter((u) =>
        /dm-requests|\/channels\/20\d|\/files\/|\/users\/1\d\b|evil\.example|tracker\.example/.test(
          u,
        ),
      ),
    ).toEqual([]);
    expect(browserLoads.filter((u) => /evil\.example|tracker\.example|\/files\//.test(u))).toEqual(
      [],
    );
    // Still pending: leaving is not accepting.
    await expect(badge).toHaveText("22 pending message requests");
  });

  test("live frames update the count, and a reconnect restores the server's inbox", async ({
    page,
  }) => {
    await toDmMode(page);
    await expect(entry(page)).toHaveText("Message Requests (2)");
    const pending = {
      id: 9,
      state: "pending",
      channel_id: 209,
      sender: { id: 19, username: "newcomer", display_name: "", avatar: "" },
      preview: { message_id: 909, content: "hello?", timestamp: "2026-09-06T08:00:00Z" },
      created_at: "2026-09-06T08:00:00Z",
      decided_at: null,
    };
    await emitWsMessage(page, { type: "dm_request", payload: pending });
    await expect(entry(page)).toHaveText("Message Requests (3)");

    await entry(page).click();
    await expect(items(page)).toHaveCount(3);
    await expect(items(page).first().getByRole("heading", { level: 3 })).toHaveText("newcomer");

    // Decided on another device: it leaves the open inbox.
    await emitWsMessage(page, {
      type: "dm_request",
      payload: { ...pending, state: "ignored", preview: null, decided_at: "2026-09-06T08:01:00Z" },
    });
    await expect(items(page)).toHaveCount(2);

    // Re-add it, then drop the connection: the view says it may be stale, and
    // the reconnect's snapshot (which never had #9) is the truth again.
    await emitWsMessage(page, { type: "dm_request", payload: pending });
    await expect(items(page)).toHaveCount(3);
    const reads = await inboxReads(page);
    await emitWsEvent(page, "ws-state", "closed");
    await expect(page.locator("[data-testid='requests-status']")).toHaveText(
      "Reconnecting. This list may be out of date.",
    );
    await expect.poll(() => inboxReads(page), { timeout: 15_000 }).toBeGreaterThan(reads);
    await expect(items(page)).toHaveCount(2);
    await expect(page.locator("[data-testid='requests-status']")).toHaveText("");
    // The reconnect keeps the view open, with its return channel.
    await expect(view(page)).toBeVisible();
    await page.locator("[data-testid='feature-view-close']").click();
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("general");
  });

  test("text contrast meets Q1 in every built-in theme and High Contrast", async ({ page }) => {
    const themes = ["neon-glow", "dark", "midnight", "light"] as const;
    for (const theme of themes) {
      for (const highContrast of [false, true]) {
        await setAppearance(page, { theme, highContrast });
        await signIn(page);
        await toDmMode(page);
        await entry(page).click();
        await expect(items(page)).toHaveCount(2);
        for (const sel of [
          ".requests-intro",
          ".requests-sender",
          ".requests-username",
          ".requests-time",
          ".requests-preview",
          ".requests-preview-empty",
        ]) {
          const { ratio, fg, bg } = await textContrast(view(page).locator(sel).first());
          expect(
            ratio,
            `${theme}${highContrast ? "+HC" : ""} ${sel}: ${fg} on ${bg}`,
          ).toBeGreaterThanOrEqual(Q1.text);
        }
      }
    }
  });
});

test.describe("B9-5 inbox at the minimum window with 20px Large Font", () => {
  test.use({ viewport: { width: 940, height: 500 } });

  test("keeps every request reachable, wrapped and still", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem("owncord:settings:fontSize", "20");
      localStorage.setItem("owncord:settings:largeFont", "true");
      localStorage.setItem("owncord:settings:reducedMotion", "true");
    });
    await page.addInitScript(mockScript());
    await page.goto("/");
    await signIn(page);
    await toDmMode(page);
    await entry(page).click();
    await expect(items(page)).toHaveCount(2);

    const list = page.locator("[data-testid='requests-list']");
    for (const i of [0, 1]) {
      const row = items(page).nth(i);
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator(".requests-preview")).toBeInViewport();
      expect(await row.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    }
    expect(await list.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await expect(page.locator("[data-testid='feature-view-close']")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    // Nothing in the inbox animates.
    expect(await view(page).evaluate((n) => n.getAnimations({ subtree: true }).length)).toBe(0);
    await testInfo.attach("message-requests-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
