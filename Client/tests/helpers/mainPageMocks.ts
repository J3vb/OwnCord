import { vi } from "vitest";

// jsdom has no matchMedia; the lazily-loaded sidebar drawer reads its
// breakpoint from it. Wide: the drawer stays out of the way.
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => Object.assign(new EventTarget(), { matches: false, media: "" })),
);

export const { capturedOnRemoteVideo } = {
  capturedOnRemoteVideo: {
    current: null as null | ((userId: number, stream: MediaStream, isScreenshare: boolean) => void),
  },
};

export const { mockSetAudioVolumeHost } = {
  mockSetAudioVolumeHost: vi.fn(),
};

// Real audioElements.ts pulls in livekit-client (unmocked elsewhere in this
// file's graph) purely to hold the AudioElements class this page never
// touches directly — mock out the one export MainPage actually calls.
export const { mockCreateUpdateNotifier } = {
  mockCreateUpdateNotifier: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
};

export const { capturedAutoIdleOptions, autoIdleController } = {
  capturedAutoIdleOptions: {
    current: null as null | { onStatusChange: (status: string) => void },
  },
  autoIdleController: { destroy: vi.fn() },
};

export const {
  mockMountChannel,
  mockDestroyChannel,
  mockCreateChannelController,
  mockCreateSidebarArea,
  mockCreateChatArea,
  capturedChatAreaRef,
} = {
  mockMountChannel: vi.fn(),
  mockDestroyChannel: vi.fn(),
  mockCreateChannelController: vi.fn(),
  mockCreateSidebarArea: vi.fn(),
  mockCreateChatArea: vi.fn(),
  // The ChatArea mock below builds fresh DOM elements per call (a plain
  // return value can't be read back from a vi.fn() call site) — this is how
  // tests get at the actual slots/dmProfileSlot MainPage is wiring against.
  capturedChatAreaRef: {
    current: null as null | {
      chatArea: HTMLDivElement;
      slots: {
        messagesSlot: HTMLDivElement;
        typingSlot: HTMLDivElement;
        inputSlot: HTMLDivElement;
        videoGridSlot: HTMLDivElement;
      };
      dmProfileSlot: HTMLDivElement;
      profileBtn: HTMLButtonElement;
      videoGrid: {
        addStream: ReturnType<typeof vi.fn>;
        removeStream: ReturnType<typeof vi.fn>;
        clearStreams: ReturnType<typeof vi.fn>;
        watch: ReturnType<typeof vi.fn>;
        hasStreams: ReturnType<typeof vi.fn>;
        setFocusedTile: ReturnType<typeof vi.fn>;
        getFocusedTileId: ReturnType<typeof vi.fn>;
        setLabel: ReturnType<typeof vi.fn>;
        setPeople: ReturnType<typeof vi.fn>;
        setSpeaking: ReturnType<typeof vi.fn>;
        setCallbacks: ReturnType<typeof vi.fn>;
        setCallState: ReturnType<typeof vi.fn>;
        ensureLoaded: ReturnType<typeof vi.fn>;
        setExitVisible: ReturnType<typeof vi.fn>;
        showMiniPlayer: ReturnType<typeof vi.fn>;
        hideMiniPlayer: ReturnType<typeof vi.fn>;
      };
    },
  },
};

export const { mockPruneAttachmentCacheScope } = {
  mockPruneAttachmentCacheScope: vi.fn(async () => {}),
};

export const {
  mockReturnToChannel,
  mockRememberChannel,
  mockRenameGroup,
  inertModeration,
  memberPanels,
} = {
  mockReturnToChannel: vi.fn(),
  mockRenameGroup: vi.fn(),
  mockRememberChannel: vi.fn(),
  inertModeration: { signals: [] as AbortSignal[] },
  // Every member-list instance either host built, and how many were destroyed.
  memberPanels: { created: 0, destroyed: 0, events: [] as string[] },
};

