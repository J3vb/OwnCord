/**
 * Mocked E2E: the composer's advanced surfaces (audit batch N8, gap #10):
 *
 *   - @mention autocomplete (`MentionAutocomplete.ts` / `inline-autocomplete.ts`)
 *     — open on "@", filter, keyboard/mouse selection, Escape, and the
 *     MENTION_EVERYONE gate on @everyone/@here.
 *   - formatting shortcuts Ctrl+B / Ctrl+I / Ctrl+U (`MessageInput.ts`
 *     FORMAT_MARKERS + `wrapWithMarker`) — wrap the selection in markdown
 *     markers and unwrap it on a second press.
 *   - attachment preview / remove and clipboard paste-upload
 *     (`MessageInput.ts` handlePasteFile).
 *   - the who-reacted tooltip (`message-list/reaction-tooltip.ts`) — hover a
 *     reaction pill fetches the reactor list and renders it, and the list is
 *     cached per message+emoji.
 *
 * Every assertion is on rendered UI or on the outgoing IPC/WS traffic the app
 * actually issued (`window.__invokeLog`, populated by the Tauri mock), so a
 * stubbed handler or a broken render turns the test red.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_MESSAGES_RICH,
  MOCK_PINNED_MESSAGES,
  MOCK_ROLES,
  navigateToMainPageReady,
} from "./helpers";

// ---------------------------------------------------------------------------
// Outgoing-traffic helpers (the mock's own IPC log)
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly data: number[] | null;
  readonly headers: [string, string][];
}

interface InvokeEntry {
  readonly cmd: string;
  readonly args?: { readonly clientConfig?: FetchCall; readonly message?: string };
}

interface HttpRoute {
  readonly pattern: string;
  readonly status: number;
  readonly body: unknown;
  readonly method?: string;
}

async function invokeLog(page: Page): Promise<InvokeEntry[]> {
  return page.evaluate(() => (window as unknown as { __invokeLog: InvokeEntry[] }).__invokeLog);
}

async function fetchCalls(page: Page): Promise<FetchCall[]> {
  const calls: FetchCall[] = [];
  for (const entry of await invokeLog(page)) {
    if (entry.cmd === "plugin:http|fetch" && entry.args?.clientConfig !== undefined) {
      calls.push(entry.args.clientConfig);
    }
  }
  return calls;
}

async function wsSends(page: Page): Promise<Record<string, unknown>[]> {
  const sends: Record<string, unknown>[] = [];
  for (const entry of await invokeLog(page)) {
    if (entry.cmd === "ws_send" && entry.args?.message !== undefined) {
      sends.push(JSON.parse(entry.args.message) as Record<string, unknown>);
    }
  }
  return sends;
}

/** Poll until a request matching `predicate` has been sent. */
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

