/**
 * B9 OS 200 % zoom / reflow, automated (BPR-091; WCAG 1.4.4, 1.4.10).
 *
 * This replaces the owner's manual "OS 200 % zoom check" that 15 B9 lanes
 * (B9-3, 5, 6, 10, 11, 12, 13, 14, 17, 18, 19, 20, 21, 22, 23) carried, the
 * same way the manual screen-reader check was replaced by automated
 * accessibility evidence (owner decision 2026-09-24, BPR-091 amended).
 *
 * Every test runs at the effective 200 % zoom size from the start (640x400 CSS
 * px — see `support/b9-zoom.ts` for the model and why) and reaches its screen
 * through the entry point a zoomed user actually has. Each screen is audited:
 * no horizontal page scroll, no two-dimensional scroll area, no text or control
 * clipped without an intended scroll area, no control painted over, every
 * primary action reachable. One screenshot per screen is attached.
 *
 * The shell's global sidebar is collapsed to zero width below 800 CSS px by the
 * `@media (max-width: 800px)` rule (`src/styles/app/responsive.css`), with no
 * toggle. Channels stay reachable through the Ctrl+K quick switcher, but DMs,
 * the sidebar itself and every screen whose only entry point lives in it do
 * not. Designing responsive navigation is B8's workstream 6, so each of those
 * screens is `test.fixme`, naming its entry point, rather than rebuilt here.
 */
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  openSettings,
  submitLogin,
  waitForWsReady,
} from "./helpers";
import {
  ZOOM_VIEWPORT,
  auditReflow,
  expectScreenReflows,
  type ZoomScreen,
} from "./support/b9-zoom";

test.use({ viewport: ZOOM_VIEWPORT, deviceScaleFactor: 1 });

type Route = { pattern: string; status: number; body: unknown; method?: string };

const HEALTH: Route = {
  pattern: "/api/v1/health",
  status: 200,
  body: { status: "ok", version: "1.0.0" },
};
const LOGIN: Route = { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE };

const DM_CHANNELS = [
  {
    channel_id: 100,
    recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 1,
  },
];

const REQUESTS = [
  {
    id: 2,
    channel_id: 202,
    sender: { id: 12, username: "stranger", display_name: "A Stranger", avatar: "" },
    preview: {
      message_id: 902,
      content:
        "averyveryverylongunbrokenwordthatmustwrapinsteadofpushingthelayoutsidewaysaaaaaaaaaaaaaaaaaaaaaaaa",
      timestamp: "2026-09-05T12:00:00Z",
    },
    created_at: "2026-09-05T12:00:00Z",
  },
];

const REPORT_MESSAGES = {
  messages: [
    {
      id: 201,
      channel_id: 1,
      user: { id: 2, username: "otheruser", avatar: "" },
      content: "Synthetic message to report",
      timestamp: "2026-03-15T10:00:00Z",
      edited_at: null,
      attachments: [],
      reactions: [],
      reply_to: null,
      pinned: false,
      deleted: false,
    },
  ],
  has_more: false,
};

const MY_REPORTS = [
  {
    id: "a".repeat(32),
    target_type: "message",
    reason: "harassment",
    state: "open",
    outcome: "",
    created_at: "2026-09-05T10:00:00Z",
    closed_at: null,
  },
];

const MINE = "d".repeat(32);

const modRow = (id: string, state: string, assignee: number, reason: string, target = "user") => ({
  id,
  reporter_name: "synthetic-reporter",
  subject_name: "otheruser",
  target_type: target,
  target_ref: target === "message" ? "55" : "2",
  reason,
  state,
  assignee_id: assignee,
  outcome: "",
  created_at: "2026-09-05T10:00:00Z",
  updated_at: "2026-09-05T10:00:00Z",
});

