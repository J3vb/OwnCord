import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import * as mocks from "../../helpers/channelControllerMocks";
import { createChannelController } from "../../../src/pages/main-page/ChannelController";
import type { ChannelControllerOptions } from "../../../src/pages/main-page/ChannelController";
import {
  channelsStore,
  setChannels,
  updateChannel,
  setNsfwAcknowledged,
} from "@stores/channels.store";
import { createMessageList } from "@components/MessageList";
import { makeOpts, useChannelControllerHarness } from "../../helpers/channelControllerHarness";

vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/dom", () => mocks.domMock());
vi.mock("@components/MessageList", () => mocks.messageListMock());
vi.mock("@components/MessageInput", () => mocks.messageInputMock());
vi.mock("@components/NsfwGate", () => mocks.nsfwGateMock());
vi.mock("@components/TypingIndicator", () => mocks.typingIndicatorMock());
vi.mock("@lib/readState", () => mocks.readStateMock());
vi.mock("@stores/messages.store", () => mocks.messagesStoreMock());
vi.mock("@lib/nav/messageNavigation", () => mocks.navMessageNavigationMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());
vi.mock("../../../src/pages/main-page/ChatHeader", (importOriginal) =>
  mocks.pageChatHeaderMock(importOriginal),
);
vi.mock("@stores/dm.store", () => mocks.dmStoreMock());
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("@stores/members.store", () => mocks.membersStoreMock());
vi.mock("@stores/blocks.store", () => mocks.blocksStoreMock());
vi.mock("../../../src/pages/main-page/ThreadPanelHost", () => mocks.pageThreadPanelHostMock());