/** Poll until an outgoing WS frame matching `predicate` has been sent. */
async function waitForWsSend(
  page: Page,
  predicate: (message: Record<string, unknown>) => boolean,
  timeout = 5_000,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await expect(async () => {
    found = (await wsSends(page)).find(predicate);
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

function decodeBody(call: FetchCall): string | null {
  if (!Array.isArray(call.data)) return null;
  return new TextDecoder().decode(new Uint8Array(call.data));
}

// ---------------------------------------------------------------------------
// Routes + fixtures
// ---------------------------------------------------------------------------

const ROUTE_HEALTH: HttpRoute = {
  pattern: "/api/v1/health",
  status: 200,
  body: { status: "ok", version: "1.0.0" },
};
const ROUTE_LOGIN: HttpRoute = {
  pattern: "/api/v1/auth/login",
  status: 200,
  body: MOCK_LOGIN_RESPONSE,
};
const ROUTE_MESSAGES: HttpRoute = { pattern: "/messages", status: 200, body: MOCK_MESSAGES };
// Longer pattern than `/messages` so buildTauriMockScript's longest-first sort
// makes the reaction-carrying fixture win for channel 1 (the plain `/messages`
// route would otherwise match first and leave the pills unrendered).
const ROUTE_MESSAGES_RICH: HttpRoute = {
  pattern: "/channels/1/messages",
  status: 200,
  body: MOCK_MESSAGES_RICH,
};
const ROUTE_PINS: HttpRoute = { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES };

/** POST /uploads — the composer's multipart upload endpoint. */
const ROUTE_UPLOADS: HttpRoute = {
  pattern: "/api/v1/uploads",
  method: "POST",
  status: 200,
  body: { id: "upload-1", filename: "pasted.png", size: 4, mime: "image/png", url: "/f/upload-1" },
};

/**
 * GET .../reactions/{emoji}/users — the who-reacted tooltip's fetch.
 *
 * The pattern must be longer than `/channels/1/messages` (ROUTE_MESSAGES_RICH)
 * because matchRoute picks the longest matching pattern: the reactor URL
 * contains `/messages/102/reactions/…`, so the rich-messages route would
 * otherwise swallow it and hand the tooltip the messages body (no `users`
 * array).
 */
const REACTION_USERS: HttpRoute = {
  pattern: "/messages/102/reactions/",
  method: "GET",
  status: 200,
  body: {
    users: [
      { id: 1, username: "testuser", avatar: "" },
      { id: 2, username: "otheruser", avatar: "" },
    ],
  },
};

/**
 * A real 64x64 PNG, so the preview `<img>` has a non-trivial box and the
 * absolutely-positioned remove button lands inside it (a 1x1 source would
 * leave a 1x1 item with the button hanging off the edge, unclickable).
 */
const PNG_64X64 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwGqqfwGTNRF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj10ThMEPv3x7AAAAAABJRU5ErkJggg==",
  "base64",
);

/** Roles for the local "admin" without MENTION_EVERYONE (nor ADMINISTRATOR,
 *  which would otherwise grant every bit). */
const ROLES_WITHOUT_MENTION_EVERYONE = MOCK_ROLES.map((r) =>
  r.name === "admin" ? { ...r, permissions: 0x3 } : r,
);

interface BootOptions {
  /** Extra HTTP routes appended after the base set. */
  readonly routes?: readonly HttpRoute[];
  /** Overrides the `ready.roles` list (e.g. to strip MENTION_EVERYONE). */
  readonly roles?: readonly unknown[];
}

async function bootComposer(page: Page, options: BootOptions = {}): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ROUTE_HEALTH,
        ROUTE_LOGIN,
        ROUTE_MESSAGES,
        ROUTE_PINS,
        ROUTE_UPLOADS,
        ...(options.routes ?? []),
      ],
      simulateWsFlow: true,
      // `readyOverrides.roles` is honoured by buildReadyPayload but missing from
      // buildTauriMockScript's public option type; the cast bridges that (same
      // pattern as emoji-voicemod.parity.spec.ts).
      ...(options.roles === undefined
        ? {}
        : {
            readyOverrides: { roles: options.roles } as unknown as Parameters<
              typeof buildTauriMockScript
            >[0]["readyOverrides"],
          }),
    }),
  );
  await page.goto("/");
  await navigateToMainPageReady(page);
}

const textarea = (page: Page) => page.locator("[data-testid='msg-textarea']");
const mentionPopup = (page: Page) => page.locator("[data-testid='mention-autocomplete']");
const previewItem = (page: Page) =>
  page.locator("[data-testid='message-input'] .attachment-preview-item");

// ---------------------------------------------------------------------------
// Mention autocomplete
// ---------------------------------------------------------------------------

