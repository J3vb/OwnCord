/**
 * Mocked E2E: DM calls (audit batch N4, gap #6) — the incoming-call banner
 * (accept/decline), the ring chime, the DM "Start a call" button, and the call
 * state after accept.
 *
 * A "call" is presence in the DM's voice channel: `call_incoming` rings a
 * banner, Accept joins voice, Decline answers `call_decline`. Every assertion
 * here is on the rendered UI, on the outgoing `ws_send` frames the app actually
 * issued (`window.__invokeLog`, populated by the Tauri mock), or on the chime
 * the app's own AudioContext graph played — never on the mock's internals.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  emitWsMessage,
  navigateToMainPage,
  waitForWsReady,
  voiceWsHandlers,
} from "./helpers";

// ---------------------------------------------------------------------------
// Fixtures — one DM (channel 100) whose recipient has a nickname
// ---------------------------------------------------------------------------

const OTHER_USER_ID = 2;
const DM_CHANNEL_ID = 100;

const READY_MEMBERS = [
  { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
  // display_name exercises the banner's nickname resolution (OC-0303): the
  // ring must read "Otto is calling", not the raw handle.
  {
    id: OTHER_USER_ID,
    username: "otheruser",
    display_name: "Otto",
    avatar: "",
    status: "online",
    role: "member",
  },
  { id: 3, username: "thirduser", avatar: "", status: "idle", role: "member" },
];

const MOCK_DM_CHANNELS = [
  {
    channel_id: DM_CHANNEL_ID,
    recipient: { id: OTHER_USER_ID, username: "otheruser", avatar: "", status: "online" },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 0,
  },
  {
    channel_id: 101,
    recipient: { id: 3, username: "thirduser", avatar: "", status: "idle" },
    last_message_id: 501,
    last_message: "See you later",
    last_message_at: "2026-03-15T11:00:00Z",
    unread_count: 0,
  },
];

async function mockSession(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        { pattern: "GET /api/v1/dms", status: 200, body: MOCK_DM_CHANNELS },
      ],
      simulateWsFlow: true,
      wsHandlers: voiceWsHandlers(),
      readyOverrides: {
        members: READY_MEMBERS,
        dm_channels: MOCK_DM_CHANNELS,
      },
    }),
  );
}

/**
 * Count the oscillators the app's notification graph creates. The ring chime is
 * audible only through `AudioContext`, so this is the one honest way to see
 * "is it ringing". Patches the prototype before any app code runs; the app's
 * own `playNotificationSound` is untouched.
 */
async function installChimeProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __chimeCount: number }).__chimeCount = 0;
    const original = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (this: AudioContext) {
      (window as unknown as { __chimeCount: number }).__chimeCount += 1;
      return original.call(this);
    };
  });
}

async function chimeCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __chimeCount?: number }).__chimeCount ?? 0);
}

// ---------------------------------------------------------------------------
// Outgoing-frame capture — the mock's own IPC log, no extra init script
// ---------------------------------------------------------------------------

interface SentFrame {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}

async function sentFrames(page: Page): Promise<SentFrame[]> {
  return page.evaluate(() => {
    const log = (
      window as unknown as { __invokeLog: Array<{ cmd: string; args?: { message?: string } }> }
    ).__invokeLog;
    const frames: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    for (const entry of log) {
      if (entry.cmd !== "ws_send") continue;
      try {
        frames.push(JSON.parse(entry.args?.message ?? "{}"));
      } catch {
        // A frame that is not JSON is not a client WS message; skip it.
      }
    }
    return frames;
  });
}