const {
  mockMessageListMount,
  mockMessageListDestroy,
  mockMessageInputMount,
  mockMessageInputDestroy,
  mockTypingMount,
  mockNsfwGateMount,
  mockNsfwGateDestroy,
  mockCreateNsfwGate,
  capturedNsfwOpts,
  mockConsentBarMount,
  mockConsentBarDestroy,
  capturedBarOpts,
  mockClearChannelContent,
} = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChannelController", () => {
  useChannelControllerHarness();

  // ─── NSFW consent gate (B9-7) ─────────────────────────────────────────────

  describe("NSFW consent gate", () => {
    // Earlier tests leave controllers mounted on the shared store; an id none
    // of them uses keeps their subscriptions out of these counts.
    const CH = 4242;

    function seedChannel(nsfw: boolean, acknowledged?: boolean): void {
      setChannels([
        {
          id: CH,
          name: "spicy",
          type: "text",
          category: null,
          position: 0,
          can_send: true,
          nsfw,
          ...(acknowledged === undefined ? {} : { nsfw_acknowledged: acknowledged }),
        },
      ]);
    }

    function consentOpts(api: Record<string, unknown> = {}) {
      return makeOpts({
        api: {
          uploadFile: vi.fn(),
          gifFavorites: vi.fn().mockResolvedValue({ favorites: [] }),
          acknowledgeNsfw: vi.fn().mockResolvedValue(undefined),
          revokeNsfw: vi.fn().mockResolvedValue(undefined),
          ...api,
        } as unknown as ChannelControllerOptions["api"],
      });
    }

    /**
     * The store notifies subscribers in a microtask, and the gate and withdraw
     * bar come from a lazily imported module: let both land.
     */
    async function settle(): Promise<void> {
      await Promise.resolve();
      channelsStore.flush();
      await Promise.resolve();
      await vi.dynamicImportSettled();
      await Promise.resolve();
    }

    // The first import of the (mocked) lazy module resolves after its async
    // factory; load it once so every test measures the controller, not that.
    beforeAll(async () => {
      await import("@components/NsfwGate");
    });

    beforeEach(() => {
      mockCreateNsfwGate.mockClear();
      mockNsfwGateMount.mockClear();
      mockNsfwGateDestroy.mockClear();
      mockConsentBarMount.mockClear();
      mockConsentBarDestroy.mockClear();
      capturedNsfwOpts.value = null;
      capturedBarOpts.value = null;
    });

    it("mounts content and no consent UI for an unlabelled channel", async () => {
      seedChannel(false);
      const opts = consentOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();
      expect(mockCreateNsfwGate).not.toHaveBeenCalled();
      expect(capturedBarOpts.value).toBeNull();
      expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(CH, expect.anything());
      ctrl.destroyChannel();
    });

    it("mounts only the gate for an unacknowledged channel: no content, no fetch", async () => {
      seedChannel(true);
      const opts = consentOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();

      expect(mockCreateNsfwGate).toHaveBeenCalledTimes(1);
      expect(capturedNsfwOpts.value.channelName).toBe("spicy");
      expect(mockNsfwGateMount).toHaveBeenCalledWith(opts.slots.messagesSlot);
      expect(opts.msgCtrl.loadMessages).not.toHaveBeenCalled();
      expect(createMessageList).not.toHaveBeenCalled();
      expect(mockTypingMount).not.toHaveBeenCalled();
      expect(mockMessageInputMount).not.toHaveBeenCalled();
      // Rows left from before consent was withdrawn cannot render later.
      expect(mockClearChannelContent).toHaveBeenCalledWith(CH);
      // The header still names the channel the reader is in.
      expect(opts.chatHeaderName?.textContent).toBe("spicy");
      ctrl.destroyChannel();
    });

    it("treats a labelled channel with no acknowledgement field as gated", async () => {
      seedChannel(true, undefined);
      const ctrl = createChannelController(consentOpts());
      ctrl.mountChannel(CH, "spicy");
      await settle();
      expect(mockCreateNsfwGate).toHaveBeenCalledTimes(1);
      ctrl.destroyChannel();
    });

    it("opens the channel only after the server confirms the acknowledgement", async () => {
      seedChannel(true, false);
      let confirm!: () => void;
      const acknowledgeNsfw = vi.fn(() => new Promise<void>((r) => (confirm = r)));
      const opts = consentOpts({ acknowledgeNsfw });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();

      const accepted = capturedNsfwOpts.value.onAccept();
      await settle();
      expect(acknowledgeNsfw).toHaveBeenCalledWith(CH);
      expect(opts.msgCtrl.loadMessages).not.toHaveBeenCalled();

      confirm();
      await accepted;
      await settle();

      expect(mockNsfwGateDestroy).toHaveBeenCalled();
      expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(CH, expect.anything());
      expect(mockMessageListMount).toHaveBeenCalledWith(opts.slots.messagesSlot);
      expect(mockConsentBarMount).toHaveBeenCalledWith(opts.slots.messagesSlot);
      expect(ctrl.currentChannelId).toBe(CH);
      ctrl.destroyChannel();
    });

    it("keeps the channel gated when the acknowledgement fails", async () => {
      seedChannel(true, false);
      const opts = consentOpts({
        acknowledgeNsfw: vi.fn().mockRejectedValue(new Error("offline")),
      });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();

      await expect(capturedNsfwOpts.value.onAccept()).rejects.toThrow("offline");
      await settle();

      expect(channelsStore.getState().channels.get(CH)?.nsfwAcknowledged).toBe(false);
      expect(opts.msgCtrl.loadMessages).not.toHaveBeenCalled();
      expect(mockNsfwGateDestroy).not.toHaveBeenCalled();
      ctrl.destroyChannel();
    });

    it("leaves the channel when the reader declines", async () => {
      seedChannel(true);
      const ctrl = createChannelController(consentOpts());
      ctrl.mountChannel(CH, "spicy");
      await settle();

      capturedNsfwOpts.value.onCancel();

      expect(ctrl.currentChannelId).toBeNull();
      expect(channelsStore.getState().activeChannelId).toBeNull();
    });

    it("mounts an acknowledged channel directly, with the withdraw bar", async () => {
      seedChannel(true, true);
      const opts = consentOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();

      expect(mockCreateNsfwGate).not.toHaveBeenCalled();
      expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(CH, expect.anything());
      expect(mockConsentBarMount).toHaveBeenCalledWith(opts.slots.messagesSlot);
      ctrl.destroyChannel();
    });

    it("withdrawing consent unmounts the content and puts the gate back", async () => {
      seedChannel(true, true);
      const opts = consentOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();
      const firstSignal = vi.mocked(opts.msgCtrl.loadMessages).mock.calls[0]![1];

      await capturedBarOpts.value.onRevoke();
      await settle();

      expect(opts.api.revokeNsfw).toHaveBeenCalledWith(CH);
      expect(firstSignal.aborted).toBe(true);
      expect(mockMessageListDestroy).toHaveBeenCalled();
      expect(mockConsentBarDestroy).toHaveBeenCalled();
      expect(mockCreateNsfwGate).toHaveBeenCalledTimes(1);
      expect(mockClearChannelContent).toHaveBeenCalledWith(CH);
      expect(ctrl.currentChannelId).toBe(CH);
      ctrl.destroyChannel();
    });

    it("keeps the content and says so when withdrawing fails", async () => {
      seedChannel(true, true);
      const opts = consentOpts({ revokeNsfw: vi.fn().mockRejectedValue(new Error("offline")) });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();

      await capturedBarOpts.value.onRevoke();
      await settle();

      expect(opts.showToast).toHaveBeenCalledWith(
        "Consent could not be withdrawn. Try again.",
        "error",
      );
      expect(mockCreateNsfwGate).not.toHaveBeenCalled();
      ctrl.destroyChannel();
    });

    it("regates on a revoke from another device, a relabel, and a reconnect's ready", async () => {
      seedChannel(true, true);
      const ctrl = createChannelController(consentOpts());
      ctrl.mountChannel(CH, "spicy");
      await settle();

      setNsfwAcknowledged(CH, false); // nsfw_ack from a second device
      await settle();
      expect(mockCreateNsfwGate).toHaveBeenCalledTimes(1);

      seedChannel(true, true); // reconnect: ready restates the acknowledgement
      await settle();
      expect(mockNsfwGateDestroy).toHaveBeenCalledTimes(1);

      updateChannel({ id: CH, nsfw: false });
      updateChannel({ id: CH, nsfw: true }); // relabelled: consent was dropped
      await settle();
      expect(mockCreateNsfwGate).toHaveBeenCalledTimes(2);
      ctrl.destroyChannel();
    });

    it("closes the content overlays when the mounted channel falls behind the gate", async () => {
      seedChannel(true, true);
      const onContentGated = vi.fn();
      const ctrl = createChannelController({ ...consentOpts(), onContentGated });
      ctrl.mountChannel(CH, "spicy");
      await settle();

      setNsfwAcknowledged(CH, false); // revoked on another device
      await settle();
      expect(onContentGated).toHaveBeenCalledTimes(1);

      setNsfwAcknowledged(CH, true); // consenting again opens, nothing to close
      await settle();
      expect(onContentGated).toHaveBeenCalledTimes(1);

      updateChannel({ id: CH, nsfw: false });
      await settle();
      expect(onContentGated).toHaveBeenCalledTimes(1);

      updateChannel({ id: CH, nsfw: true }); // labelled while in view
      await settle();
      expect(onContentGated).toHaveBeenCalledTimes(2);
      ctrl.destroyChannel();
    });

    it("drops the withdraw bar when the label is removed from a consented channel", async () => {
      seedChannel(true, true);
      const opts = consentOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();
      expect(mockConsentBarMount).toHaveBeenCalledTimes(1);

      updateChannel({ id: CH, nsfw: false });
      await settle();

      expect(mockConsentBarDestroy).toHaveBeenCalledTimes(1);
      expect(mockConsentBarMount).toHaveBeenCalledTimes(1);
      expect(mockCreateNsfwGate).not.toHaveBeenCalled();
      expect(mockMessageListMount).toHaveBeenLastCalledWith(opts.slots.messagesSlot);
      expect(ctrl.currentChannelId).toBe(CH);
      ctrl.destroyChannel();
    });

    it("keeps the composer and its draft when a consented channel's label changes", async () => {
      seedChannel(true, true);
      const opts = consentOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();
      mockMessageInputDestroy.mockClear();
      mockMessageListDestroy.mockClear();
      const listMounts = mockMessageListMount.mock.calls.length;
      const inputMounts = mockMessageInputMount.mock.calls.length;

      updateChannel({ id: CH, nsfw: false });
      await settle();
      seedChannel(true, true); // a reconnect's ready restates label and consent
      await settle();

      expect(mockMessageInputDestroy).not.toHaveBeenCalled();
      expect(mockMessageListDestroy).not.toHaveBeenCalled();
      expect(mockMessageListMount).toHaveBeenCalledTimes(listMounts);
      expect(mockMessageInputMount).toHaveBeenCalledTimes(inputMounts);
      expect(opts.msgCtrl.loadMessages).toHaveBeenCalledTimes(1);
      expect(mockConsentBarMount).toHaveBeenCalledTimes(2);
      ctrl.destroyChannel();
    });

    it("moves focus out of the gate once an acknowledgement opens the channel", async () => {
      seedChannel(true, false);
      const focusFallback = vi.fn();
      const opts = { ...consentOpts(), focusFallback };
      document.body.appendChild(opts.slots.messagesSlot);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();
      const continueBtn = document.createElement("button");
      opts.slots.messagesSlot.appendChild(continueBtn);
      continueBtn.focus();

      await capturedNsfwOpts.value.onAccept();
      await settle();

      expect(focusFallback).toHaveBeenCalledTimes(1);
      ctrl.destroyChannel();
      opts.slots.messagesSlot.remove();
    });

    it("leaves focus alone when another device opens a gate the reader is not on", async () => {
      seedChannel(true, false);
      const focusFallback = vi.fn();
      const opts = { ...consentOpts(), focusFallback };
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();

      setNsfwAcknowledged(CH, true);
      await settle();
      setNsfwAcknowledged(CH, false);
      await settle();

      expect(focusFallback).not.toHaveBeenCalled();
      ctrl.destroyChannel();
    });

    it("lets the gate take focus when the reader opens the channel", async () => {
      seedChannel(true, false);
      const ctrl = createChannelController(consentOpts());
      ctrl.mountChannel(CH, "spicy");
      await settle();

      expect(capturedNsfwOpts.value.focusOnMount).toBe(true);
      ctrl.destroyChannel();
    });

    it("keeps focus in an open dialog when another device withdraws consent", async () => {
      seedChannel(true, true);
      const opts = consentOpts();
      document.body.appendChild(opts.slots.messagesSlot);
      const dialogBtn = document.createElement("button");
      document.body.appendChild(dialogBtn);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();
      dialogBtn.focus();

      setNsfwAcknowledged(CH, false); // nsfw_ack from a second device
      await settle();

      expect(mockCreateNsfwGate).toHaveBeenCalledTimes(1);
      expect(capturedNsfwOpts.value.focusOnMount).toBe(false);
      expect(document.activeElement).toBe(dialogBtn);
      ctrl.destroyChannel();
      dialogBtn.remove();
      opts.slots.messagesSlot.remove();
    });

    it("lets the gate take focus from the composer when another device withdraws consent", async () => {
      seedChannel(true, true);
      const opts = consentOpts();
      document.body.appendChild(opts.slots.inputSlot);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();
      const composer = document.createElement("textarea");
      opts.slots.inputSlot.appendChild(composer);
      composer.focus();

      setNsfwAcknowledged(CH, false); // nsfw_ack from a second device
      await settle();

      expect(mockCreateNsfwGate).toHaveBeenCalledTimes(1);
      expect(capturedNsfwOpts.value.focusOnMount).toBe(true);
      ctrl.destroyChannel();
      opts.slots.inputSlot.remove();
    });

    it("lets the gate take focus when the reader withdraws from the bar", async () => {
      seedChannel(true, true);
      const opts = consentOpts();
      document.body.appendChild(opts.slots.messagesSlot);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      await settle();
      const revokeBtn = document.createElement("button");
      opts.slots.messagesSlot.appendChild(revokeBtn);
      revokeBtn.focus();

      await capturedBarOpts.value.onRevoke();
      await settle();

      expect(mockCreateNsfwGate).toHaveBeenCalledTimes(1);
      expect(capturedNsfwOpts.value.focusOnMount).toBe(true);
      ctrl.destroyChannel();
      opts.slots.messagesSlot.remove();
    });

    it("moves focus somewhere reachable after the reader declines", async () => {
      seedChannel(true);
      const focusFallback = vi.fn(() => {
        expect(channelsStore.getState().activeChannelId).toBeNull();
      });
      const ctrl = createChannelController({ ...consentOpts(), focusFallback });
      ctrl.mountChannel(CH, "spicy");
      await settle();

      capturedNsfwOpts.value.onCancel();

      expect(focusFallback).toHaveBeenCalledTimes(1);
    });

    it("never mounts a gate whose lazy load lands after the channel was left", async () => {
      seedChannel(true);
      const opts = consentOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(CH, "spicy");
      ctrl.destroyChannel();
      await settle();

      expect(mockNsfwGateMount).not.toHaveBeenCalled();
      expect(opts.msgCtrl.loadMessages).not.toHaveBeenCalled();
    });

    it("destroys an unaccepted gate when the channel unmounts", async () => {
      seedChannel(true);
      const ctrl = createChannelController(consentOpts());
      ctrl.mountChannel(CH, "spicy");
      await settle();

      ctrl.destroyChannel();

      expect(mockNsfwGateDestroy).toHaveBeenCalled();
    });
  });
});
