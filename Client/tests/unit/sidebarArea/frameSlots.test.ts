import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/sidebarAreaMocks";
import { createVoiceWidget } from "../../../src/features/voice/VoiceWidget";
import { createUserBar } from "../../../src/features/voice/UserBar";
import { leaveVoiceChannel } from "../../../src/stores/voice.store";
import {
  MockedFn,
  getMockMount,
  enterVoiceAndAwaitWidget,
  cleanup,
  mountArea,
  useSidebarAreaHarness,
} from "../../helpers/sidebarAreaHarness";
import { joinVoiceChannel, voiceStore } from "../../../src/stores/voice.store";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/presence/profiles", () => mocks.presenceProfilesMock());
vi.mock("../../../src/features/channels/ChannelSidebar", () => mocks.channelSidebarMock());
vi.mock("../../../src/features/direct-messages/DmSidebar", () => mocks.dmSidebarMock());
vi.mock("../../../src/features/members/MemberList", () => mocks.memberListMock());
vi.mock("../../../src/features/voice/UserBar", () => mocks.userBarMock());
vi.mock("../../../src/features/voice/VoiceWidget", () => mocks.voiceWidgetMock());
vi.mock("../../../src/features/navigation/QuickSwitchOverlay", () =>
  mocks.quickSwitchOverlayMock(),
);
vi.mock("../../../src/features/channels/CreateChannelModal", () => mocks.createChannelModalMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("../../../src/features/channels/editChannelDialog", () => mocks.editChannelModalMock());
vi.mock("../../../src/features/channels/DeleteChannelModal", () => mocks.deleteChannelModalMock());
vi.mock("../../../src/pages/main-page/VoiceCallbacks", () => mocks.pageVoiceCallbacksMock());
vi.mock("../../../src/pages/main-page/OverlayManagers", () => mocks.pageOverlayManagersMock());

describe("SidebarArea frame slots", () => {
  let container: HTMLDivElement;

  useSidebarAreaHarness((c) => {
    container = c;
  });

  afterEach(() => {
    leaveVoiceChannel();
  });

  it("the two slots are the last two children of sidebarWrapper, voice widget then user bar", () => {
    const result = mountArea(container);
    const kids = Array.from(result.sidebarWrapper.children);
    expect(kids.slice(-2)).toEqual([result.frameSlots.voiceWidget, result.frameSlots.userBar]);
    expect(getMockMount(createUserBar as MockedFn)).toHaveBeenCalledWith(result.frameSlots.userBar);
    cleanup(result);
  });

  it("a slot moved before the lazy voice widget loads still receives the widget", async () => {
    const result = mountArea(container);
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    elsewhere.appendChild(result.frameSlots.voiceWidget);
    await enterVoiceAndAwaitWidget();
    expect(getMockMount(createVoiceWidget as MockedFn)).toHaveBeenCalledWith(
      result.frameSlots.voiceWidget,
    );
    expect(result.frameSlots.voiceWidget.parentElement).toBe(elsewhere);
    cleanup(result);
    elsewhere.remove();
  });

  it("a page torn down before the lazy voice widget loads mounts nothing", async () => {
    const result = mountArea(container);
    joinVoiceChannel(1);
    voiceStore.flush();
    cleanup(result);
    await vi.dynamicImportSettled();
    expect(createVoiceWidget as MockedFn).not.toHaveBeenCalled();
  });
});
