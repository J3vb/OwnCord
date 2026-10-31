/**
 * The sidebar's Create Channel and new-DM picker load on first use (O-6a).
 * A click inside the load window, a failed import and a teardown before the
 * code arrives. The first test for each modal is the failing one: a loaded
 * module stays loaded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../helpers/sidebarAreaMocks";
import { defaultSidebarAreaOpts } from "../helpers/sidebarAreaOpts";
import * as voiceSession from "../helpers/voiceSessionMock";

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

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    switchInputDevice: vi.fn().mockResolvedValue(undefined),
    switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock("@lib/logger", () => mocks.loggerMock());

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());

vi.mock("@lib/presence/profiles", () => mocks.presenceProfilesMock());

vi.mock("@components/ChannelSidebar", () => mocks.channelSidebarMock());

vi.mock("@components/DmSidebar", () => mocks.dmSidebarMock());

vi.mock("@components/MemberList", () => mocks.memberListMock());

vi.mock("@components/UserBar", () => mocks.userBarMock());

vi.mock("@components/VoiceWidget", () => mocks.voiceWidgetMock());

vi.mock("@components/QuickSwitchOverlay", () => mocks.quickSwitchOverlayMock());

vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());

vi.mock("@components/EditChannelModal", () => mocks.editChannelModalMock());

vi.mock("@components/DeleteChannelModal", () => mocks.deleteChannelModalMock());

vi.mock("../../src/pages/main-page/VoiceCallbacks", () => mocks.pageVoiceCallbacksMock());

vi.mock("../../src/pages/main-page/OverlayManagers", () => mocks.pageOverlayManagersMock());

import { createSidebarArea } from "../../src/pages/main-page/SidebarArea";
import { setSidebarMode } from "../../src/stores/ui.store";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createDmSidebar } from "@components/DmSidebar";
import { showToast } from "@lib/ui/toast";
import { shellText } from "../../src/i18n/shell";

type Callbacks = Record<string, (...args: unknown[]) => void>;
const lastArgs = (fn: unknown): Callbacks => {
  const calls = (fn as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1]![0] as Callbacks;
};

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
    result = createSidebarArea(defaultSidebarAreaOpts());
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
