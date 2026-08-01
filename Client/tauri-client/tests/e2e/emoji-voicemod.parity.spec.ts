/**
 * Mocked E2E: custom-emoji shortcode autocomplete + render, and voice
 * moderation context-menu gating.
 *
 * Feature 1 (":shortcode" autocomplete + render) is distinct from
 * emoji-insertion.spec.ts, which covers the unicode emoji *picker* only.
 * Here the composer's inline ":" autocomplete (EmojiAutocomplete.ts) is
 * seeded with one custom emoji via GET /api/v1/emoji (the same REST route
 * dispatcher.ts calls once on `ready`; emoji.store.ts is the only place a
 * custom emoji can come from in this client).
 *
 * Feature 2 (voice moderation menu) reuses the ws_send capture pattern from
 * social.parity.spec.ts to assert the exact outgoing message, not just the
 * resulting DOM.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";
import {
  buildTauriMockScript,
  mockTauriFullSessionWithVoice,
  navigateToMainPage,
  navigateToMainPageReady,
  emitWsMessageAndWait,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  MOCK_ROLES,
  MOCK_CHANNELS_WITH_CATEGORIES,
  MOCK_MEMBERS_MULTI_ROLE,
  MOCK_VOICE_STATE,
  voiceWsHandlers,
} from "./helpers";

// ---------------------------------------------------------------------------
// Call capture — records ws_send invocations (same pattern as
// social.parity.spec.ts). Installed as a second init script, after the Tauri
// mock sets up `invoke`, so it can see every outgoing call without touching
// the shared helper file.
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly cmd: string;
  readonly message?: string;
}

function captureScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = (window as any).__TAURI_INTERNALS__;
  const orig = internals.invoke;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__capturedCalls = [];
  internals.invoke = async (cmd: string, args: unknown) => {
    if (cmd === "ws_send") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__capturedCalls.push({ cmd, message: (args as any)?.message });
    }
    return orig(cmd, args);
  };
}

async function getCapturedCalls(page: Page): Promise<CapturedCall[]> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((window as any).__capturedCalls ?? []) as CapturedCall[];
  });
}

/** Poll until a captured call matches, and return it. Avoids racing the async send. */
async function waitForCapturedCall(
  page: Page,
  predicate: (call: CapturedCall) => boolean,
  timeout = 5_000,
): Promise<CapturedCall> {
  let found: CapturedCall | undefined;
  await expect(async () => {
    const calls = await getCapturedCalls(page);
    found = calls.find(predicate);
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

// ---------------------------------------------------------------------------
// Feature 1: custom-emoji ":shortcode" autocomplete + message-list render
// ---------------------------------------------------------------------------

/** One custom emoji, seeded through GET /api/v1/emoji (dispatcher.ts calls
 *  this once on `ready`; emoji.store.ts is the sole source custom-emoji
 *  autocomplete and rendering read from — see EmojiAutocomplete.ts and
 *  message-list/custom-emoji.ts). */
const SEEDED_CUSTOM_EMOJI = { id: 1, shortcode: "partyparrot", url: "/api/v1/emoji/1/image" };

async function mockSessionWithCustomEmoji(page: Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
        // Longer, more specific pattern first (buildTauriMockScript sorts by
        // pattern length, so this always outranks the shorter list route
        // below): the authenticated emoji image fetch custom-emoji.ts makes.
        { pattern: "/api/v1/emoji/1/image", status: 200, body: "fake-emoji-bytes" },
        { pattern: "/api/v1/emoji", status: 200, body: [SEEDED_CUSTOM_EMOJI] },
      ],
      simulateWsFlow: true,
    }),
  );
}