/** Poll until a matching frame has gone out, and return it. */
async function waitForSent(
  page: Page,
  type: string,
  has: (frame: SentFrame) => boolean = () => true,
  timeout = 5_000,
): Promise<SentFrame> {
  let found: SentFrame | undefined;
  await expect(async () => {
    found = (await sentFrames(page)).find((f) => f.type === type && has(f));
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

function sentTo(page: Page, type: string, channelId: number): Promise<SentFrame> {
  return waitForSent(page, type, (f) => f.payload?.channel_id === channelId);
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

async function boot(page: Page, { chime = false } = {}): Promise<void> {
  if (chime) await installChimeProbe(page);
  await mockSession(page);
  await page.goto("/");
  await navigateToMainPage(page);
  await waitForWsReady(page);
  // The banner is mounted on the page root at MainPage mount, and the
  // call_incoming/call_declined subscriptions are registered right after — an
  // attached banner is proof the ring handlers exist before we emit.
  await expect(page.locator("[data-testid='incoming-call-banner']")).toBeAttached();
}

async function openDm(page: Page, index = 0): Promise<void> {
  await page.locator("[data-testid='dm-entry']").nth(index).click();
  await expect(page.locator("[data-testid='call-btn']")).toBeVisible({ timeout: 5_000 });
}

/**
 * A stop is only provable across an interval: sample a full chime period (the
 * repeat is 2000ms) and require silence. The wait is the observation window,
 * not a substitute for a condition — callers first prove the chime was running.
 */
async function expectChimeSilent(page: Page): Promise<void> {
  const stopped = await chimeCount(page);
  await page.waitForTimeout(2_500);
  expect(await chimeCount(page)).toBe(stopped);
}

async function expectRingingWithChime(page: Page): Promise<void> {
  await expect(banner(page)).toBeVisible();
  await expect.poll(() => chimeCount(page), { timeout: 3_000 }).toBeGreaterThan(0);
}

const banner = (page: Page) => page.locator("[data-testid='incoming-call-banner']");
const voiceWidget = (page: Page) => page.locator("[data-testid='voice-widget'].visible");

function incoming(fromUserId = OTHER_USER_ID, username = "otheruser", channelId = DM_CHANNEL_ID) {
  return {
    type: "call_incoming",
    payload: { channel_id: channelId, from_user: fromUserId, username },
  };
}

// ---------------------------------------------------------------------------
// Incoming-call banner
// ---------------------------------------------------------------------------

test.describe("DM calls — incoming banner", () => {
  test("a ring shows the caller's name, Accept/Decline and starts the chime", async ({ page }) => {
    await boot(page, { chime: true });

    // Nothing is ringing yet.
    await expect(banner(page)).toBeHidden();
    expect(await chimeCount(page)).toBe(0);

    await emitWsMessage(page, incoming());

    // Rendered alert with the resolved nickname, not the wire username.
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toHaveAttribute("role", "alert");
    await expect(page.locator("[data-testid='incoming-call-title']")).toHaveText("Otto is calling");
    await expect(banner(page).locator(".incoming-call-subtitle")).toHaveText("Incoming call");
    await expect(page.locator("[data-testid='incoming-call-accept']")).toBeVisible();
    await expect(page.locator("[data-testid='incoming-call-decline']")).toBeVisible();

    // The ring is audible: the app's chime started.
    await expect.poll(() => chimeCount(page), { timeout: 3_000 }).toBeGreaterThan(0);
  });

  test("falls back to the wire username when the caller is not in the members store", async ({
    page,
  }) => {
    await boot(page);

    await emitWsMessage(page, incoming(999, "stranger"));

    await expect(page.locator("[data-testid='incoming-call-title']")).toHaveText(
      "stranger is calling",
    );
  });

  test("Accept joins the DM's voice channel, labels the call, clears the banner, and silences the chime", async ({
    page,
  }) => {
    await boot(page, { chime: true });
    await emitWsMessage(page, incoming());
    await expectRingingWithChime(page);

    await page.locator("[data-testid='incoming-call-accept']").click();

    // The ring is consumed and the caller is pulled into the DM's voice room.
    await expect(banner(page)).toBeHidden();
    await sentTo(page, "voice_join", DM_CHANNEL_ID);
    expect(
      (await sentFrames(page)).some((f) => f.type === "call_decline"),
      "accepting must not also decline",
    ).toBe(false);

    // Call state: the widget names the DM, not "Voice Channel".
    await expect(voiceWidget(page)).toBeVisible({ timeout: 5_000 });
    await expect(voiceWidget(page).locator(".vw-channel")).toHaveText("otheruser");

    await expectChimeSilent(page);
  });

  test("Decline answers call_decline with the DM's channel, silences the chime, and does not join voice", async ({
    page,
  }) => {
    await boot(page, { chime: true });
    await emitWsMessage(page, incoming());
    await expectRingingWithChime(page);

    await page.locator("[data-testid='incoming-call-decline']").click();

    await expect(banner(page)).toBeHidden();
    const decline = await sentTo(page, "call_decline", DM_CHANNEL_ID);
    expect(decline.payload).toEqual({ channel_id: DM_CHANNEL_ID });
    expect(
      (await sentFrames(page)).some((f) => f.type === "voice_join"),
      "declining must not join voice",
    ).toBe(false);
    await expect(voiceWidget(page)).toBeHidden();
    await expectChimeSilent(page);
  });
});

// ---------------------------------------------------------------------------
// Ring cancellation — the ringer hanging up, and other callees
// ---------------------------------------------------------------------------

test.describe("DM calls — ring cancellation", () => {
  test("only the ringer's own call_declined cancels the ring and chime, not a fellow callee's", async ({
    page,
  }) => {
    await boot(page, { chime: true });
    await emitWsMessage(page, incoming());
    await expectRingingWithChime(page);

    // A different participant of the same (group) ring declines. The server
    // addresses call_declined to every other participant, so this client sees
    // it too — but Bob declining is not Alice hanging up.
    await emitWsMessage(page, {
      type: "call_declined",
      payload: { channel_id: DM_CHANNEL_ID, from_user: 3, username: "thirduser" },
    });
    await expect(banner(page)).toBeVisible();

    // The ringer's own signal silences it.
    await emitWsMessage(page, {
      type: "call_declined",
      payload: { channel_id: DM_CHANNEL_ID, from_user: OTHER_USER_ID, username: "otheruser" },
    });
    await expect(banner(page)).toBeHidden();
    await expectChimeSilent(page);
  });

  test("the ringer leaving the DM's voice channel stops the ring and chime", async ({ page }) => {
    await boot(page, { chime: true });
    await emitWsMessage(page, incoming());
    await expectRingingWithChime(page);

    // The ringer's voice_leave is the only "the call is over" signal there is,
    // because a call is presence, not a server-side record.
    await emitWsMessage(page, {
      type: "voice_leave",
      payload: { channel_id: DM_CHANNEL_ID, user_id: OTHER_USER_ID },
    });
    await expect(banner(page)).toBeHidden();
    await expectChimeSilent(page);
  });

  test("a voice_leave for a different channel from the ringer leaves the ring up", async ({
    page,
  }) => {
    await boot(page);
    await emitWsMessage(page, incoming());
    await expect(banner(page)).toBeVisible();

    // Same user, unrelated channel: must not silence this DM's ring.
    await emitWsMessage(page, {
      type: "voice_leave",
      payload: { channel_id: 99, user_id: OTHER_USER_ID },
    });
    await expect(banner(page)).toBeVisible();

    // A leave for the ring's own channel still cancels it.
    await emitWsMessage(page, {
      type: "voice_leave",
      payload: { channel_id: DM_CHANNEL_ID, user_id: OTHER_USER_ID },
    });
    await expect(banner(page)).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Start-call button + call state
// ---------------------------------------------------------------------------

test.describe("DM calls — starting a call", () => {
  test("the call button is hidden outside a DM and starts a call inside one", async ({ page }) => {
    await boot(page);

    // The default channel is not a DM: no call affordance.
    await expect(page.locator("[data-testid='call-btn']")).toBeHidden();

    await openDm(page);
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("otheruser");

    await page.locator("[data-testid='call-btn']").click();

    // Joining first, then ringing — the caller must actually be in the room.
    const join = await sentTo(page, "voice_join", DM_CHANNEL_ID);
    const ring = await sentTo(page, "call_ring", DM_CHANNEL_ID);
    expect(ring.payload).toEqual({ channel_id: DM_CHANNEL_ID });
    const frames = await sentFrames(page);
    expect(
      frames.findIndex((f) => f.type === join.type && f.payload?.channel_id === DM_CHANNEL_ID),
    ).toBeLessThan(
      frames.findIndex((f) => f.type === ring.type && f.payload?.channel_id === DM_CHANNEL_ID),
    );
    await expect(page.locator("[data-testid='toast']", { hasText: "Calling" })).toBeVisible();

    // Call state: the DM call is live in the voice widget.
    await expect(voiceWidget(page)).toBeVisible({ timeout: 5_000 });
    await expect(voiceWidget(page).locator(".vw-channel")).toHaveText("otheruser");

    // Leaving the DM for a text channel takes the call affordance away again.
    await page.locator("[data-testid='dm-back-header']").click();
    await page.locator(".channel-item", { hasText: "general" }).first().click();
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("general");
    await expect(page.locator("[data-testid='call-btn']")).toBeHidden();
  });

  test("a ring for a DM you are not viewing still raises the banner", async ({ page }) => {
    await boot(page);

    // Sit in one DM and ring the other: the banner is mounted on the page root
    // so a call stays answerable from wherever the user is looking.
    await openDm(page, 1);
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("thirduser");

    await emitWsMessage(page, incoming());

    await expect(banner(page)).toBeVisible();
    await expect(page.locator("[data-testid='incoming-call-title']")).toHaveText("Otto is calling");
  });
});