// B9-8: this suite exercises content the viewer has already consented to;
// the consent gate itself is proven in src/features/content-consent/external.test.ts.
export async function consentExternalMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
    externalAllowed: () => true,
  };
}

export function loggerMock() {
  return {
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
}

export function voiceLivekitSessionMock() {
  return {
    cleanupAll: vi.fn(),
    setOnRemoteVideo: vi.fn(
      (cb: (userId: number, stream: MediaStream, isScreenshare: boolean) => void) => {
        capturedOnRemoteVideo.current = cb;
      },
    ),
    setOnRemoteVideoRemoved: vi.fn(),
    clearOnRemoteVideo: vi.fn(),
    setWsClient: vi.fn(),
    setServerHost: vi.fn(),
    setOnError: vi.fn(),
    leaveVoice: vi.fn(),
    setMuted: vi.fn(),
    setDeafened: vi.fn(),
    enableCamera: vi.fn().mockResolvedValue(undefined),
    disableCamera: vi.fn().mockResolvedValue(undefined),
    enableScreenshare: vi.fn().mockResolvedValue(undefined),
    disableScreenshare: vi.fn().mockResolvedValue(undefined),
    getLocalCameraStream: vi.fn(() => null),
    getLocalScreenshareStream: vi.fn(() => null),
    getRemoteVideoStats: vi.fn().mockResolvedValue(null),
    getLocalScreenshareStats: vi.fn().mockResolvedValue({ sentFps: 57 }),
    setRemoteVideoView: vi.fn(),
  };
}

export function mediaNotificationSoundMock() {
  return {
    startRingChime: vi.fn(),
    stopRingChime: vi.fn(),
    startRingback: vi.fn(),
    stopRingback: vi.fn(),
    cleanupNotificationAudio: vi.fn(),
    playVoiceSound: vi.fn(),
  };
}

// DP-24: the OS-level call alerts are a lazy chunk the page loads on a ring;
// their own behaviour is call-alerts.test.ts's.
export function messagesCallAlertsMock() {
  return {
    alertIncomingCall: vi.fn(),
    alertMissedCall: vi.fn(),
    alertSupersededCall: vi.fn(),
    clearIncomingCall: vi.fn(),
  };
}

export function updateNotifierMock() {
  return {
    createUpdateNotifier: mockCreateUpdateNotifier,
  };
}

export function voiceAudioElementsMock() {
  return {
    setAudioVolumeHost: mockSetAudioVolumeHost,
  };
}

export function presenceAutoIdleMock() {
  return {
    startAutoIdle: (options: { onStatusChange: (status: string) => void }) => {
      capturedAutoIdleOptions.current = options;
      return autoIdleController;
    },
  };
}

export async function listAttachmentsMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/components/message-list/attachments")>()),
    pruneAttachmentCacheScope: mockPruneAttachmentCacheScope,
  };
}

export function pageChannelControllerMock() {
  return {
    createChannelController: (...args: unknown[]) => {
      mockCreateChannelController(...args);
      return {
        mountChannel: mockMountChannel,
        destroyChannel: mockDestroyChannel,
        destroy: () => mockDestroyChannel(),
        openFilePicker: vi.fn(),
        currentChannelId: 0,
        messageList: null,
      };
    },
  };
}

