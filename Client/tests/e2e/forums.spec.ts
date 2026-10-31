import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  MOCK_PINNED_MESSAGES,
  MOCK_ROLES,
  buildTauriMockScript,
  emitWsMessage,
  navigateToMainPage,
  ROUTE_HEALTH,
  ROUTE_LOGIN,
  ROUTE_MESSAGES_EMPTY,
} from "./helpers";

// A forum channel in the mocked app (WP 6.9d): the post list with its tag
// filter and guidelines, the New Post dialog, a post opening in the thread
// panel, and "Older posts". With FORUM_SHOTS_DIR set, each state is also
// written there as a PNG for the PR (npx playwright test forums.spec.ts).

const FORUM = 9;
const EMPTY_FORUM = 10;
const TAGS = [
  { id: 1, name: "Bug", emoji: "🐛", position: 0 },
  { id: 2, name: "Idea", emoji: "💡", position: 1 },
  { id: 3, name: "Question", position: 2 },
];
const TOPIC = "Be kind and search before you post.\nOne topic per post, please.";

const CHANNELS = [
  { id: 1, name: "general", type: "text", position: 0, category: "Text" },
  {
    id: FORUM,
    name: "feedback",
    type: "forum",
    position: 1,
    category: "Text",
    topic: TOPIC,
    can_send: true,
    forum: { tags: TAGS, require_tag: true, default_auto_archive_minutes: 4320 },
  },
  {
    id: EMPTY_FORUM,
    name: "ideas",
    type: "forum",
    position: 2,
    category: "Text",
    topic: "",
    can_send: true,
    forum: { tags: [], require_tag: false, default_auto_archive_minutes: 4320 },
  },
];

function post(id: number, name: string, tags: number[], over: Record<string, unknown> = {}) {
  return {
    id,
    parent_id: FORUM,
    name,
    owner_id: id % 2 === 0 ? 2 : 1,
    starter_message_id: null,
    archived: false,
    locked: false,
    auto_archive_minutes: 4320,
    message_count: 4,
    last_message_at: new Date(Date.now() - id * 3_600_000).toISOString(),
    created_at: "2026-10-20T08:00:00Z",
    post: {
      tag_ids: tags,
      first_message: {
        id: id * 10,
        author_id: id % 2 === 0 ? 2 : 1,
        preview: `The first lines of "${name}" appear here so the list can be skimmed.`,
        has_attachments: false,
        deleted: false,
      },
    },
    ...over,
  };
}

const POSTS = [
  post(1, "Dark mode for the desktop app", [2]),
  post(2, "Voice drops out after a network change", [1], { message_count: 9 }),
  post(3, "How do I move my account to a new server?", [3], { message_count: 2 }),
  post(4, "Attachment previews are blurry", [1, 2], { message_count: 1 }),
];
const OLD = post(8, "Roadmap discussion (archived)", [2], { archived: true });
const DELETED_OPENING = post(7, "Question about roles", [3], {
  post: { tag_ids: [3], first_message: null },
});

const page_ = (threads: unknown[]) => ({ threads, has_more: false, next_before: "" });
const LIST = "/channels/9/threads?archived=0&sort=activity&limit=25";

