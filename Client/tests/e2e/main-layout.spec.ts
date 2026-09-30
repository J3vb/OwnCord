import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  mockTauriFullSession,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  navigateToMainPage,
  submitLogin,
  waitForWsReady,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Main Page Layout
// ---------------------------------------------------------------------------

test.describe("Main Page Layout", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("app layout has all major sections", async ({ page }) => {
    // Unified sidebar (replaces old server strip)
    await expect(page.locator("[data-testid='unified-sidebar']")).toBeVisible();

    // Channel sidebar
    await expect(page.locator("[data-testid='channel-sidebar']")).toBeVisible();

    // Chat area
    await expect(page.locator("[data-testid='chat-area']")).toBeVisible();

    // Chat header with channel name "general"
    const chatHeader = page.locator("[data-testid='chat-header']");
    await expect(chatHeader).toBeVisible();
    const headerName = page.locator("[data-testid='chat-header-name']");
    await expect(headerName).toHaveText("general");

    // Messages container
    await expect(page.locator(".messages-container")).toBeVisible();

    // User bar
    await expect(page.locator("[data-testid='user-bar']")).toBeVisible();
  });

  test("input slot is attached to DOM", async ({ page }) => {
    const inputSlot = page.locator("[data-testid='input-slot']");
    await expect(inputSlot).toBeAttached();
  });

  test("typing slot is attached to DOM", async ({ page }) => {
    const typingSlot = page.locator("[data-testid='typing-slot']");
    await expect(typingSlot).toBeAttached();
  });

  test("messages slot contains virtual scroll structure", async ({ page }) => {
    const messagesSlot = page.locator("[data-testid='messages-slot']");
    await expect(messagesSlot).toBeVisible();

    // Messages slot should contain the messages-container for virtual scrolling
    const container = messagesSlot.locator(".messages-container");
    await expect(container).toBeVisible();
  });

  test("member list is visible with role groups", async ({ page }) => {
    const memberList = page.locator("[data-testid='member-list']");
    await expect(memberList).toBeVisible();

    // Should have at least one role group
    const roleGroups = memberList.locator(".member-role-group");
    expect(await roleGroups.count()).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// P1-01: channel list priority over a long member list on a fresh profile
// ---------------------------------------------------------------------------
//
// On a first login to a server with many members, every channel row — text and
// voice — must be visible without scrolling or collapsing Members, at 940x600
// and above. The channel slot sizes to its rows, so the member section takes
// the rest and scrolls inside itself (DP-08).

/** 40+ members and 4 channels across two categories, with the header actions
 *  the owner's role renders (Invite + Audit Log), the fresh-profile shape. */
const FRESH_PROFILE_CHANNELS = [
  { id: 1, name: "general", type: "text" as const, position: 0, category: "Text Channels" },
  { id: 2, name: "random", type: "text" as const, position: 1, category: "Text Channels" },
  { id: 3, name: "announcements", type: "text" as const, position: 2, category: "Info" },
  { id: 10, name: "Voice Chat", type: "voice" as const, position: 3, category: "Voice" },
];
const FRESH_PROFILE_MEMBERS = Array.from({ length: 45 }, (_, i) => ({
  id: i + 1,
  username: `member-${i}`,
  avatar: "",
  status: i % 3 === 0 ? ("offline" as const) : ("online" as const),
  role: i === 0 ? "admin" : "member",
}));

/** More channel rows than the sidebar column can show. */
const LONG_CHANNEL_LIST = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  name: `channel-${i}`,
  type: "text" as const,
  position: i,
  category: "Text Channels",
}));

async function signInFreshProfile(
  page: import("@playwright/test").Page,
  stored?: Record<string, string>,
  channels: Array<(typeof FRESH_PROFILE_CHANNELS)[number]> = FRESH_PROFILE_CHANNELS,
): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: { messages: [], has_more: false } },
      ],
      simulateWsFlow: true,
      readyOverrides: { channels, members: FRESH_PROFILE_MEMBERS },
    }),
  );
  if (stored !== undefined) {
    await page.addInitScript((entries) => {
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    }, stored);
  }
  await page.goto("/");
  await submitLogin(page);
  await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
  await waitForWsReady(page);
}

/**
 * Every `.channel-item` inside the channel slot's visible box. The slot is the
 * element the member section sits below; a row outside it is clipped under the
 * member list or scrolled out of the list's own viewport.
 */
async function channelRowsOutsideSlot(
  page: import("@playwright/test").Page,
): Promise<{ total: number; outside: number }> {
  return page.locator(".sidebar-content-inner").evaluate((el) => {
    const box = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll<HTMLElement>(".channel-item")];
    const outside = rows.filter((row) => {
      const r = row.getBoundingClientRect();
      return r.top < box.top - 1 || r.bottom > box.bottom + 1;
    });
    return { total: rows.length, outside: outside.length };
  });
}

