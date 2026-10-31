import { vi } from "vitest";
import { createSidebarArea, type SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";
import { channelsStore } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { uiStore } from "../../src/stores/ui.store";
import { authStore } from "../../src/stores/auth.store";
import { voiceStore, joinVoiceChannel } from "../../src/stores/voice.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createDmSidebar } from "@components/DmSidebar";
import { createMemberList } from "@components/MemberList";
import { createUserBar } from "@components/UserBar";
import { createVoiceWidget } from "@components/VoiceWidget";
import { createCreateChannelModal } from "@components/CreateChannelModal";
import { createEditChannelModal } from "@components/EditChannelModal";
import { createDeleteChannelModal } from "@components/DeleteChannelModal";
import { resetMembersState } from "./storeResets";

// ---------------------------------------------------------------------------
// Helpers to access mock internals
// ---------------------------------------------------------------------------

export type MockedFn = ReturnType<typeof vi.fn>;

export function getMockMount(factory: MockedFn): MockedFn {
  const lastCall = factory.mock.results[factory.mock.results.length - 1];
  return lastCall?.value?.mount;
}

export function getMockDestroy(factory: MockedFn): MockedFn {
  const lastCall = factory.mock.results[factory.mock.results.length - 1];
  return lastCall?.value?.destroy;
}

export function getMockUpdate(factory: MockedFn): MockedFn {
  const lastCall = factory.mock.results[factory.mock.results.length - 1];
  return lastCall?.value?.update;
}

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------

export function resetStores(): void {
  channelsStore.setState(() => ({
    categories: [],
    channels: new Map(),
    activeChannelId: null,
    roles: [],
  }));
  dmStore.setState(() => ({ channels: [] }));
  uiStore.setState(() => ({
    sidebarCollapsed: false,
    memberListVisible: true,
    settingsOpen: false,
    activeModal: null,
    theme: "dark" as const,
    connectionStatus: "disconnected" as const,
    connectionDialFailed: false,
    transientError: null,
    sessionReplaced: false,
    persistentError: null,
    updateRequiredHost: null,
    collapsedCategories: new Set<string>(),
    sidebarMode: "channels" as const,
    activeDmUserId: null,
    activeView: null,
    settingsTab: null,
  }));
  authStore.setState(() => ({
    token: "test-token",
    user: { id: 1, username: "testuser", role: "admin", avatar: null, totp_enabled: false },
    serverName: "Test Server",
    motd: null,
    isAuthenticated: true,
  }));
  resetMembersState();
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
    voiceStatus: "idle",
  }));
  localStorage.removeItem("owncord:member-list-height");
  localStorage.removeItem("owncord:member-list-collapsed");
  // The default layout is "right" (3C-6c); these tests exercise the left section.
  localStorage.setItem("owncord:settings:memberListLayout", '"left"');
}

export function resetMocks(): void {
  (createChannelSidebar as MockedFn).mockClear();
  (createDmSidebar as MockedFn).mockClear();
  (createMemberList as MockedFn).mockClear();
  (createUserBar as MockedFn).mockClear();
  (createVoiceWidget as MockedFn).mockClear();
  (createCreateChannelModal as MockedFn).mockClear();
  (createEditChannelModal as MockedFn).mockClear();
  (createDeleteChannelModal as MockedFn).mockClear();

  // Reset return values so each test gets fresh mock objects
  (createChannelSidebar as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createDmSidebar as MockedFn).mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
    update: vi.fn(),
  });
  (createMemberList as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createUserBar as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createVoiceWidget as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createCreateChannelModal as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createEditChannelModal as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createDeleteChannelModal as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
}

/** The voice widget loads when the user is first in voice (O-6b): put the user
 *  in a voice channel and wait for the widget's code to arrive. */
export async function enterVoiceAndAwaitWidget(): Promise<void> {
  joinVoiceChannel(1);
  voiceStore.flush();
  await vi.dynamicImportSettled();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function makeDm(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 100,
    recipient: { id: 10, username: "Alice", avatar: "", status: "online" },
    participants: [{ id: 10, username: "Alice", avatar: "", status: "online" }],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
    ...overrides,
  };
}

export function defaultOpts(): SidebarAreaOptions {
  return {
    ws: {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(() => vi.fn()),
      off: vi.fn(),
    } as unknown as SidebarAreaOptions["ws"],
    api: {
      createDm: vi.fn().mockResolvedValue({
        channel_id: 200,
        recipient: { id: 20, username: "Bob", avatar: "", status: "online" },
      }),
      closeDm: vi.fn().mockResolvedValue(undefined),
      getInvites: vi.fn().mockResolvedValue([]),
      createInvite: vi
        .fn()
        .mockResolvedValue({ code: "abc", expires_at: "", max_uses: 0, use_count: 0 }),
      revokeInvite: vi.fn().mockResolvedValue(undefined),
      adminCreateChannel: vi.fn().mockResolvedValue(undefined),
      adminUpdateChannel: vi.fn().mockResolvedValue(undefined),
      adminDeleteChannel: vi.fn().mockResolvedValue(undefined),
      purgeMessages: vi.fn().mockResolvedValue({ channel_id: 1, ids: [3, 2], count: 2 }),
      adminKickMember: vi.fn().mockResolvedValue(undefined),
      adminBanMember: vi.fn().mockResolvedValue(undefined),
      adminChangeRole: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockReturnValue({ host: "localhost:8080" }),
    } as unknown as SidebarAreaOptions["api"],
    limiters: {
      voice: { tryConsume: vi.fn().mockReturnValue(true) },
      voiceVideo: { tryConsume: vi.fn().mockReturnValue(true) },
    } as unknown as SidebarAreaOptions["limiters"],
    presenceSender: {
      send: vi.fn(),
      rollbackRefused: vi.fn(),
      destroy: vi.fn(),
    },
    getRoot: vi.fn().mockReturnValue(document.createElement("div")),
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  };
}

/** Helper to clean up a SidebarAreaResult */
export function cleanup(result: ReturnType<typeof createSidebarArea>): void {
  for (const unsub of result.unsubscribers) unsub();
}