test.describe("Composer — mention autocomplete", () => {
  test.beforeEach(async ({ page }) => {
    await bootComposer(page);
  });

  test('typing "@" opens the popup listing members and @everyone/@here', async ({ page }) => {
    await textarea(page).fill("@");

    await expect(mentionPopup(page)).toBeVisible();
    await expect(page.locator("[data-testid='mention-option-otheruser'] .ma-name")).toHaveText(
      "@otheruser",
    );
    await expect(page.locator("[data-testid='mention-option-everyone'] .ma-name")).toHaveText(
      "@everyone",
    );
    await expect(page.locator("[data-testid='mention-option-here'] .ma-name")).toHaveText("@here");
  });

  test("the query filters to matching members and Enter inserts the token", async ({ page }) => {
    await textarea(page).fill("@oth");
    await expect(mentionPopup(page)).toBeVisible();
    // Filtered out: neither the broadcasts nor the other member match "oth".
    await expect(page.locator("[data-testid='mention-option-everyone']")).toHaveCount(0);
    await expect(page.locator("[data-testid='mention-option-testuser']")).toHaveCount(0);
    await expect(page.locator("[data-testid='mention-option-otheruser']")).toBeVisible();

    await textarea(page).press("Enter");
    await expect(textarea(page)).toHaveValue("@otheruser ");
    await expect(mentionPopup(page)).not.toBeVisible();
  });

  test("clicking a row inserts @token and closes the popup", async ({ page }) => {
    await textarea(page).fill("@");
    await page.locator("[data-testid='mention-option-otheruser']").click();

    await expect(textarea(page)).toHaveValue("@otheruser ");
    await expect(mentionPopup(page)).not.toBeVisible();
  });

  test("Escape closes the popup without changing the draft", async ({ page }) => {
    await textarea(page).fill("@oth");
    await expect(mentionPopup(page)).toBeVisible();

    await textarea(page).press("Escape");

    await expect(mentionPopup(page)).not.toBeVisible();
    await expect(textarea(page)).toHaveValue("@oth");
  });

  test("ArrowDown moves the active row and Enter inserts it", async ({ page }) => {
    // Two rows match "er" (otheruser and testuser), so the arrow key decides
    // which one Enter picks; the first row is otheruser alphabetically.
    await textarea(page).fill("@er");
    await expect(mentionPopup(page)).toBeVisible();
    const first = page.locator("[data-testid='mention-option-otheruser']");
    const second = page.locator("[data-testid='mention-option-testuser']");
    await expect(first).toHaveClass(/ma-item--active/);

    await textarea(page).press("ArrowDown");
    await expect(second).toHaveClass(/ma-item--active/);

    await textarea(page).press("Enter");
    await expect(textarea(page)).toHaveValue("@testuser ");
  });
});

