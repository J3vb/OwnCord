import { vi, beforeEach } from "vitest";
import { resetNotificationCoalescing } from "../../src/lib/notifications";
import { channelsStore } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { membersStore } from "../../src/stores/members.store";
import { messagesStore } from "../../src/stores/messages.store";
import type { ChatMessagePayload } from "../../src/lib/types";
import { testPrefs } from "./notificationsMocks";
import { signInAs } from "./storeSeeds";

export function makePayload(overrides: Partial<ChatMessagePayload> = {}): ChatMessagePayload {
  return {
    id: 1,
    channel_id: 1,
    user: { id: 2, username: "TestUser", avatar: null },
    content: "Hello world",
    reply_to: null,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  } as ChatMessagePayload;
}

/** Registers the shared beforeEach for the "notifyIncomingMessage" describe. */
export function useNotificationsHarness(): void {
  beforeEach(() => {
    testPrefs.clear();
    // Coalescing state is module-level and keyed by channel id; clear it so a
    // burst test cannot suppress the next test's single message.
    resetNotificationCoalescing();

    // These cases describe the pre-level behaviour (every non-active message
    // notifies), i.e. the "All" level. The level's own default and gate are
    // covered by notification-level.test.ts and the level cases below.
    testPrefs.set("notificationLevel", "all");

    // Set up auth store with a different user
    signInAs(
      { id: 1, username: "Me", avatar: null, role: "member" },
      { token: "test", serverName: null },
    );

    // Set up channels store
    channelsStore.setState(() => ({
      categories: [],
      channels: new Map([
        [
          1,
          {
            id: 1,
            name: "general",
            type: "text" as const,
            category: null,
            position: 0,
            unreadCount: 0,
            mentionCount: 0,
            lastMessageId: null,
            canSend: true,
            topic: "",
            slowMode: 0,
            nsfw: false,
            isPrivate: false,
            voiceMaxUsers: 0,
            voiceMaxVideo: 0,
          },
        ],
      ]),
      activeChannelId: 1,
      roles: [],
    }));

    // DM ids are absent from channelsStore until the conversation is opened
    // (see dispatcher.ts) -- reset so a DM seeded by one test cannot leak
    // into another that expects the plain channelsStore fallback.
    dmStore.setState(() => ({ channels: [] }));

    // Reset the member store so a nickname seeded by one test cannot leak
    // into another that expects the plain-username title.
    membersStore.setState(() => ({
      members: new Map(),
      typingUsers: new Map(),
      roleRevision: 0,
    }));

    // A channel marked detached by one test (viewing a back-history
    // around-window) must not leak into another that expects the plain
    // active-channel suppression.
    messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set() }));

    // Ensure document.hasFocus returns false (simulating unfocused window)
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });
}

type SendNotificationMock = ReturnType<typeof vi.fn>;

/** The plugin's sendNotification mock with its call history cleared. */
export async function freshSendNotification(): Promise<SendNotificationMock> {
  const { sendNotification } = await import("@tauri-apps/plugin-notification");
  (sendNotification as SendNotificationMock).mockClear();
  return sendNotification as SendNotificationMock;
}

/** Desktop notifications on; taskbar flash and sounds off. */
export function armDesktopPrefs(): void {
  testPrefs.set("desktopNotifications", true);
  testPrefs.set("flashTaskbar", false);
  testPrefs.set("notificationSounds", false);
}

export async function armDesktopNotifications(): Promise<SendNotificationMock> {
  const sendNotification = await freshSendNotification();
  armDesktopPrefs();
  return sendNotification;
}