export function pageSidebarAreaMock() {
  return {
    createSidebarArea: (...args: unknown[]) => {
      mockCreateSidebarArea(...args);
      const sidebarWrapper = document.createElement("div");
      sidebarWrapper.className = "unified-sidebar";
      // One stand-in member list per panel: the factory both hosts share.
      const buildMemberPanel = () => {
        const element = document.createElement("div");
        element.dataset["testid"] = "member-list";
        memberPanels.created += 1;
        memberPanels.events.push("create");
        let destroyed = false;
        return {
          element,
          destroy: () => {
            if (destroyed) return;
            destroyed = true;
            memberPanels.destroyed += 1;
            memberPanels.events.push("destroy");
            element.remove();
          },
        };
      };
      // The left section as the real SidebarArea runs it: present in channels
      // mode with the "left" layout, added and removed in place.
      let leftPanel: ReturnType<typeof buildMemberPanel> | null = null;
      const syncMemberSection = () => {
        const left = localStorage.getItem("owncord:settings:memberListLayout") === '"left"';
        if (left && leftPanel === null) {
          leftPanel = buildMemberPanel();
          sidebarWrapper.appendChild(leftPanel.element);
        } else if (!left && leftPanel !== null) {
          leftPanel.destroy();
          leftPanel = null;
        }
      };
      syncMemberSection();
      return {
        sidebarWrapper,
        children: [],
        unsubscribers: [() => leftPanel?.destroy()],
        openQuickSwitch: vi.fn(),
        openDm: vi.fn(),
        rememberChannel: mockRememberChannel,
        forgetChannel: vi.fn(),
        returnToChannel: mockReturnToChannel,
        buildMemberPanel,
        syncMemberSection,
        renameGroup: mockRenameGroup,
      };
    },
  };
}

// B9-4: one inert destination, so the page's navigation wiring can be driven.
export function navigationDestinationsMock() {
  return {
    NAVIGATION_DESTINATIONS: {
      moderation: {
        build: (ctx: { signal: AbortSignal }) => {
          inertModeration.signals.push(ctx.signal);
          const el = document.createElement("div");
          el.dataset["testid"] = "inert-moderation";
          return el;
        },
      },
    },
  };
}

export function pageChatAreaMock() {
  return {
    createChatArea: (...args: unknown[]) => {
      mockCreateChatArea(...args);
      const slots = {
        messagesSlot: document.createElement("div"),
        typingSlot: document.createElement("div"),
        inputSlot: document.createElement("div"),
        videoGridSlot: document.createElement("div"),
      };
      const dmProfileSlot = document.createElement("div");
      const profileBtn = document.createElement("button");
      const videoGrid = {
        addStream: vi.fn(),
        removeStream: vi.fn(),
        clearStreams: vi.fn(),
        watch: vi.fn(),
        hasStreams: vi.fn(() => false),
        setFocusedTile: vi.fn(),
        getFocusedTileId: vi.fn(() => null),
        setLabel: vi.fn(),
        setPeople: vi.fn(),
        setSpeaking: vi.fn(),
        setCallbacks: vi.fn(),
        setCallState: vi.fn(),
        setExitVisible: vi.fn(),
        ensureLoaded: vi.fn(),
        showMiniPlayer: vi.fn(),
        hideMiniPlayer: vi.fn(),
        raiseCallPopout: vi.fn(() => false),
        mount: vi.fn(),
        destroy: vi.fn(),
      };
      const chatArea = document.createElement("div");
      const callPanelSlot = document.createElement("div");
      // The real chat column's order: the call panel, then the chat slots.
      chatArea.append(
        callPanelSlot,
        slots.messagesSlot,
        slots.typingSlot,
        slots.inputSlot,
        slots.videoGridSlot,
      );
      capturedChatAreaRef.current = { chatArea, slots, dmProfileSlot, profileBtn, videoGrid };
      return {
        chatArea,
        slots,
        callPanelSlot,
        threadSlot: document.createElement("div"),
        videoGrid,
        chatHeaderName: document.createElement("span"),
        chatHeaderRefs: {
          hashEl: document.createElement("span"),
          nameEl: document.createElement("span"),
          topicEl: document.createElement("span"),
          callBtn: document.createElement("button"),
          profileBtn,
          memberListBtn: document.createElement("button"),
          callChatBtn: document.createElement("button"),
          sidebarToggle: document.createElement("button"),
        },
        sidebarToggle: document.createElement("button"),
        closePinnedPanel: vi.fn(),
        searchCtrl: { open: vi.fn(), cleanup: vi.fn() },
        dmProfileSlot,
        children: [],
        unsubscribers: [],
      };
    },
  };
}