const ROUTES = [
  ROUTE_HEALTH,
  ROUTE_LOGIN,
  { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
  {
    pattern: "/channels/95/messages",
    status: 200,
    body: {
      messages: [
        {
          id: 950,
          channel_id: 95,
          user: { id: 1, username: "testuser", avatar: "" },
          content: "Please add a dark theme for the desktop app.",
          timestamp: "2026-10-21T10:00:00Z",
          edited_at: null,
          attachments: [],
          reactions: [],
          reply_to: null,
          pinned: false,
          deleted: false,
        },
      ],
      has_more: false,
    },
  },
  ROUTE_MESSAGES_EMPTY,
  { pattern: LIST, status: 200, body: page_([...POSTS, DELETED_OPENING]) },
  { pattern: `${LIST}&tag=1`, status: 200, body: page_([POSTS[1], POSTS[3]]) },
  { pattern: "/channels/9/threads?archived=1", status: 200, body: page_([OLD]) },
  { pattern: "/channels/10/threads", status: 200, body: page_([]) },
  {
    pattern: "/api/v1/moderation/channels/9/forum",
    method: "PUT",
    status: 200,
    body: { id: 9, name: "feedback", type: "forum" },
  },
];

// The server's answer to forum_post_create: the post, with the envelope id.
const POST_CREATE_HANDLER = `
  var p = parsed.payload;
  var thread = {
    id: 95, parent_id: p.channel_id, name: p.name, owner_id: 1, starter_message_id: null,
    archived: false, locked: false, auto_archive_minutes: 4320, message_count: 1,
    last_message_at: new Date().toISOString(), created_at: new Date().toISOString(),
    post: { tag_ids: p.tag_ids, first_message: { id: 950, author_id: 1, preview: p.content,
      has_attachments: false, deleted: false } }
  };
  window.__forumPostFrames = (window.__forumPostFrames || []).concat([p]);
  setTimeout(function() {
    __tauriEmitEvent("ws-message", JSON.stringify({
      type: "forum_post_create_ok", id: parsed.id,
      payload: { thread: thread, message_id: 950, client_message_id: p.client_message_id, deduplicated: false }
    }));
  }, 50);
`;

async function setup(page: Page, theme: "dark" | "light" = "dark"): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem("owncord:theme:active", t), theme);
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: ROUTES,
      simulateWsFlow: true,
      readyOverrides: { channels: CHANNELS, roles: MOCK_ROLES, capabilities: { forums: true } },
      wsHandlers: [{ type: "forum_post_create", handler: POST_CREATE_HANDLER }],
    }),
  );
  await page.addInitScript(() => {
    // Record the forum settings PUT so a test can read what the editor sent.
    const w = window as unknown as {
      __forumPuts: string[];
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
    };
    w.__forumPuts = [];
    const timer = setInterval(() => {
      const internals = w.__TAURI_INTERNALS__;
      if (internals === undefined) return;
      clearInterval(timer);
      const orig = internals.invoke;
      internals.invoke = async (cmd, args) => {
        const cfg = (args as { clientConfig?: { method?: string; url?: string; data?: number[] } })
          ?.clientConfig;
        if (cmd === "plugin:http|fetch" && cfg?.method === "PUT" && Array.isArray(cfg.data)) {
          w.__forumPuts.push(new TextDecoder().decode(new Uint8Array(cfg.data)));
        }
        return orig(cmd, args);
      };
    }, 0);
  });
  await page.goto("/");
  await navigateToMainPage(page);
}

