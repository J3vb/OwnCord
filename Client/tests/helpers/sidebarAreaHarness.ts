import { vi } from "vitest";
import { createSidebarArea, type SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";
import { dmStore, addDmChannel } from "../../src/stores/dm.store";
import { membersStore, type Member } from "../../src/stores/members.store";
import { channelsStore, type Channel, type ChannelsState } from "../../src/stores/channels.store";
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
import { resetChannelsState } from "./storeSeeds";

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
  resetChannelsState();
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

// ---------------------------------------------------------------------------
// Arrange helpers
// ---------------------------------------------------------------------------

/** Mount a fresh SidebarArea into `container`; each call builds its own options unless given. */
export function mountArea(
  container: HTMLElement,
  opts: SidebarAreaOptions = defaultOpts(),
): ReturnType<typeof createSidebarArea> {
  const result = createSidebarArea(opts);
  container.appendChild(result.sidebarWrapper);
  return result;
}

/** The first argument of the first call to a mocked component factory. */
export function firstCallArg(factory: MockedFn) {
  return factory.mock.calls[0]![0];
}

/** The first argument of the most recent call to a mocked component factory. */
export function lastCallArg(factory: MockedFn) {
  const calls = factory.mock.calls;
  return calls[calls.length - 1]![0];
}

/** Start in DMs mode, as if the user had already switched. */
export function enterDmsMode(): void {
  uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
}

/** A complete Channel with quiet defaults; override only what the test cares about. */
export function makeChannel(overrides: Partial<Channel> & Pick<Channel, "id" | "name">): Channel {
  return {
    type: "text",
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
    ...overrides,
  };
}

/** Add channels to channelsStore, optionally patching other state in the same write. */
export function seedChannels(
  channels: readonly Channel[],
  extra: Partial<ChannelsState> = {},
): void {
  channelsStore.setState((prev) => {
    const next = new Map(prev.channels);
    for (const channel of channels) next.set(channel.id, channel);
    return { ...prev, channels: next, ...extra };
  });
}

/** Replace the roster with members that have no avatar. */
export function seedMembers(
  members: ReadonlyArray<Pick<Member, "id" | "username" | "role" | "status">>,
): void {
  membersStore.setState((prev) => ({
    ...prev,
    members: new Map(members.map((m) => [m.id, { ...m, avatar: null }])),
  }));
}

/** Click the "+" beside the DM section and wait for the picker to load; returns the button. */
export async function openMemberPicker(container: HTMLElement): Promise<HTMLElement> {
  const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
  addBtn.click();
  await vi.dynamicImportSettled();
  return addBtn;
}

/** Click the first DM row in the sidebar. */
export function clickDmEntry(container: HTMLElement): void {
  (container.querySelector("[data-testid='dm-entry']") as HTMLElement).click();
}

/** Default options whose toast is a fresh spy the test can assert on. */
export function optsWithToast(): { opts: SidebarAreaOptions; toast: { show: MockedFn } } {
  const toast = { show: vi.fn() };
  const opts = defaultOpts();
  (opts.getToast as MockedFn).mockReturnValue(toast);
  return { opts, toast };
}

/** Add `count` one-to-one DMs (channel ids 100+, users User0..) in the dm store. */
export function addUserDms(count: number): void {
  for (let i = 0; i < count; i++) {
    addDmChannel(
      makeDm({
        channelId: 100 + i,
        recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
      }),
    );
  }
}
