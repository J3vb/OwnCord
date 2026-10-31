import { vi } from "vitest";
import { loggerMock as sharedLoggerMock } from "./loggerMock";

export const mockOpenUrl = vi.fn(async (_url: string) => {});

export function voiceLivekitSessionMock() {
  return {
    leaveVoice: vi.fn(),
    switchInputDevice: vi.fn().mockResolvedValue(undefined),
    switchOutputDevice: vi.fn().mockResolvedValue(undefined),
    setVoiceSensitivity: vi.fn(),
    setInputVolume: vi.fn(),
    setOutputVolume: vi.fn(),
    reapplyAudioProcessing: vi.fn().mockResolvedValue(undefined),
    getSessionDebugInfo: vi.fn().mockReturnValue({}),
    setMuted: vi.fn(),
    setDeafened: vi.fn(),
    enableCamera: vi.fn().mockResolvedValue(undefined),
    disableCamera: vi.fn().mockResolvedValue(undefined),
    enableScreenshare: vi.fn().mockResolvedValue(undefined),
    disableScreenshare: vi.fn().mockResolvedValue(undefined),
  };
}

export function loggerMock() {
  return sharedLoggerMock({ buffer: true });
}

export function uiToastMock() {
  return {
    showToast: vi.fn(),
  };
}

export function presenceProfilesMock() {
  return {
    createProfileManager: vi.fn().mockReturnValue({
      loadProfiles: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockReturnValue([]),
      store: { getState: () => ({ profiles: [], healthStatuses: new Map() }) },
    }),
    createTauriBackend: vi.fn().mockReturnValue({}),
  };
}

export function channelSidebarMock() {
  return {
    createChannelSidebar: vi.fn().mockReturnValue({
      mount: vi.fn(),
      destroy: vi.fn(),
    }),
  };
}

export function dmSidebarMock() {
  return {
    createDmSidebar: vi.fn().mockReturnValue({
      mount: vi.fn(),
      destroy: vi.fn(),
      update: vi.fn(),
    }),
  };
}

export function memberListMock() {
  return {
    createMemberList: vi.fn().mockReturnValue({
      mount: vi.fn(),
      destroy: vi.fn(),
    }),
  };
}

export function userBarMock() {
  return {
    createUserBar: vi.fn().mockReturnValue({
      mount: vi.fn(),
      destroy: vi.fn(),
    }),
  };
}

export function voiceWidgetMock() {
  return {
    createVoiceWidget: vi.fn().mockReturnValue({
      mount: vi.fn(),
      destroy: vi.fn(),
    }),
  };
}

export function quickSwitchOverlayMock() {
  return {
    createQuickSwitchOverlay: vi.fn().mockReturnValue({
      mount: vi.fn(),
      destroy: vi.fn(),
    }),
  };
}

export function createChannelModalMock() {
  return {
    createCreateChannelModal: vi.fn().mockReturnValue({
      mount: vi.fn(),
      destroy: vi.fn(),
    }),
  };
}

// The opener is the `open_external_url` command; `mockOpenUrl` records its URL.
export function apiCoreMock() {
  return {
    invoke: async (command: string, args?: { url: string }) => {
      if (command !== "open_external_url") throw new Error(`unexpected invoke ${command}`);
      return mockOpenUrl(args!.url);
    },
  };
}

export function editChannelModalMock() {
  return {
    createEditChannelModal: vi.fn().mockReturnValue({
      mount: vi.fn(),
      destroy: vi.fn(),
    }),
  };
}

export function deleteChannelModalMock() {
  return {
    createDeleteChannelModal: vi.fn().mockReturnValue({
      mount: vi.fn(),
      destroy: vi.fn(),
    }),
  };
}

export function pageVoiceCallbacksMock() {
  return {
    createVoiceWidgetCallbacks: vi.fn().mockReturnValue({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    }),
    createSidebarVoiceCallbacks: vi.fn().mockReturnValue({
      onVoiceJoin: vi.fn(),
      onVoiceLeave: vi.fn(),
    }),
    createVoiceModerationCallbacks: vi.fn().mockReturnValue({
      onServerMute: vi.fn(),
      onServerDeafen: vi.fn(),
      onMove: vi.fn(),
      onDisconnect: vi.fn(),
    }),
  };
}

export function pageOverlayManagersMock() {
  return {
    createInviteManagerController: vi.fn().mockReturnValue({
      open: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    }),
  };
}