const modDetail = (
  id: string,
  state: string,
  assignee: number,
  reason: string,
  target = "user",
) => ({
  ...modRow(id, state, assignee, reason, target),
  reporter_id: 3,
  subject_id: 2,
  detail: "Synthetic reporter detail long enough to wrap across the narrow zoomed window.",
  evidence: [],
  notes: [],
  events: [],
  actions: [
    {
      id: 12,
      kind: "timeout",
      actor_id: 1,
      reason: "Synthetic timeout reason shown to the member.",
      created_at: "2026-09-05T10:50:00Z",
      expires_at: "2999-01-01T00:00:00Z",
    },
  ],
});

const APPEALS_Q = "/api/v1/moderation/appeals";
const HELD = "a".repeat(32);
const appealRow = (id: string, over: object) => ({
  id,
  action_id: 12,
  appellant_id: 2,
  body: "",
  state: "assigned",
  assignee_id: 1,
  decided_by: 0,
  decision_note: "",
  created_at: "2026-09-06T10:00:00Z",
  decided_at: null,
  ...over,
});
const APPEALS = [appealRow(HELD, {})];
const APPEAL_DETAIL = {
  ...appealRow(HELD, {}),
  body: "Synthetic statement from the appellant.",
  action: {
    id: 12,
    kind: "timeout",
    actor_id: 2,
    reason: "Synthetic timeout reason shown to the member.",
    created_at: "2026-09-05T10:50:00Z",
    expires_at: "2999-01-01T00:00:00Z",
  },
  report_id: "r".repeat(32),
};

async function boot(page: Page, routes: Route[], dm = false): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [HEALTH, LOGIN, ...routes],
      simulateWsFlow: true,
      ...(dm ? { readyOverrides: { dm_channels: DM_CHANNELS } } : {}),
    }),
  );
  await page.goto("/");
  await submitLogin(page);
  await waitForWsReady(page);
}

/** Mark a screen whose only entry point sits in the collapsed sidebar. */
function blockedOnNavigation(entryPoint: string): void {
  test.fixme(
    true,
    `Blocked on responsive navigation (B8 workstream 6): the only entry point, ${entryPoint}, is inside .unified-sidebar, collapsed to zero width below 800 CSS px.`,
  );
}

function settingsTabs(page: Page): Locator {
  return page.locator("[data-testid='settings-overlay'] .settings-nav-item[role='tab']");
}

async function openSettingsTab(page: Page, name: string): Promise<void> {
  const tab = settingsTabs(page).filter({ hasText: name.trim() }).first();
  await tab.click();
  await expect(tab).toHaveClass(/active/);
}

