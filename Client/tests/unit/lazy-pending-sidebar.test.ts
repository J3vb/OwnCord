/**
 * The sidebar's Create Channel and new-DM picker load on first use (O-6a).
 * A click inside the load window, a failed import and a teardown before the
 * code arrives. The first test for each modal is the failing one: a loaded
 * module stays loaded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  failCreate: { value: true },
  failPicker: { value: true },
  createModal: vi.fn(),
  createPicker: vi.fn(),
}));

vi.mock("@components/CreateChannelModal", () => {
  if (h.failCreate.value) {
    h.failCreate.value = false;
    throw new Error("chunk load failed");
  }
  return { createCreateChannelModal: h.createModal };
});
vi.mock("../../src/pages/main-page/MemberPickerModal", () => {
  if (h.failPicker.value) {
    h.failPicker.value = false;
    throw new Error("chunk load failed");
  }
  return { createMemberPickerModal: h.createPicker };
});

vi.mock("@lib/livekitSession", () => ({
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
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getLogBuffer: () => [],
  clearLogBuffer: vi.fn(),
  addLogListener: () => () => {},
  setLogLevel: vi.fn(),
}));

vi.mock("@lib/toast", () => ({
  showToast: vi.fn(),
}));

vi.mock("@lib/profiles", () => ({
  createProfileManager: vi.fn().mockReturnValue({
    loadProfiles: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockReturnValue([]),
    store: { getState: () => ({ profiles: [], healthStatuses: new Map() }) },
  }),
  createTauriBackend: vi.fn().mockReturnValue({}),
}));

vi.mock("@components/ChannelSidebar", () => ({
  createChannelSidebar: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("@components/DmSidebar", () => ({
  createDmSidebar: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("@components/MemberList", () => ({
  createMemberList: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("@components/UserBar", () => ({
  createUserBar: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("@components/VoiceWidget", () => ({
  createVoiceWidget: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("@components/QuickSwitchOverlay", () => ({
  createQuickSwitchOverlay: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

const mockOpenUrl = vi.fn(async (_url: string) => {});
// The opener is the `open_external_url` command; `mockOpenUrl` records its URL.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: { url: string }) => {
    if (command !== "open_external_url") throw new Error(`unexpected invoke ${command}`);
    return mockOpenUrl(args!.url);
  },
}));

vi.mock("@components/EditChannelModal", () => ({
  createEditChannelModal: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("@components/DeleteChannelModal", () => ({
  createDeleteChannelModal: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("../../src/pages/main-page/VoiceCallbacks", () => ({
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
}));

vi.mock("../../src/pages/main-page/OverlayManagers", () => ({
  createInviteManagerController: vi.fn().mockReturnValue({
    open: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
  }),
}));

import { createSidebarArea, type SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";
import { setSidebarMode } from "../../src/stores/ui.store";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createDmSidebar } from "@components/DmSidebar";
import { showToast } from "@lib/toast";
import { shellText } from "../../src/i18n/shell";

type Callbacks = Record<string, (...args: unknown[]) => void>;
const lastArgs = (fn: unknown): Callbacks => {
  const calls = (fn as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1]![0] as Callbacks;
};

function defaultOpts(): SidebarAreaOptions {
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

describe("SidebarArea modals during their load", () => {
  let container: HTMLDivElement;
  let result: ReturnType<typeof createSidebarArea>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    h.createModal.mockReset().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
    h.createPicker.mockReset().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
    vi.mocked(showToast).mockClear();
  });
  afterEach(() => {
    for (const unsub of result.unsubscribers) unsub();
    setSidebarMode("channels");
    container.remove();
  });

  function build(mode: "channels" | "dms"): void {
    setSidebarMode(mode);
    result = createSidebarArea(defaultOpts());
    container.appendChild(result.sidebarWrapper);
  }

  describe("Create Channel", () => {
    it("a failed import toasts and leaves the button usable on the next click", async () => {
      build("channels");
      lastArgs(createChannelSidebar).onCreateChannel!("General");
      await vi.waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(shellText("common.openFailed"), "error");
      });
      expect(h.createModal).not.toHaveBeenCalled();

      lastArgs(createChannelSidebar).onCreateChannel!("General");
      await vi.waitFor(() => {
        expect(h.createModal).toHaveBeenCalledOnce();
      });
    });

    it("a double click before the code arrives mounts one dialog", async () => {
      build("channels");
      const args = lastArgs(createChannelSidebar);
      args.onCreateChannel!("General");
      args.onCreateChannel!("General");
      await vi.dynamicImportSettled();
      expect(h.createModal).toHaveBeenCalledOnce();
    });

    it("tearing the sidebar down before the code arrives mounts nothing", async () => {
      build("channels");
      lastArgs(createChannelSidebar).onCreateChannel!("General");
      for (const unsub of result.unsubscribers) unsub();
      await vi.dynamicImportSettled();
      expect(h.createModal).not.toHaveBeenCalled();
    });
  });

  describe("new DM picker", () => {
    it("a failed import toasts and leaves the button usable on the next click", async () => {
      build("dms");
      lastArgs(createDmSidebar).onNewDm!();
      await vi.waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(shellText("common.openFailed"), "error");
      });
      expect(h.createPicker).not.toHaveBeenCalled();

      lastArgs(createDmSidebar).onNewDm!();
      await vi.waitFor(() => {
        expect(h.createPicker).toHaveBeenCalledOnce();
      });
    });

    it("a double click before the code arrives mounts one picker", async () => {
      build("dms");
      const args = lastArgs(createDmSidebar);
      args.onNewDm!();
      args.onNewDm!();
      await vi.dynamicImportSettled();
      expect(h.createPicker).toHaveBeenCalledOnce();
    });

    it("tearing the sidebar down before the code arrives mounts nothing", async () => {
      build("dms");
      lastArgs(createDmSidebar).onNewDm!();
      for (const unsub of result.unsubscribers) unsub();
      await vi.dynamicImportSettled();
      expect(h.createPicker).not.toHaveBeenCalled();
    });
  });
});
