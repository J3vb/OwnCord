/**
 * The scene the Command Deck Direct folder specs share: the tree scene's
 * channels, plus ten DMs (a group, unread ones, every presence), one pending
 * message request and the voice scene's Lounge.
 */
import type { Page } from "@playwright/test";
import { expect } from "../fixtures";
import {
  BASE_SESSION_ROUTES,
  buildTauriMockScript,
  dmChannel,
  groupDmChannel,
  navigateToMainPageReady,
  voiceWsHandlers,
} from "../helpers";
import { DECK_VIEWPORT, SCENE_CHANNELS } from "./deckTreeScene";

const DEV_KEY = "owncord:settings:developerMode";
const LAYOUT_KEY = "owncord:settings:screenLayout";

export const MIRA = 200;
export const CREW = 201;
export const TESS = 202;

const person = (id: number, username: string, status: string) => ({
  id,
  username,
  avatar: "",
  status,
});

const DMS = [
  dmChannel(MIRA, person(11, "Mira", "online"), { last_message_id: 600 }),
  groupDmChannel(CREW, {
    name: "Weekend crew",
    recipient: person(12, "Kit", "online"),
    recipients: [person(12, "Kit", "online"), person(13, "Lou", "idle"), person(14, "Ned", "dnd")],
    unread_count: 3,
    last_message_id: 599,
  }),
  dmChannel(TESS, person(15, "Tess", "online"), { unread_count: 2, last_message_id: 598 }),
  dmChannel(203, person(16, "Juno", "idle"), { last_message_id: 597 }),
  dmChannel(204, person(17, "Sora", "offline"), { last_message_id: 596 }),
  dmChannel(205, person(18, "Pim", "idle"), { last_message_id: 595 }),
  dmChannel(206, person(19, "Odo", "offline"), { last_message_id: 594 }),
  dmChannel(207, person(20, "Lena", "online"), { last_message_id: 593 }),
  dmChannel(208, person(21, "Bex", "offline"), { last_message_id: 592 }),
  dmChannel(209, person(22, "Rin", "online"), { last_message_id: 591 }),
];

const PENDING_REQUEST = {
  id: 2,
  channel_id: 300,
  sender: { id: 40, username: "stranger", display_name: "A Stranger", avatar: "" },
  preview: { message_id: 902, content: "hello", timestamp: "2026-09-05T12:00:00Z" },
  created_at: "2026-09-05T12:00:00Z",
};

export interface DirectSceneOptions {
  readonly theme?: string;
  /** Classic for the comparison shots; Command Deck by default. */
  readonly layout?: "classic" | "deck";
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Message requests waiting; one by default. */
  readonly pending?: number;
}

/** Boots the signed-in app under Command Deck with the tree scene and the DMs. */
export async function startDirectScene(
  page: Page,
  options: DirectSceneOptions = {},
): Promise<void> {
  await page.addInitScript(
    ([dev, layout, theme, mode]) => {
      localStorage.setItem(dev, JSON.stringify(true));
      localStorage.setItem(layout, JSON.stringify(mode));
      if (theme !== undefined) localStorage.setItem("owncord:theme:active", theme);
    },
    [DEV_KEY, LAYOUT_KEY, options.theme, options.layout ?? "deck"] as const,
  );
  const requests = Array.from({ length: options.pending ?? 1 }, (_, i) => ({
    ...PENDING_REQUEST,
    id: 2 + i,
    channel_id: 300 + i,
  }));
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ...BASE_SESSION_ROUTES,
        { pattern: "/api/v1/dm-requests", status: 200, body: { requests } },
      ],
      simulateWsFlow: true,
      wsHandlers: voiceWsHandlers(),
      readyOverrides: {
        channels: SCENE_CHANNELS,
        dm_channels: DMS,
        members: [
          { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
          { id: 2, username: "Rin", avatar: "", status: "online", role: "member" },
          { id: 3, username: "Marco", avatar: "", status: "online", role: "member" },
        ],
      },
    }),
  );
  await page.setViewportSize(options.viewport ?? DECK_VIEWPORT);
  await page.goto("/");
  await navigateToMainPageReady(page);
  if (options.layout === "classic") return;
  await expect(page.locator("html")).toHaveClass(/layout-deck/);
  await expect(page.locator(".server-tree-direct-head")).toBeVisible();
}
