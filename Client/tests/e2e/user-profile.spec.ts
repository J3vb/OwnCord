/**
 * Mocked E2E: user profile surfaces (audit batch N11, gap #14).
 *
 *   - The member profile popup (`components/UserProfilePopup.ts`, opened by
 *     clicking a row in the member list) — identity (nickname heading +
 *     @handle), role badge, status, the Message action that starts a DM, and
 *     the close paths (Escape / outside click).
 *   - The DM profile sidebar (`components/DmProfileSidebar.ts`, opened by
 *     clicking the DM chat header) — identity/status, the local-only Note
 *     (persisted per user), live status while open, and its close paths.
 *
 * Assertions are on the rendered UI or on the outgoing IPC traffic the app
 * actually issued (`window.__invokeLog`, populated by the Tauri mock), so a
 * stubbed handler or a broken render turns the test red.
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
} from "./helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SELF_ID = 1;
const OTHER_ID = 2;
const THIRD_ID = 3;
/** A member with no DM yet, so the popup's Message button has a fresh target. */
const NEW_ID = 4;

const OTHER_DM = 100;
const THIRD_DM = 101;
const NEW_DM = 200;

const READY_MEMBERS = [
  { id: SELF_ID, username: "testuser", avatar: "", status: "online", role: "admin" },
  // display_name exercises the popup's nickname heading + @handle (the DM
  // header renders through the same nickname, so the two must agree).
  {
    id: OTHER_ID,
    username: "otheruser",
    display_name: "Otto",
    avatar: "",
    status: "online",
    role: "member",
  },
  { id: THIRD_ID, username: "thirduser", avatar: "", status: "idle", role: "member" },
  { id: NEW_ID, username: "newuser", avatar: "", status: "online", role: "member" },
];

const DM_CHANNELS = [
  {
    channel_id: OTHER_DM,
    recipient: {
      id: OTHER_ID,
      username: "otheruser",
      display_name: "Otto",
      avatar: "",
      status: "online",
    },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 0,
  },
  {
    channel_id: THIRD_DM,
    recipient: { id: THIRD_ID, username: "thirduser", avatar: "", status: "idle" },
    last_message_id: 501,
    last_message: "See you later",
    last_message_at: "2026-03-15T11:00:00Z",
    unread_count: 0,
  },
];

const CREATE_DM_RESPONSE = {
  channel_id: NEW_DM,
  recipient: { id: NEW_ID, username: "newuser", avatar: "", status: "online" },
  created: true,
};

async function mockSession(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        { pattern: "/api/v1/dms", method: "GET", status: 200, body: DM_CHANNELS },
        { pattern: "/api/v1/dms", method: "POST", status: 200, body: CREATE_DM_RESPONSE },
      ],
      simulateWsFlow: true,
      readyOverrides: {
        members: READY_MEMBERS,
        dm_channels: DM_CHANNELS,
      },
    }),
  );
}

async function boot(page: Page): Promise<void> {
  await mockSession(page);
  await page.goto("/");
  await navigateToMainPage(page);
  await waitForWsReady(page);
}

const popup = (page: Page) => page.locator("[data-testid='user-profile-popup']");
const profileSidebar = (page: Page) => page.locator("[data-testid='dm-profile-sidebar']");

/** Open a DM from the channels-mode embedded DM list. */
async function openDm(page: Page, index = 0): Promise<void> {
  await page.locator("[data-testid='dm-entry']").nth(index).click();
  await expect(page.locator("[data-testid='call-btn']")).toBeVisible({ timeout: 5_000 });
}

/** Open the DM profile sidebar from the chat header. */
async function openDmProfile(page: Page): Promise<void> {
  await page.locator("[data-testid='ch-name-group']").click();
  await expect(profileSidebar(page)).toBeVisible({ timeout: 5_000 });
}

// ---------------------------------------------------------------------------
// Outgoing-traffic capture (the mock's own IPC log)
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly data: number[] | null;
}

interface InvokeEntry {
  readonly cmd: string;
  readonly args?: { readonly clientConfig?: FetchCall; readonly message?: string };
}

async function fetchCalls(page: Page): Promise<FetchCall[]> {
  const log = await page.evaluate(
    () => (window as unknown as { __invokeLog: InvokeEntry[] }).__invokeLog,
  );
  const calls: FetchCall[] = [];
  for (const entry of log) {
    if (entry.cmd === "plugin:http|fetch" && entry.args?.clientConfig !== undefined) {
      calls.push(entry.args.clientConfig);
    }
  }
  return calls;
}

function decodeBody(call: FetchCall): string | null {
  if (!Array.isArray(call.data)) return null;
  return new TextDecoder().decode(new Uint8Array(call.data));
}

