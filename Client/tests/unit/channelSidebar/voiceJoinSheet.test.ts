import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { usePhone } from "../../helpers/phoneMedia";
import * as mocks from "../../helpers/channelSidebarMocks";
import { createChannelSidebar } from "../../../src/components/ChannelSidebar";
import { channelsStore, setChannels } from "../../../src/stores/channels.store";
import { uiStore } from "../../../src/stores/ui.store";
import { setActiveTimeout } from "../../../src/features/safety/store";
import { voiceStore, updateVoiceState, removeVoiceUser } from "../../../src/stores/voice.store";
import { closeBottomSheet } from "../../../src/lib/ui/bottomSheet";
import { resetStores, addVoiceUser, testChannels } from "../../helpers/channelSidebarHarness";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/net/e2eeCrypto", (importOriginal) => mocks.netE2eeCryptoMock(importOriginal));
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/features/profiles/openUserProfilePopup", () =>
  mocks.profilesOpenUserProfilePopupMock(),
);

const VOICE = 3;

/** history.back() lands its popstate on a later task in jsdom. */
async function settleHistory(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const sheet = (): HTMLElement | null => document.querySelector('[data-testid="voice-join-sheet"]');
const joinBtn = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-testid="join-sheet-join"]')!;
const flush = (): void => {
  voiceStore.flush();
  channelsStore.flush();
  uiStore.flush();
};