async function shot(page: Page, theme: string, name: string): Promise<void> {
  const dir = process.env["FORUM_SHOTS_DIR"];
  if (dir === undefined) return;
  await page.screenshot({ path: `${dir}/${name}-${theme}.png` });
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`Forum channel (${theme})`, () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("lists posts with tags, the guidelines banner and Older posts", async ({ page }) => {
      await setup(page, theme);
      await expect(page.locator("[data-testid='channel-9'] .ch-icon svg")).toBeVisible();
      await page.locator("[data-testid='channel-9']").click();

      await expect(page.getByTestId("forum-view")).toBeVisible();
      await expect(page.getByTestId("forum-guidelines-body")).toContainText("Be kind");
      await expect(page.locator("button.forum-post")).toHaveCount(6);
      await expect(page.getByTestId("forum-post-2")).toContainText("🐛 Bug");
      await expect(page.getByTestId("forum-post-2")).toContainText("8 replies");
      await expect(page.getByTestId("forum-post-7")).toContainText("opening message was deleted");
      // No composer and no message list in a forum.
      await expect(page.locator(".messages-container")).toHaveCount(0);
      await expect(page.locator(".message-input-box")).toHaveCount(0);
      await expect(page.getByTestId("forum-older-head")).toBeVisible();
      await expect(page.getByTestId("forum-post-8")).toContainText("Roadmap discussion");
      await shot(page, theme, "01-forum-list-tags-banner");
      await page.getByTestId("forum-older-head").scrollIntoViewIfNeeded();
      await shot(page, theme, "05-older-posts");
    });

    test("switches between the four post layouts, remembers the pick, and the member list steps aside", async ({
      page,
    }) => {
      await setup(page, theme);
      await page.locator("[data-testid='channel-9']").click();
      await expect(page.getByTestId("forum-post-1")).toBeVisible();
      await expect(page.getByTestId("member-column")).toBeHidden();
      await expect(page.getByTestId("forum-view")).toHaveClass(/forum-view--grid/);
      await expect(page.getByTestId("forum-layout-grid")).toHaveAttribute("aria-pressed", "true");
      await shot(page, theme, "10-layout-grid");

      for (const layout of ["list", "feed"] as const) {
        await page.getByTestId(`forum-layout-${layout}`).click();
        await expect(page.getByTestId("forum-view")).toHaveClass(
          new RegExp(`forum-view--${layout}`),
        );
        await shot(page, theme, `11-layout-${layout}`);
      }

      await page.getByTestId("forum-layout-split").click();
      await page.getByTestId("forum-post-2").click();
      await expect(page.getByTestId("thread-panel")).toBeVisible();
      await expect(page.getByTestId("forum-post-2")).toHaveAttribute("aria-current", "true");
      // The reader takes the rest of the row: wider than the list beside it.
      const panel = await page.getByTestId("thread-panel").boundingBox();
      const list = await page.getByTestId("forum-view").boundingBox();
      expect((panel?.width ?? 0) > (list?.width ?? 0)).toBe(true);
      await shot(page, theme, "12-layout-split-open");

      await page.reload();
      await navigateToMainPage(page);
      await page.locator("[data-testid='channel-9']").click();
      await expect(page.getByTestId("forum-view")).toHaveClass(/forum-view--split/);
    });

    test("a post opens in a panel the user can widen", async ({ page }) => {
      await setup(page, theme);
      await page.locator("[data-testid='channel-9']").click();
      await page.getByTestId("forum-layout-list").click();
      await page.getByTestId("forum-post-1").click();
      const panel = page.getByTestId("thread-panel");
      await expect(panel).toBeVisible();
      const before = (await panel.boundingBox())?.width ?? 0;
      const handle = page.getByTestId("thread-panel-resize");
      const box = await handle.boundingBox();
      if (box === null) throw new Error("no handle");
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x - 150, box.y + 200, { steps: 5 });
      await page.mouse.up();
      await expect
        .poll(async () => (await panel.boundingBox())?.width ?? 0)
        .toBeGreaterThan(before + 100);
      await shot(page, theme, "13-post-panel-widened");
    });

    test("filters by tag with a repeatable tag parameter", async ({ page }) => {
      await setup(page, theme);
      await page.locator("[data-testid='channel-9']").click();
      await expect(page.getByTestId("forum-post-1")).toBeVisible();
      await page.getByTestId("forum-tag-1").click();
      await expect(page.getByTestId("forum-tag-1")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("forum-post-2")).toBeVisible();
      await expect(page.getByTestId("forum-post-4")).toBeVisible();
      await expect(page.getByTestId("forum-post-1")).toHaveCount(0);
      await shot(page, theme, "03-tag-filter");
    });

    test("shows the empty state for a forum with no posts", async ({ page }) => {
      await setup(page, theme);
      await page.locator("[data-testid='channel-10']").click();
      await expect(page.locator(".forum-empty-title")).toHaveText("No posts yet");
      await shot(page, theme, "02-empty-forum");
    });

    test("New Post asks for a tag, posts once and opens the post in the panel", async ({
      page,
    }) => {
      await setup(page, theme);
      await page.locator("[data-testid='channel-9']").click();
      await page.getByTestId("forum-new-post").click();
      await expect(page.getByTestId("forum-post-dialog")).toBeVisible();
      await expect(page.getByTestId("forum-post-tags-hint")).toHaveText(
        "Required: pick at least one",
      );
      await page.getByTestId("forum-post-title").fill("Dark mode for the desktop app");
      await page
        .getByTestId("forum-post-message")
        .fill("Please add a dark theme for the desktop app.");
      await page.getByTestId("forum-post-submit").click();
      await expect(page.getByTestId("forum-post-error")).toHaveText("Pick at least one tag");
      await page.getByTestId("forum-post-tag-2").click();
      await shot(page, theme, "04-new-post-dialog");
      await page.getByTestId("forum-post-submit").click();

      await expect(page.getByTestId("forum-post-dialog")).toHaveCount(0);
      const panel = page.getByTestId("thread-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("Dark mode for the desktop app");
      await expect(page.getByTestId("thread-panel-tags")).toContainText("💡 Idea");
      await expect(page.getByTestId("thread-starter")).toBeHidden();
      await expect(panel).toContainText("Please add a dark theme");
      const frames = await page.evaluate(
        () =>
          (window as unknown as { __forumPostFrames: { tag_ids: number[] }[] }).__forumPostFrames,
      );
      expect(frames).toHaveLength(1);
      expect(frames[0]!.tag_ids).toEqual([2]);
    });

    test("opens a post in the panel and Close returns focus to its row", async ({ page }) => {
      await setup(page, theme);
      await page.locator("[data-testid='channel-9']").click();
      await expect(page.getByTestId("forum-post-1")).toBeVisible();
      await emitWsMessage(page, {
        type: "thread_changed",
        payload: { thread: post(95, "Dark mode for the desktop app", [2]) },
      });
      const row = page.getByTestId("forum-post-95");
      await expect(row).toBeVisible();
      await row.click();
      const panel = page.getByTestId("thread-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("Please add a dark theme");
      await shot(page, theme, "06-post-in-panel");
      await page.getByTestId("thread-close").click();
      await expect(panel).toHaveCount(0);
      await expect(row).toBeFocused();
    });

    test("a reply moves its post to the top of the list", async ({ page }) => {
      await setup(page, theme);
      await page.locator("[data-testid='channel-9']").click();
      await expect(page.getByTestId("forum-post-1")).toBeVisible();
      await emitWsMessage(page, {
        type: "thread_changed",
        payload: {
          thread: post(3, "How do I move my account to a new server?", [3], {
            last_message_at: new Date().toISOString(),
            message_count: 3,
          }),
        },
      });
      await expect(page.locator(".forum-post-item").first()).toContainText(
        "How do I move my account",
      );
      await expect(page.getByTestId("forum-post-3")).toContainText("2 replies");
    });

    test("edits a forum's tags and settings from Edit Channel", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await setup(page, theme);
      await page.locator("[data-testid='channel-9']").click({ button: "right" });
      await page.locator("[data-testid='ctx-edit-channel']").click();
      const section = page.getByTestId("forum-settings");
      await expect(section).toBeVisible();
      await expect(page.getByTestId("forum-settings-tag-name-1")).toHaveValue("Idea");
      await expect(page.getByTestId("forum-settings-require-tag")).toBeChecked();

      await page.getByTestId("forum-settings-tag-name-1").fill("Suggestion");
      await page.getByTestId("forum-settings-tag-down-0").click();
      await page.getByTestId("forum-settings-add").click();
      await page.getByTestId("forum-settings-tag-name-3").fill("Docs");
      await page.getByTestId("forum-settings-tag-emoji-3").fill("📖");
      await page.getByTestId("forum-settings-archive").selectOption("10080");
      await section.scrollIntoViewIfNeeded();
      await shot(page, theme, "07-forum-settings");

      await page.getByTestId("forum-settings-save").click();
      await expect(page.getByTestId("forum-settings-note")).toHaveText("Forum settings saved");
      const puts = await page.evaluate(
        () => (window as unknown as { __forumPuts: string[] }).__forumPuts,
      );
      expect(puts).toHaveLength(1);
      // Ids kept through the rename and the move; the new tag has none.
      expect(JSON.parse(puts[0]!)).toEqual({
        tags: [
          { id: 2, name: "Suggestion", emoji: "💡" },
          { id: 1, name: "Bug", emoji: "🐛" },
          { id: 3, name: "Question" },
          { name: "Docs", emoji: "📖" },
        ],
        require_tag: true,
        default_auto_archive_minutes: 10080,
      });
    });

    test("shows a tag name the editor refuses", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await setup(page, theme);
      await page.locator("[data-testid='channel-9']").click({ button: "right" });
      await page.locator("[data-testid='ctx-edit-channel']").click();
      await page.getByTestId("forum-settings-tag-name-1").fill("bug");
      await page.getByTestId("forum-settings-save").click();
      await expect(page.getByTestId("forum-settings-error")).toHaveText(
        "Tag names must be different",
      );
      await shot(page, theme, "08-forum-settings-error");
    });
  });
}