test.describe("@parity Custom emoji — shortcode autocomplete and render", () => {
  test.beforeEach(async ({ page }) => {
    await mockSessionWithCustomEmoji(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test('typing ":" + prefix opens the autocomplete and selecting the row inserts the shortcode token', async ({
    page,
  }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");
    const popup = page.locator("[data-testid='emoji-autocomplete']");
    const row = page.locator("[data-testid='emoji-option-partyparrot']");

    // GET /api/v1/emoji is fired once on `ready`, in parallel with the
    // channel-sidebar render `navigateToMainPage` already waited on, so the
    // response can still be in flight the instant this test starts typing.
    // Retry the whole type-and-check cycle (never a bare sleep) until the
    // store has caught up.
    await expect(async () => {
      await textarea.fill("");
      await textarea.fill(":party");
      await expect(popup).toBeVisible({ timeout: 1_000 });
      await expect(row).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });

    await expect(row.locator(".ma-name")).toHaveText(":partyparrot:");
    await expect(row.locator(".ma-detail")).toHaveText("Server emoji");
    // Custom emoji preview renders as an <img>, not a unicode character cell.
    await expect(row.locator(".ea-preview img.custom-emoji")).toBeAttached();

    await row.click();

    await expect(popup).not.toBeVisible();
    await expect(textarea).toHaveValue(":partyparrot: ");
  });

  test("a chat_message containing the shortcode renders the custom-emoji image", async ({
    page,
  }) => {
    const messageId = 9001;
    await emitWsMessageAndWait(
      page,
      {
        type: "chat_message",
        payload: {
          id: messageId,
          channel_id: 1,
          user: { id: 2, username: "otheruser", avatar: "" },
          content: "look at this :partyparrot: go",
          timestamp: "2026-03-15T11:00:00Z",
          edited_at: null,
          attachments: [],
          reactions: [],
          reply_to: null,
          pinned: false,
          deleted: false,
        },
      },
      page.locator(`[data-testid='message-${messageId}'] img.custom-emoji`),
    );

    const img = page.locator(`[data-testid='message-${messageId}'] img.custom-emoji`);
    await expect(img).toHaveAttribute("alt", ":partyparrot:");
    await expect(img).toHaveAttribute("data-shortcode", "partyparrot");
    // The literal ":partyparrot:" text is replaced by the image node, not
    // left behind as text alongside it.
    await expect(page.locator(`[data-testid='message-${messageId}'] .msg-text`)).not.toContainText(
      ":partyparrot:",
    );
  });
});

// ---------------------------------------------------------------------------
// Feature 2: voice-moderation context menu gating
// ---------------------------------------------------------------------------

test.describe("@parity Voice moderation menu — admin can moderate", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.addInitScript(captureScript);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("offers Server Mute and Disconnect, and Server Mute fires voice_mod_mute", async ({
    page,
  }) => {
    // User 2 is a remote participant of "Voice Chat" (channel 10) in
    // MOCK_VOICE_STATE — the local user (admin, all permissions) may
    // moderate it.
    const row = page.locator(".voice-user-item[data-voice-uid='2']");
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.click({ button: "right" });

    const menu = page.locator(".user-vol-menu");
    await expect(menu).toBeVisible({ timeout: 3_000 });
    const muteItem = menu.locator("[data-action='server-mute']");
    const disconnectItem = menu.locator("[data-action='voice-disconnect']");
    await expect(muteItem).toHaveText("Server Mute");
    await expect(disconnectItem).toHaveText("Disconnect");

    await muteItem.click();

    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "ws_send" && (c.message ?? "").includes("voice_mod_mute"),
    );
    const parsed = JSON.parse(call.message ?? "{}") as {
      type: string;
      payload: { channel_id: number; user_id: number; muted: boolean };
    };
    expect(parsed.type).toBe("voice_mod_mute");
    expect(parsed.payload).toEqual({ channel_id: 10, user_id: 2, muted: true });
  });

  test("Disconnect fires voice_mod_kick", async ({ page }) => {
    const row = page.locator(".voice-user-item[data-voice-uid='3']");
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.click({ button: "right" });

    const menu = page.locator(".user-vol-menu");
    await expect(menu).toBeVisible({ timeout: 3_000 });
    await menu.locator("[data-action='voice-disconnect']").click();

    const call = await waitForCapturedCall(
      page,
      (c) => c.cmd === "ws_send" && (c.message ?? "").includes("voice_mod_kick"),
    );
    const parsed = JSON.parse(call.message ?? "{}") as {
      type: string;
      payload: { user_id: number };
    };
    expect(parsed.type).toBe("voice_mod_kick");
    expect(parsed.payload).toEqual({ user_id: 3 });
  });
});

// The local user's role name comes from `auth_ok`, which
// buildTauriMockScript hardcodes to "admin" (MOCK_AUTH_OK) — not
// overridable via readyOverrides.members, so a member-role *user* can't be
// simulated without editing the shared mock builder. What canModerateVoice()
// actually reads is the *permission bits behind that role name*
// (permissionsForRole("admin") against the `ready.roles` list), which
// readyOverrides.roles does control. Stripping MUTE_MEMBERS from "admin"
// there is a faithful stand-in for "local user's role lacks voice-moderation
// permission" without touching helpers.ts.
async function mockVoiceSessionWithoutModPermission(page: Page): Promise<void> {
  const rolesWithoutMute = MOCK_ROLES.map((r) =>
    r.name === "admin" ? { ...r, permissions: 0x3 } : r,
  );
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
      ],
      simulateWsFlow: true,
      wsHandlers: voiceWsHandlers(),
      readyOverrides: {
        channels: MOCK_CHANNELS_WITH_CATEGORIES,
        members: MOCK_MEMBERS_MULTI_ROLE,
        voice_states: MOCK_VOICE_STATE,
        // buildTauriMockScript's typed `readyOverrides` doesn't list `roles`,
        // but buildReadyPayload (its implementation) does support it — this
        // cast bridges that gap without touching the shared helper file.
        roles: rolesWithoutMute,
      } as unknown as Parameters<typeof buildTauriMockScript>[0]["readyOverrides"],
    }),
  );
}

test.describe("@parity Voice moderation menu — gated without MUTE_MEMBERS", () => {
  test.beforeEach(async ({ page }) => {
    await mockVoiceSessionWithoutModPermission(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("the moderation section is not offered when the local role lacks MUTE_MEMBERS", async ({
    page,
  }) => {
    const row = page.locator(".voice-user-item[data-voice-uid='2']");
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.click({ button: "right" });

    // The per-user volume control (available to everyone) still opens...
    const menu = page.locator(".user-vol-menu");
    await expect(menu).toBeVisible({ timeout: 3_000 });
    await expect(menu.locator(".settings-slider")).toBeVisible();

    // ...but the moderation section, which is gated on MUTE_MEMBERS, is gone.
    await expect(menu.locator("[data-action='server-mute']")).toHaveCount(0);
    await expect(menu.locator("[data-action='voice-disconnect']")).toHaveCount(0);
  });
});