describe("ChannelSidebar join sheet", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let onVoiceJoin: Mock<(channelId: number) => void>;
  let onOpenCall: Mock<() => void>;

  /** The sheet's code loads on the first tap; wait for it to open. */
  async function tapVoiceChannel(): Promise<void> {
    (container.querySelector(`[data-channel-id="${VOICE}"]`) as HTMLElement).click();
    await vi.dynamicImportSettled();
    for (let i = 0; i < 3; i++) await Promise.resolve();
  }

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    onVoiceJoin = vi.fn<(channelId: number) => void>();
    onOpenCall = vi.fn<() => void>();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
    setChannels(testChannels);
    sidebar.mount(container);
  });

  afterEach(async () => {
    closeBottomSheet();
    await settleHistory();
    sidebar.destroy?.();
    container.remove();
    vi.unstubAllGlobals();
    setActiveTimeout(null);
  });

  describe("on a phone", () => {
    beforeEach(usePhone);

    it("opens a sheet with the channel and who is in it, and does not join", async () => {
      addVoiceUser(VOICE, 30, "alice");
      addVoiceUser(VOICE, 31, "bob");
      await tapVoiceChannel();

      expect(onVoiceJoin).not.toHaveBeenCalled();
      expect(sheet()).not.toBeNull();
      expect(sheet()?.textContent).toContain("voice-lobby");
      expect(document.querySelector('[data-testid="join-sheet-count"]')?.textContent).toBe(
        "2 people in here",
      );
      const names = [...document.querySelectorAll(".js-person .js-name")].map(
        (el) => el.textContent,
      );
      expect(names).toEqual(["alice", "bob"]);
    });

    it("says no one is here for an empty channel", async () => {
      await tapVoiceChannel();
      expect(document.querySelector('[data-testid="join-sheet-count"]')?.textContent).toBe(
        "No one is here yet",
      );
    });

    it("marks muted, camera and sharing people", async () => {
      updateVoiceState({
        channel_id: VOICE,
        user_id: 30,
        username: "alice",
        muted: true,
        deafened: false,
        speaking: false,
        camera: true,
        screenshare: true,
      });
      await tapVoiceChannel();
      const labels = [...document.querySelectorAll(".js-person .js-marker")].map((el) =>
        el.getAttribute("aria-label"),
      );
      expect(labels).toEqual(["Camera on", "LIVE", "Muted"]);
    });

    it("Join joins the channel and closes the sheet", async () => {
      await tapVoiceChannel();
      joinBtn().click();
      expect(onVoiceJoin).toHaveBeenCalledExactlyOnceWith(VOICE);
      expect(sheet()).toBeNull();
    });

    it("Cancel closes the sheet without joining", async () => {
      await tapVoiceChannel();
      (document.querySelector('[data-testid="join-sheet-cancel"]') as HTMLElement).click();
      expect(sheet()).toBeNull();
      expect(onVoiceJoin).not.toHaveBeenCalled();
    });

    it("the joined channel still opens the call, with no sheet", async () => {
      voiceStore.setState((prev) => ({
        ...prev,
        currentChannelId: VOICE,
        voiceStatus: "connected",
      }));
      voiceStore.flush();
      await tapVoiceChannel();
      expect(onOpenCall).toHaveBeenCalledOnce();
      expect(sheet()).toBeNull();
    });

    it("opens no sheet while the socket is down or a timeout is on", async () => {
      uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
      uiStore.flush();
      await tapVoiceChannel();
      expect(sheet()).toBeNull();

      uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
      uiStore.flush();
      setActiveTimeout(new Date(Date.now() + 3_600_000).toISOString());
      await tapVoiceChannel();
      expect(sheet()).toBeNull();
      expect(onVoiceJoin).not.toHaveBeenCalled();
    });

    it("the list follows people who join and leave while it is open", async () => {
      await tapVoiceChannel();
      addVoiceUser(VOICE, 30, "alice");
      flush();
      expect(document.querySelectorAll(".js-person").length).toBe(1);
      expect(document.querySelector('[data-testid="join-sheet-count"]')?.textContent).toBe(
        "1 person in here",
      );

      removeVoiceUser({ channel_id: VOICE, user_id: 30 });
      flush();
      expect(document.querySelectorAll(".js-person").length).toBe(0);
      expect(document.querySelector('[data-testid="join-sheet-count"]')?.textContent).toBe(
        "No one is here yet",
      );
    });

    it("holds Join back when the socket drops, and frees it when it returns", async () => {
      await tapVoiceChannel();
      expect(joinBtn().disabled).toBe(false);

      uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
      flush();
      expect(joinBtn().disabled).toBe(true);
      expect(document.querySelector(".js-note")?.textContent).toBe("Reconnecting…");
      joinBtn().click();
      expect(onVoiceJoin).not.toHaveBeenCalled();
      expect(sheet()).not.toBeNull();

      uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
      flush();
      expect(joinBtn().disabled).toBe(false);
      joinBtn().click();
      expect(onVoiceJoin).toHaveBeenCalledExactlyOnceWith(VOICE);
    });

    it("does not join through a click that lands after the socket dropped", async () => {
      await tapVoiceChannel();
      // The store has changed but its subscribers have not been told yet.
      uiStore.setState((prev) => ({ ...prev, connectionStatus: "disconnected" }));
      joinBtn().click();
      expect(onVoiceJoin).not.toHaveBeenCalled();
    });

    it("closes when the channel is deleted under it", async () => {
      await tapVoiceChannel();
      channelsStore.setState((prev) => {
        const channels = new Map(prev.channels);
        channels.delete(VOICE);
        return { ...prev, channels };
      });
      flush();
      expect(sheet()).toBeNull();
    });

    it("opens nothing when the sidebar goes away while the sheet's code loads", async () => {
      (container.querySelector(`[data-channel-id="${VOICE}"]`) as HTMLElement).click();
      sidebar.destroy?.();
      await vi.dynamicImportSettled();
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(sheet()).toBeNull();
      expect(onVoiceJoin).not.toHaveBeenCalled();
    });

    it("closes when the sidebar is destroyed", async () => {
      await tapVoiceChannel();
      sidebar.destroy?.();
      expect(sheet()).toBeNull();
    });
  });

  describe("on a desktop", () => {
    it("joins at once and opens no sheet", async () => {
      await tapVoiceChannel();
      expect(onVoiceJoin).toHaveBeenCalledExactlyOnceWith(VOICE);
      expect(sheet()).toBeNull();
    });
  });
});