test.describe("Composer — @everyone gate", () => {
  test("without MENTION_EVERYONE the broadcasts are omitted but members remain", async ({
    page,
  }) => {
    await bootComposer(page, { roles: ROLES_WITHOUT_MENTION_EVERYONE });

    await textarea(page).fill("@");

    await expect(mentionPopup(page)).toBeVisible();
    // Positive control: ordinary members are still offered.
    await expect(page.locator("[data-testid='mention-option-otheruser']")).toBeVisible();
    await expect(page.locator("[data-testid='mention-option-testuser']")).toBeVisible();
    // The gate: the sender may not broadcast.
    await expect(page.locator("[data-testid='mention-option-everyone']")).toHaveCount(0);
    await expect(page.locator("[data-testid='mention-option-here']")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Formatting shortcuts
// ---------------------------------------------------------------------------

const FORMAT_SHORTCUTS: ReadonlyArray<{ key: string; marker: string; name: string }> = [
  { key: "b", marker: "**", name: "bold" },
  { key: "i", marker: "*", name: "italic" },
  { key: "u", marker: "__", name: "underline" },
];

test.describe("Composer — Ctrl+B/I/U formatting", () => {
  test.beforeEach(async ({ page }) => {
    await bootComposer(page);
  });

  for (const { key, marker, name } of FORMAT_SHORTCUTS) {
    test(`Ctrl+${key.toUpperCase()} wraps the selection in ${marker} and unwraps on a second press (${name})`, async ({
      page,
    }) => {
      const input = textarea(page);
      await input.fill("hello");
      await input.selectText();

      await input.press(`Control+${key}`);
      await expect(input).toHaveValue(`${marker}hello${marker}`);

      // The selection now covers the inner text, so the shortcut toggles off.
      await input.press(`Control+${key}`);
      await expect(input).toHaveValue("hello");
    });
  }
});

// ---------------------------------------------------------------------------
// Attachment preview / remove
// ---------------------------------------------------------------------------

const fileInput = (page: Page) => page.locator("[data-testid='message-input'] input[type='file']");
const previewBar = (page: Page) =>
  page.locator("[data-testid='message-input'] .attachment-preview-bar");

test.describe("Composer — attachment preview and remove", () => {
  test.beforeEach(async ({ page }) => {
    await bootComposer(page);
  });

  test("picking a file previews it, uploads it as multipart, and remove clears the bar", async ({
    page,
  }) => {
    await fileInput(page).setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: PNG_64X64,
    });

    await expect(previewBar(page)).toHaveClass(/visible/);
    await expect(previewItem(page)).toHaveCount(1);
    await expect(previewItem(page).locator("img.attachment-preview-img")).toHaveAttribute(
      "src",
      /^data:/,
    );
    // The upload finished: the spinner/uploading state is gone.
    await expect(previewItem(page)).not.toHaveClass(/uploading/);

    // Outgoing traffic: a multipart POST carrying the file.
    const call = await waitForFetch(
      page,
      (c) => c.method === "POST" && c.url.includes("/api/v1/uploads"),
    );
    const contentType =
      call.headers.find(([header]) => header.toLowerCase() === "content-type")?.[1] ?? "";
    expect(contentType).toContain("multipart/form-data");
    expect(decodeBody(call) ?? "").toContain('filename="photo.png"');

    await page.locator("[data-testid='attachment-remove']").click();

    await expect(previewItem(page)).toHaveCount(0);
    await expect(previewBar(page)).not.toHaveClass(/visible/);
  });

  test("a queued attachment's server id rides the next chat_send", async ({ page }) => {
    await fileInput(page).setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: PNG_64X64,
    });
    await expect(previewItem(page)).not.toHaveClass(/uploading/);

    await textarea(page).fill("here you go");
    await textarea(page).press("Enter");

    const send = await waitForWsSend(page, (m) => m.type === "chat_send");
    const payload = send.payload as Record<string, unknown>;
    expect(payload.content).toBe("here you go");
    expect(payload.attachments).toEqual(["upload-1"]);

    // The composer's queue is cleared once the send is handed to the socket.
    await expect(previewItem(page)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Clipboard paste-upload
// ---------------------------------------------------------------------------

test.describe("Composer — paste-upload", () => {
  test.beforeEach(async ({ page }) => {
    await bootComposer(page);
  });

  test("pasting a clipboard image uploads it and shows the preview", async ({ page }) => {
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([new Uint8Array([137, 80, 78, 71])], "clipboard.png", { type: "image/png" }),
      );
      const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true });
      document.querySelector("[data-testid='msg-textarea']")!.dispatchEvent(event);
    });

    await expect(previewItem(page)).toHaveCount(1);

    const call = await waitForFetch(
      page,
      (c) => c.method === "POST" && c.url.includes("/api/v1/uploads"),
    );
    expect(decodeBody(call) ?? "").toContain('filename="clipboard.png"');
  });
});

// ---------------------------------------------------------------------------
// Reaction tooltip
// ---------------------------------------------------------------------------

test.describe("Reaction tooltip", () => {
  test.beforeEach(async ({ page }) => {
    await bootComposer(page, { routes: [ROUTE_MESSAGES_RICH, REACTION_USERS] });
  });

  test("hovering a reaction pill fetches the reactors and renders the tooltip", async ({
    page,
  }) => {
    const chip = page.locator("[data-testid='message-102'] .reaction-chip").first();
    await expect(chip).toBeVisible();
    await chip.hover();

    const tooltip = page.locator("[data-testid='message-102'] [data-testid='reaction-tooltip']");
    await expect(tooltip).toBeVisible({ timeout: 5_000 });
    await expect(tooltip.locator(".reaction-tooltip-names")).toHaveText("testuser and otheruser");
    await expect(tooltip.locator(".reaction-tooltip-emoji")).toHaveText("reacted with 👍");

    // Outgoing traffic: the reactor list came from the per-emoji endpoint.
    const call = await waitForFetch(page, (c) => c.url.includes("/reactions/"));
    expect(call.method).toBe("GET");
    expect(call.url).toContain("/messages/102/reactions/");
    expect(call.url).toContain("/users");

    // Pointer leaves the pill: the tooltip goes away.
    await page.locator("[data-testid='message-101']").hover();
    await expect(tooltip).toHaveCount(0);
  });

  test("re-hovering the same pill reuses the cached list (one fetch)", async ({ page }) => {
    const chip = page.locator("[data-testid='message-102'] .reaction-chip").first();
    const tooltip = page.locator("[data-testid='message-102'] [data-testid='reaction-tooltip']");

    await chip.hover();
    await expect(tooltip).toBeVisible({ timeout: 5_000 });
    await page.locator("[data-testid='message-101']").hover();
    await expect(tooltip).toHaveCount(0);

    await chip.hover();
    await expect(tooltip).toBeVisible({ timeout: 5_000 });

    const reactionFetches = (await fetchCalls(page)).filter((c) => c.url.includes("/reactions/"));
    expect(reactionFetches).toHaveLength(1);
  });
});