test.describe("P1-01 channel list priority over a long member list", () => {
  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
    { width: 940, height: 600 },
  ]) {
    test(`every channel row is visible on a fresh profile at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await signInFreshProfile(page);

      const inside = await channelRowsOutsideSlot(page);
      expect(inside.total).toBeGreaterThanOrEqual(4);
      expect(inside.outside).toBe(0);

      // The member section sits below the channel slot: the channel list takes
      // the space its rows need, and the members get the rest.
      const channelBox = (await page.locator(".sidebar-content-inner").boundingBox())!;
      const memberBox = (await page.locator("[data-testid='sidebar-members']").boundingBox())!;
      expect(memberBox.y).toBeGreaterThanOrEqual(channelBox.y + channelBox.height - 1);
    });
  }

  test("the member list scrolls inside its section on a fresh profile", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInFreshProfile(page);

    const content = page.locator(".sidebar-members-content");
    const scrolls = await content.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(scrolls).toBe(true);
  });

  test("members keep about three rows when the channel list overflows (P1-01)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInFreshProfile(page, undefined, LONG_CHANNEL_LIST);

    // The members show at least three whole rows, and the channel list
    // scrolls inside its slot instead of pushing them out.
    const visibleMembers = await page.locator(".sidebar-members-content").evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll(".member-item")].filter((row) => {
        const r = row.getBoundingClientRect();
        return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
      }).length;
    });
    expect(visibleMembers).toBeGreaterThanOrEqual(3);
    const channelsScroll = await page
      .locator(".sidebar-content-inner .channel-list")
      .evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(channelsScroll).toBe(true);
  });

  test("a saved height holds when the channel list overflows (P1-01)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInFreshProfile(page, { "owncord:member-list-height": "200" }, LONG_CHANNEL_LIST);

    const memberBox = (await page.locator("[data-testid='sidebar-members']").boundingBox())!;
    expect(Math.abs(memberBox.height - 200)).toBeLessThanOrEqual(1);
  });

  test("a saved height and a collapsed state still restore (P1-01)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    // A saved height restores as a definite (`.sized`) height, not a flex
    // share, so the channel list above keeps its rows.
    await signInFreshProfile(page, { "owncord:member-list-height": "200" });
    const restored = await page.locator("[data-testid='sidebar-members']").evaluate((el) => ({
      inlineHeight: el.style.height,
      sized: el.classList.contains("sized"),
    }));
    expect(restored.inlineHeight).toBe("200px");
    expect(restored.sized).toBe(true);
    expect((await channelRowsOutsideSlot(page)).outside).toBe(0);

    // Collapsing sets the section to auto and hides the rows; the channel rows
    // stay visible.
    await page.locator(".sidebar-members-header").click();
    const collapsed = await page.locator("[data-testid='sidebar-members']").evaluate((el) => ({
      inlineHeight: el.style.height,
      contentDisplay: (el.querySelector(".sidebar-members-content") as HTMLElement).style.display,
    }));
    expect(collapsed.inlineHeight).toBe("auto");
    expect(collapsed.contentDisplay).toBe("none");
    expect((await channelRowsOutsideSlot(page)).outside).toBe(0);
  });

  test("a dragged height saves and sizes the section (P1-01)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInFreshProfile(page);

    await page.locator(".sidebar-resize-handle").evaluate((el) => {
      el.dispatchEvent(new MouseEvent("mousedown", { clientY: 400, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 380, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    const saved = await page.evaluate(() => localStorage.getItem("owncord:member-list-height"));
    expect(saved).not.toBeNull();
    const dragged = await page.locator("[data-testid='sidebar-members']").evaluate((el) => ({
      inlineHeight: el.style.height,
      sized: el.classList.contains("sized"),
    }));
    expect(dragged.inlineHeight).toBe(`${saved}px`);
    expect(dragged.sized).toBe(true);
  });

  test("the channel list stays reachable at 940x500 with 20px text (B9 Q1, #1780)", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("owncord:settings:fontSize", "20");
      localStorage.setItem("owncord:settings:largeFont", "true");
    });
    await page.setViewportSize({ width: 940, height: 500 });
    await signInFreshProfile(page);

    // The first channel row — the way into the list — is inside the slot's own
    // box and inside the viewport, however tall the members section is.
    const inside = await channelRowsOutsideSlot(page);
    expect(inside.total).toBeGreaterThanOrEqual(1);
    const first = page.locator(".channel-item").first();
    await expect(first).toBeInViewport();
    const firstBox = (await first.boundingBox())!;
    const slotBox = (await page.locator(".sidebar-content-inner").boundingBox())!;
    expect(firstBox.y).toBeGreaterThanOrEqual(slotBox.y - 1);
    expect(firstBox.y + firstBox.height).toBeLessThanOrEqual(slotBox.y + slotBox.height + 1);
  });
});