test.describe("B9 OS 200 % zoom reflow", () => {
  test.describe("B9-18 connect page", () => {
    test("the connect form fits and stays usable at 200 % zoom", async ({ page }, testInfo) => {
      await page.addInitScript(
        buildTauriMockScript({ httpRoutes: [HEALTH], simulateWsFlow: false }),
      );
      await page.goto("/");
      const screen: ZoomScreen = {
        name: "zoom-connect-640x400.png",
        root: page.locator(".connect-page"),
        actions: [
          page.locator(".connect-form button[type='submit']"),
          page.locator(".btn-add-server"),
          page.locator(".form-switch > *"),
        ],
      };
      await expectScreenReflows(page, screen, testInfo);
    });
  });

  test.describe("B9-3 / B9-18 / B9-19 / B9-21 / B9-22 shell, message list and composer", () => {
    test("the message surface, its history and composer fit at 200 % zoom", async ({
      page,
    }, testInfo) => {
      await boot(page, [{ pattern: "/messages", status: 200, body: MOCK_MESSAGES }]);
      const screen: ZoomScreen = {
        name: "zoom-shell-640x400.png",
        root: page.locator("[data-testid='chat-area']"),
        actions: [
          page.locator("[data-testid='msg-textarea']"),
          page.locator(".message-input-wrap .send-btn"),
          page.locator("[data-testid='chat-header-name']"),
        ],
      };
      await expectScreenReflows(page, screen, testInfo);
    });

    test("the sidebar navigation stays reachable at 200 % zoom", async ({ page }, testInfo) => {
      blockedOnNavigation("the sidebar itself (channel list and dm-entry)");
      await boot(page, [{ pattern: "/messages", status: 200, body: MOCK_MESSAGES }], true);
      await expectScreenReflows(
        page,
        {
          name: "zoom-sidebar-640x400.png",
          root: page.locator("[data-testid='unified-sidebar']"),
          actions: [
            page.locator(".channel-list .channel-item").first(),
            page.locator("[data-testid='dm-entry']").first(),
          ],
        },
        testInfo,
      );
    });

    test("the search overlay fits at 200 % zoom", async ({ page }, testInfo) => {
      await boot(page, [
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        {
          pattern: "/search",
          status: 200,
          body: {
            results: [
              {
                message_id: 1,
                channel_id: 1,
                channel_name: "general",
                user: { id: 1, username: "testuser", avatar: "" },
                content: "Message number 1 of the fixture history",
                timestamp: "2026-03-15T10:00:00Z",
              },
            ],
          },
        },
      ]);
      await page.keyboard.press("Control+f");
      const screen: ZoomScreen = {
        name: "zoom-search-640x400.png",
        root: page.locator("[data-testid='search-overlay']"),
        actions: [page.locator("[data-testid='search-overlay-input']")],
      };
      await expectScreenReflows(page, screen, testInfo);
    });
  });

  test.describe("B9-5 / B9-6 message requests", () => {
    async function openInbox(page: Page): Promise<void> {
      await page.locator("[data-testid='dm-entry']").first().click();
      await page.locator("[data-testid='dm-requests-entry']").click();
      await page.locator("[data-testid='request-item']").first().waitFor();
    }

    test("the requests inbox fits and its decisions stay reachable at 200 % zoom", async ({
      page,
    }, testInfo) => {
      blockedOnNavigation("dm-entry then dm-requests-entry");
      await boot(
        page,
        [
          { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
          { pattern: "/api/v1/dm-requests", status: 200, body: { requests: REQUESTS } },
        ],
        true,
      );
      await openInbox(page);
      const item = page.locator("[data-testid='request-item']").first();
      const screen: ZoomScreen = {
        name: "zoom-message-requests-640x400.png",
        root: page.locator("[data-testid='requests-inbox']"),
        actions: [
          item.getByRole("button", { name: "Accept" }),
          item.getByRole("button", { name: "Block…" }),
          page.locator("[data-testid='feature-view-close']"),
        ],
      };
      await expectScreenReflows(page, screen, testInfo);
    });

    test("the request Block confirm fits at 200 % zoom", async ({ page }, testInfo) => {
      blockedOnNavigation("dm-entry then dm-requests-entry");
      await boot(
        page,
        [
          { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
          { pattern: "/api/v1/dm-requests", status: 200, body: { requests: REQUESTS } },
        ],
        true,
      );
      await openInbox(page);
      await page
        .locator("[data-testid='request-item']")
        .first()
        .getByRole("button", { name: "Block…" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Block A Stranger?" });
      await dialog.waitFor();
      const screen: ZoomScreen = {
        name: "zoom-request-block-640x400.png",
        root: dialog,
        actions: [
          dialog.getByRole("button", { name: "Cancel" }),
          dialog.getByRole("button", { name: "Block" }),
        ],
      };
      await expectScreenReflows(page, screen, testInfo);
    });
  });

  test.describe("B9-10 reports and My reports", () => {
    test("the report dialog fits at 200 % zoom", async ({ page }, testInfo) => {
      await boot(page, [
        { pattern: "/messages", status: 200, body: REPORT_MESSAGES },
        { pattern: "/api/v1/reports/mine", method: "GET", status: 200, body: MY_REPORTS },
      ]);
      await page.getByTestId("msg-report-201").focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Report message" });
      await dialog.waitFor();
      const screen: ZoomScreen = {
        name: "zoom-report-dialog-640x400.png",
        root: dialog,
        actions: [
          dialog.getByRole("button", { name: "Send report" }),
          dialog.getByRole("button", { name: "Cancel" }),
        ],
      };
      await expectScreenReflows(page, screen, testInfo);
    });

    test("My reports in the Safety tab fits at 200 % zoom", async ({ page }, testInfo) => {
      blockedOnNavigation("the user-bar Settings button then the Safety tab");
      await boot(page, [
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/api/v1/reports/mine", method: "GET", status: 200, body: MY_REPORTS },
      ]);
      await openSettings(page);
      await openSettingsTab(page, "Safety");
      const section = page.getByRole("region", { name: "My reports" });
      await section.locator(".my-reports-item").first().waitFor();
      const screen: ZoomScreen = {
        name: "zoom-my-reports-640x400.png",
        root: section,
        actions: [section.locator(".my-reports-item").first()],
      };
      await expectScreenReflows(page, screen, testInfo);
    });
  });

  test.describe("B9-11 / B9-12 / B9-13 / B9-14 Moderation Center", () => {
    const QUEUE = [modRow(MINE, "assigned", 1, "harassment", "message")];

    async function openReport(page: Page): Promise<Locator> {
      await page.getByTestId("moderation-btn").focus();
      await page.keyboard.press("Enter");
      const center = page.getByTestId("mod-center");
      await center.getByTestId("mod-queue-row").first().waitFor();
      await center.getByTestId("mod-queue-row").first().focus();
      await page.keyboard.press("Enter");
      await center.getByTestId("mod-report").getByRole("heading", { level: 3 }).waitFor();
      return center;
    }

    test("the moderation queue fits at 200 % zoom", async ({ page }, testInfo) => {
      blockedOnNavigation("moderation-btn");
      await boot(page, [
        { pattern: "/messages", status: 200, body: { messages: [], has_more: false } },
        { pattern: "/api/v1/moderation/queue", method: "GET", status: 200, body: QUEUE },
      ]);
      await page.getByTestId("moderation-btn").focus();
      await page.keyboard.press("Enter");
      const center = page.getByTestId("mod-center");
      await center.getByTestId("mod-queue-row").first().waitFor();
      const screen: ZoomScreen = {
        name: "zoom-moderation-queue-640x400.png",
        root: center,
        actions: [center.getByTestId("mod-filter"), center.getByTestId("mod-queue-row").first()],
      };
      await expectScreenReflows(page, screen, testInfo);
    });

    test("the moderation review and its actions fit at 200 % zoom", async ({ page }, testInfo) => {
      blockedOnNavigation("moderation-btn");
      await boot(page, [
        { pattern: "/messages", status: 200, body: { messages: [], has_more: false } },
        { pattern: "/api/v1/moderation/queue", method: "GET", status: 200, body: QUEUE },
        {
          pattern: `/api/v1/moderation/queue/${MINE}`,
          method: "GET",
          status: 200,
          body: modDetail(MINE, "assigned", 1, "harassment", "message"),
        },
      ]);
      const center = await openReport(page);
      const work = center.getByTestId("mod-work");
      const acts = center.getByTestId("mod-act");
      const review: ZoomScreen = {
        name: "zoom-moderation-review-640x400.png",
        root: work,
        actions: [
          work.getByRole("textbox", { name: "Internal note" }),
          work.getByRole("button", { name: "Close report" }),
        ],
      };
      await expectScreenReflows(page, review, testInfo);
      const actions: ZoomScreen = {
        name: "zoom-moderation-actions-640x400.png",
        root: acts,
        actions: [
          acts.getByRole("button", { name: "Issue warning" }),
          acts.getByRole("button", { name: "Time out" }),
          acts.getByRole("button", { name: "Lift timeout" }),
          acts.getByRole("button", { name: "Remove reported message" }),
          acts.getByRole("button", { name: "Ban member" }),
        ],
      };
      await expectScreenReflows(page, actions, testInfo);
    });

    test("the ban confirm fits at 200 % zoom", async ({ page }, testInfo) => {
      blockedOnNavigation("moderation-btn");
      await boot(page, [
        { pattern: "/messages", status: 200, body: { messages: [], has_more: false } },
        { pattern: "/api/v1/moderation/queue", method: "GET", status: 200, body: QUEUE },
        {
          pattern: `/api/v1/moderation/queue/${MINE}`,
          method: "GET",
          status: 200,
          body: modDetail(MINE, "assigned", 1, "harassment", "message"),
        },
      ]);
      await openReport(page);
      await page.getByRole("button", { name: "Ban member" }).click();
      const dialog = page.getByRole("dialog", { name: "Ban this member?" });
      await dialog.waitFor();
      const screen: ZoomScreen = {
        name: "zoom-ban-confirm-640x400.png",
        root: dialog,
        actions: [
          dialog.getByRole("button", { name: "Cancel" }),
          dialog.getByRole("button", { name: "Ban" }),
        ],
      };
      await expectScreenReflows(page, screen, testInfo);
    });
  });

  test.describe("B9-17 appeal review", () => {
    test("the appeal decision form fits at 200 % zoom", async ({ page }, testInfo) => {
      blockedOnNavigation("moderation-btn then the Appeals tab");
      await boot(page, [
        { pattern: "/messages", status: 200, body: { messages: [], has_more: false } },
        { pattern: "/api/v1/moderation/queue", method: "GET", status: 200, body: [] },
        { pattern: APPEALS_Q, method: "GET", status: 200, body: APPEALS },
        { pattern: `${APPEALS_Q}/${HELD}`, method: "GET", status: 200, body: APPEAL_DETAIL },
      ]);
      await page.getByTestId("moderation-btn").focus();
      await page.keyboard.press("Enter");
      const center = page.getByTestId("mod-center");
      await center.getByRole("tab", { name: "Appeals" }).click();
      await center.locator(`[data-appeal-id="${HELD}"]`).click();
      const work = center.getByTestId("mod-appeal-work");
      await work.waitFor();
      const screen: ZoomScreen = {
        name: "zoom-appeal-review-640x400.png",
        root: work,
        actions: [
          work.getByRole("radio", { name: /Uphold/ }),
          work.getByRole("button", { name: "Record decision" }),
        ],
      };
      await expectScreenReflows(page, screen, testInfo);
    });
  });

  test.describe("B9-20 / B9-23 account settings", () => {
    test("the account pane fits at 200 % zoom", async ({ page }, testInfo) => {
      blockedOnNavigation("the user-bar Settings button");
      await boot(page, [{ pattern: "/messages", status: 200, body: MOCK_MESSAGES }]);
      await openSettings(page);
      await openSettingsTab(page, "Account");
      const panel = page.locator("[data-testid='settings-overlay'] .settings-panel");
      const pane = panel.locator(".settings-pane.active");
      await pane.waitFor();
      const screen: ZoomScreen = {
        name: "zoom-account-settings-640x400.png",
        root: panel,
        actions: [
          pane.locator("[data-testid='profile-save-btn']"),
          pane.locator("[data-testid='delete-account-trigger']"),
          panel.locator(".settings-close-btn"),
        ],
      };
      await expectScreenReflows(page, screen, testInfo);
    });

    /** Open Settings from the connect page gear, a zoomed user's own entry point. */
    async function openConnectSettings(page: Page): Promise<Locator> {
      await page.addInitScript(
        buildTauriMockScript({ httpRoutes: [HEALTH], simulateWsFlow: false }),
      );
      await page.goto("/");
      await page.locator(".connect-page .settings-gear").click();
      await expect(page.locator("[data-testid='settings-overlay']")).toHaveClass(/open/);
      return page.locator("[data-testid='settings-overlay'] .settings-panel");
    }

    async function expectSettingsTabReflows(
      page: Page,
      panel: Locator,
      tab: string,
      testInfo: TestInfo,
    ): Promise<void> {
      await openSettingsTab(page, tab);
      await panel.locator(".settings-pane.active").waitFor();
      await expectScreenReflows(
        page,
        {
          name: `zoom-settings-${tab.trim().toLowerCase().replaceAll(/\W+/g, "-")}-640x400.png`,
          root: panel,
          actions: [panel.locator(".settings-close-btn")],
        },
        testInfo,
      );
    }

    test("every settings tab opened from the connect page gear fits at 200 % zoom", async ({
      page,
    }, testInfo) => {
      const panel = await openConnectSettings(page);
      const tabs = (await settingsTabs(page).allInnerTexts()).filter((t) => t.trim() !== "Logs");
      expect(tabs.length, "settings tabs rendered").toBeGreaterThan(0);
      for (const tab of tabs) await expectSettingsTabReflows(page, panel, tab, testInfo);
    });

    test("the Logs tab opened from the connect page gear fits at 200 % zoom", async ({
      page,
    }, testInfo) => {
      test.fail(
        true,
        "Known 1.4.10 defect: the Logs tab controls row (LogsTab.ts: filter and level selects, Copy All, Clear Logs, Refresh) does not wrap, so .settings-content scrolls sideways at 640 CSS px. Production CSS is out of scope for this change.",
      );
      const panel = await openConnectSettings(page);
      await expectSettingsTabReflows(page, panel, "Logs", testInfo);
    });
  });
});

test.describe("B9 OS 200 % zoom checks fail when the behaviour is removed (controls)", () => {
  test("a clipped text sink, a covered control and a 2D scroll area are all caught", async ({
    page,
  }) => {
    await boot(page, [{ pattern: "/messages", status: 200, body: MOCK_MESSAGES }]);
    const root = page.locator("[data-testid='chat-area']");
    expect(await auditReflow(root)).toMatchObject({
      clipped: [],
      covered: [],
      twoDimensional: [],
      pageOverflow: 0,
    });

    await page.evaluate(() => {
      const area = document.querySelector<HTMLElement>("[data-testid='chat-area']")!;
      // A text sink wider than its own box, with no intended scroll area.
      const clipped = document.createElement("div");
      clipped.id = "zz-clipped";
      clipped.textContent = "x".repeat(200);
      clipped.style.cssText = "width:40px;overflow:hidden;white-space:nowrap";
      // A control painted over by a sibling inside the same root.
      const wrap = document.createElement("div");
      wrap.id = "zz-cover-wrap";
      wrap.style.cssText = "position:relative;height:40px";
      const button = document.createElement("button");
      button.id = "zz-covered";
      button.textContent = "Covered";
      button.style.cssText = "position:absolute;left:0;top:0;width:120px;height:32px";
      const cover = document.createElement("div");
      cover.style.cssText =
        "position:absolute;left:0;top:0;width:120px;height:32px;background:red;z-index:2";
      wrap.append(button, cover);
      // A vertical scroll area whose content also overruns it sideways.
      const scroller = document.createElement("div");
      scroller.id = "zz-2d";
      scroller.style.cssText = "width:120px;height:40px;overflow-y:auto";
      const wide = document.createElement("div");
      wide.textContent = "wide";
      wide.style.cssText = "width:400px;height:80px";
      scroller.append(wide);
      area.append(clipped, wrap, scroller);
    });

    const audit = await auditReflow(root);
    expect(audit.clipped.join("\n")).toContain("zz-clipped");
    expect(audit.covered.join("\n")).toContain("zz-covered");
    expect(audit.twoDimensional.join("\n")).toContain("zz-2d");
    expect(audit.clipped.join("\n")).not.toContain("wide");

    // Removing the faults makes the check pass again.
    await page.evaluate(() => {
      document.getElementById("zz-clipped")?.remove();
      document.getElementById("zz-cover-wrap")?.remove();
      document.getElementById("zz-2d")?.remove();
    });
    expect(await auditReflow(root)).toMatchObject({ clipped: [], covered: [], twoDimensional: [] });
  });
});