/** Poll until a request matching `predicate` has gone out, and return it. */
async function waitForFetch(
  page: Page,
  predicate: (call: FetchCall) => boolean,
  timeout = 5_000,
): Promise<FetchCall> {
  let found: FetchCall | undefined;
  await expect(async () => {
    found = (await fetchCalls(page)).find(predicate);
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

// ---------------------------------------------------------------------------
// User profile popup (member list)
// ---------------------------------------------------------------------------

test.describe("User profile popup — member list", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test("opens on a member click with the nickname, @handle, role, status and Message action", async ({
    page,
  }) => {
    await page.locator("[data-testid='member-2']").click();

    await expect(popup(page)).toBeVisible();
    await expect(popup(page)).toHaveAttribute("role", "dialog");
    // The nickname is the heading; the username stays as the @handle you type.
    await expect(popup(page).locator(".upp-username")).toHaveText("Otto");
    await expect(popup(page).locator(".upp-username-handle")).toHaveText("@otheruser");
    await expect(popup(page).locator(".upp-role-badge")).toContainText("Member");
    await expect(popup(page).locator(".upp-status-line")).toContainText("Online");
    await expect(page.locator("[data-testid='upp-message-btn']")).toBeVisible();
  });

  test("Message starts a DM with that member and switches the chat to it", async ({ page }) => {
    await page.locator("[data-testid='member-4']").click();
    await expect(popup(page)).toBeVisible();

    await page.locator("[data-testid='upp-message-btn']").click();

    // The client asked the server for a DM with exactly this member...
    const create = await waitForFetch(
      page,
      (c) => c.method === "POST" && c.url.includes("/api/v1/dms"),
    );
    expect(JSON.parse(decodeBody(create) ?? "{}")).toEqual({ recipient_id: NEW_ID });

    // ...closed the popup, and switched the chat to the new conversation.
    await expect(popup(page)).toHaveCount(0);
    await expect(page.locator("[data-testid='dm-back-header']")).toBeVisible();
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("newuser");
  });

  test("the signed-in user's own row opens the popup without a Message action", async ({
    page,
  }) => {
    await page.locator("[data-testid='member-1']").click();

    await expect(popup(page)).toBeVisible();
    await expect(popup(page).locator(".upp-username")).toHaveText("testuser");
    await expect(page.locator("[data-testid='upp-message-btn']")).toHaveCount(0);
  });

  test("reflects a member's live status after a presence-only update", async ({ page }) => {
    // otheruser is online in the fixture; the presence flip is a presence-only
    // store change, so the row is patched in place. The popup must still read
    // the live store, not the row's render-time snapshot.
    await emitWsMessage(page, {
      type: "presence",
      payload: { user_id: OTHER_ID, status: "offline" },
    });

    await page.locator("[data-testid='member-2']").click();

    await expect(popup(page)).toBeVisible();
    await expect(popup(page).locator(".upp-status-line")).toContainText("Offline");
    await expect(popup(page).locator(".upp-status-dot")).toHaveAttribute("title", "Offline");
  });

  test("closes on Escape and on an outside click", async ({ page }) => {
    await page.locator("[data-testid='member-2']").click();
    await expect(popup(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);

    await page.locator("[data-testid='member-2']").click();
    await expect(popup(page)).toBeVisible();
    // A point on the full-screen overlay, clear of the anchored card.
    await page.mouse.click(5, 5);
    await expect(popup(page)).toHaveCount(0);
  });

  // BUG (OC new): the popup renders a "Call" action only when `onCall` is
  // passed, and no caller ever passes it — `MemberList.ts` wires `onMessage`
  // but not `onCall`. The component's own comment says Call was omitted "before
  // DM calls exist"; they exist now (the DM chat header's call button, covered
  // in dm-calls.spec.ts), so the profile popup's Call action is dead. Marked
  // fixme rather than asserting a control the product does not render.
  test.fixme("offers a Call action for another member", async ({ page }) => {
    await page.locator("[data-testid='member-4']").click();
    await expect(popup(page)).toBeVisible();
    await expect(page.locator("[data-testid='upp-call-btn']")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// DM profile sidebar + Note
// ---------------------------------------------------------------------------

test.describe("DM profile sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await openDm(page, 0);
  });

  test("the DM header opens a panel with the partner's nickname and status", async ({ page }) => {
    await openDmProfile(page);

    await expect(profileSidebar(page)).toHaveAttribute("role", "complementary");
    await expect(page.locator("[data-testid='dps-username']")).toHaveText("Otto");
    await expect(page.locator("[data-testid='dps-status']")).toContainText("Online");
    await expect(page.locator("[data-testid='dps-note']")).toBeVisible();
  });

  test("the Note is local-only and scoped per user", async ({ page }) => {
    await openDmProfile(page);

    const note = page.locator("[data-testid='dps-note']");
    await expect(note).toHaveAttribute("placeholder", "Click to add a note");
    await note.fill("Ping me about the deploy");

    // Close and reopen: the note is read back from local storage.
    await page.locator("[data-testid='dps-close']").click();
    await expect(profileSidebar(page)).toHaveCount(0);
    await openDmProfile(page);
    await expect(note).toHaveValue("Ping me about the deploy");

    // A different DM partner must not inherit that note.
    await page.locator("[data-testid='dps-close']").click();
    await page.locator("[data-testid='dm-back-header']").click();
    await openDm(page, 1);
    await openDmProfile(page);
    await expect(page.locator("[data-testid='dps-username']")).toHaveText("thirduser");
    await expect(note).toHaveValue("");
  });

  test("the partner's status stays live while the panel is open", async ({ page }) => {
    await openDmProfile(page);
    await expect(page.locator("[data-testid='dps-status']")).toContainText("Online");

    await emitWsMessage(page, { type: "presence", payload: { user_id: OTHER_ID, status: "idle" } });

    await expect(page.locator("[data-testid='dps-status']")).toContainText("Idle");
  });

  test("closes on the close button and on Escape", async ({ page }) => {
    await openDmProfile(page);
    await page.locator("[data-testid='dps-close']").click();
    await expect(profileSidebar(page)).toHaveCount(0);

    await openDmProfile(page);
    await page.keyboard.press("Escape");
    await expect(profileSidebar(page)).toHaveCount(0);
  });
});

test.describe("DM profile sidebar — non-DM", () => {
  test("clicking the header in a text channel opens nothing", async ({ page }) => {
    await boot(page);
    // The default channel is a text channel: there is no single profile to show.
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("general");

    await page.locator("[data-testid='ch-name-group']").click();

    await expect(profileSidebar(page)).toHaveCount(0);
  });
});
