import { afterEach, beforeEach, vi, type Mock } from "vitest";
import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import { mockOpenUserProfilePopup } from "./channelSidebarMocks";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore } from "../../src/stores/voice.store";
import type { PeerVerification } from "../../src/stores/voice.store";
import { type ReadyChannel } from "../../src/lib/types";
import { resetMembersState } from "./storeResets";
import { signInAs, resetChannelsState } from "./storeSeeds";

export { addVoiceUser } from "./voiceUsers";

export function resetStores(): void {
  resetChannelsState();
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: "Test Server",
    motd: null,
    isAuthenticated: false,
  }));
  uiStore.setState(() => ({
    sidebarCollapsed: false,
    memberListVisible: true,
    settingsOpen: false,
    activeModal: null,
    theme: "dark" as const,
    // Default to a live socket: the voice join/leave affordance is only usable
    // when connected. Frozen-state behavior is exercised explicitly below.
    connectionStatus: "connected" as const,
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
    peerVerifications: new Map(),
  }));
  resetMembersState();
}

/** Record a peer's E2EE identity verification result in the voice store. */
export function setPeerVerif(
  userId: number,
  status: PeerVerification["status"],
  safetyNumber: string | null = null,
  sessionFingerprint: string | null = null,
): void {
  voiceStore.setState((prev) => {
    const peerVerifications = new Map(prev.peerVerifications ?? []);
    peerVerifications.set(userId, { userId, status, safetyNumber, sessionFingerprint });
    return { ...prev, peerVerifications };
  });
}

export const testChannels: ReadyChannel[] = [
  {
    id: 1,
    name: "general",
    type: "text",
    category: "Text Channels",
    position: 0,
    unread_count: 2,
    last_message_id: 100,
  },
  {
    id: 2,
    name: "random",
    type: "text",
    category: "Text Channels",
    position: 1,
    unread_count: 0,
    last_message_id: 50,
  },
  {
    id: 3,
    name: "voice-lobby",
    type: "voice",
    category: "Voice Channels",
    position: 0,
  },
  {
    id: 4,
    name: "announcements",
    type: "announcement",
    category: "Info",
    position: 0,
    unread_count: 5,
    last_message_id: 200,
  },
];

/** Fresh spies for the four voice moderation callbacks. */
export function voiceModCallbacks() {
  return {
    onServerMute: vi.fn(),
    onServerDeafen: vi.fn(),
    onMove: vi.fn(),
    onDisconnect: vi.fn(),
  };
}

/** Set auth user so admin-gated features (context menus, drag, create channel) activate. */
export function setAdminUser(): void {
  signInAs({ id: 1, username: "Admin", avatar: null, role: "admin" });
}

export interface SidebarFixture {
  container: HTMLDivElement;
  sidebar: ReturnType<typeof createChannelSidebar>;
  onVoiceJoin: Mock<(channelId: number) => void>;
  onOpenCall: Mock<() => void>;
}

/**
 * Registers the hooks that give each test a reset store, a mounted-to-body
 * container, fresh callback spies and a new sidebar. `bind` receives each
 * fixture so the suite can keep it in locals; `current` returns whichever
 * sidebar the test left live, so a test that rebuilds it still gets it destroyed.
 */
export function useSidebarFixture(
  bind: (fixture: SidebarFixture) => void,
  current: () => ReturnType<typeof createChannelSidebar>,
): void {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    mockOpenUserProfilePopup.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    const onVoiceJoin = vi.fn<(channelId: number) => void>();
    const onOpenCall = vi.fn<() => void>();
    const sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
    bind({ container, sidebar, onVoiceJoin, onOpenCall });
  });

  afterEach(() => {
    current().destroy?.();
    container.remove();
    // Clean up any context menus left on document.body
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    document.querySelectorAll(".user-vol-menu").forEach((el) => el.remove());
  });
}

export interface SidebarScope {
  bind(fixture: Partial<SidebarFixture> & Pick<SidebarFixture, "container">): void;
  current(): ReturnType<typeof createChannelSidebar>;
  /** Runs after the store reset, before the container is created. */
  arrange?(): void;
  /** Creates the sidebar (with fresh spies) in beforeEach instead of leaving it to the test. */
  build?: boolean;
  /** Elements matching this selector are removed from the document after each test. */
  strayElements?: string;
  teardown?(): void;
}

/** Like `useSidebarFixture`, for suites that arrange their own stores or build the sidebar later. */
export function useSidebarScope(scope: SidebarScope): void {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    scope.arrange?.();
    container = document.createElement("div");
    document.body.appendChild(container);
    if (!scope.build) {
      scope.bind({ container });
      return;
    }
    const onVoiceJoin = vi.fn<(channelId: number) => void>();
    const onOpenCall = vi.fn<() => void>();
    const sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
    scope.bind({ container, sidebar, onVoiceJoin, onOpenCall });
  });

  afterEach(() => {
    scope.current().destroy?.();
    container.remove();
    if (scope.strayElements) {
      document.querySelectorAll(scope.strayElements).forEach((el) => el.remove());
    }
    scope.teardown?.();
  });
}

/** Put the local user in channel 3 beside one peer, replacing the whole voice state. */
export function joinVoiceRoomWith(
  userId: number,
  username: string,
  media: { camera?: boolean; screenshare?: boolean } = {},
): void {
  voiceStore.setState(() => ({
    currentChannelId: 3,
    voiceUsers: new Map([
      [
        3,
        new Map([
          [
            userId,
            {
              userId,
              username,
              speaking: false,
              muted: false,
              deafened: false,
              camera: media.camera ?? false,
              screenshare: media.screenshare ?? false,
            },
          ],
        ]),
      ],
    ]),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
    voiceStatus: "idle",
  }));
}

/** Dispatch a bubbling right-click (contextmenu) on `el` at the given client point. */
export function rightClick(el: HTMLElement, clientX = 100, clientY = 200): void {
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX, clientY }));
}
