/**
 * The scene the Command Deck tree specs share: four categories (Archive
 * collapsed by the caller), an active channel, an unread one, a muted one, a
 * private one and a voice channel with people in it and a limit.
 */
import type { Page } from "@playwright/test";
import { expect } from "../fixtures";
import {
  BASE_SESSION_ROUTES,
  buildTauriMockScript,
  joinVoiceChannelByName,
  navigateToMainPageReady,
  openContextMenuOn,
  voiceWsHandlers,
} from "../helpers";

const DEV_KEY = "owncord:settings:developerMode";
const LAYOUT_KEY = "owncord:settings:screenLayout";

export const DECK_VIEWPORT = { width: 1333, height: 934 } as const;

const text = (id: number, name: string, category: [string, number], extra = {}) => ({
  id,
  name,
  type: "text",
  position: id,
  category: category[0],
  category_id: category[1],
  unread_count: 0,
  mention_count: 0,
  last_message_id: 1,
  ...extra,
});

const INFO: [string, number] = ["Information", 1];
const GENERAL: [string, number] = ["General", 2];
const VOICE: [string, number] = ["Voice", 3];
const ARCHIVE: [string, number] = ["Archive", 4];

export const SCENE_CHANNELS = [
  text(1, "announcements", INFO, { unread_count: 2, mention_count: 2 }),
  text(2, "rules", INFO),
  text(3, "general", GENERAL),
  text(4, "off-topic", GENERAL, { unread_count: 3 }),
  text(5, "staff", GENERAL, { private: true }),
  {
    id: 6,
    name: "Lounge",
    type: "voice",
    position: 6,
    category: VOICE[0],
    category_id: VOICE[1],
    voice_max_users: 8,
  },
  {
    id: 7,
    name: "Quiet room",
    type: "voice",
    position: 7,
    category: VOICE[0],
    category_id: VOICE[1],
    voice_max_users: 8,
    password_protected: true,
  },
  text(8, "2025-notes", ARCHIVE),
  text(9, "2024-notes", ARCHIVE),
];

const MEMBERS = [
  { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
  { id: 2, username: "Rin", avatar: "", status: "online", role: "member" },
  { id: 3, username: "Marco", avatar: "", status: "online", role: "member" },
];

export interface SceneOptions {
  readonly theme?: string;
  readonly accent?: string;
  readonly highContrast?: boolean;
  /** The window, when the case is not the typical desktop one. */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Extra text channels in one more category, to make the tree scroll. */
  readonly fillers?: number;
  /** The roster in `ready`, in place of the scene's three members. */
  readonly members?: unknown[];
}

const BACKLOG: [string, number] = ["Backlog", 5];

/** `count` plain text channels in the Backlog category. */
const fillerChannels = (count: number): ReturnType<typeof text>[] =>
  Array.from({ length: count }, (_, i) => text(100 + i, `backlog-${i + 1}`, BACKLOG));

/** Boots the signed-in app under Command Deck with the scene, then arranges its states. */
export async function startDeckScene(page: Page, options: SceneOptions = {}): Promise<void> {
  await page.addInitScript(
    ([dev, layout, o]) => {
      localStorage.setItem(dev, JSON.stringify(true));
      localStorage.setItem(layout, JSON.stringify("deck"));
      const set = (key: string, value: unknown): void =>
        localStorage.setItem(`owncord:settings:${key}`, JSON.stringify(value));
      if (o.theme !== undefined) localStorage.setItem("owncord:theme:active", o.theme);
      if (o.accent !== undefined) set("accentColor", o.accent);
      if (o.highContrast === true) set("highContrast", true);
    },
    [DEV_KEY, LAYOUT_KEY, options] as const,
  );
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [...BASE_SESSION_ROUTES],
      simulateWsFlow: true,
      wsHandlers: voiceWsHandlers(),
      readyOverrides: {
        channels: [...SCENE_CHANNELS, ...fillerChannels(options.fillers ?? 0)],
        members: options.members ?? MEMBERS,
        voice_states: [
          { user_id: 2, channel_id: 6, muted: true, deafened: false, screenshare: true },
          { user_id: 3, channel_id: 6, muted: false, deafened: false },
        ],
      },
    }),
  );
  await page.setViewportSize(options.viewport ?? DECK_VIEWPORT);
  await page.goto("/");
  await navigateToMainPageReady(page);
  await expect(page.locator("html")).toHaveClass(/layout-deck/);
  await expect(page.locator(".server-tree")).toBeVisible();
}

/** Mutes `rules`, collapses Archive and joins the Lounge, so every state is on screen. */
export async function arrangeScene(page: Page): Promise<void> {
  const rules = page.getByTestId("channel-2");
  const menu = await openContextMenuOn(page, rules);
  await menu.locator("[data-testid='ctx-mute-channel']").click();
  await expect(rules).toHaveClass(/muted/);
  await page.locator(".category[data-category='Archive']").click();
  await joinVoiceChannelByName(page, "Lounge");
}
