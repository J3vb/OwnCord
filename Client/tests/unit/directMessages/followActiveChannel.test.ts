/**
 * Under Command Deck, DM mode ends when a channel that is not a DM becomes the
 * open one (Client brief, D2). The rule reads nothing but the open channel id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Disposable } from "@lib/disposable";
import { followActiveChannel } from "../../../src/features/direct-messages/followActiveChannel";
import { handleDmChannelClose } from "../../../src/features/direct-messages/wsHandlers";
import { addDmChannel, addDmToChannelsStore, dmStore } from "../../../src/stores/dm.store";
import { channelsStore, setActiveChannel } from "../../../src/stores/channels.store";
import { setSidebarMode, uiStore } from "../../../src/stores/ui.store";
import { dmRecipient, makeDm, resetDmAndUiState } from "../../helpers/dmHarness";
import { resetChannelsState, makeChannelRow } from "../../helpers/storeSeeds";

const TEXT = 3;

function seedChannels(): void {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([[TEXT, makeChannelRow({ id: TEXT, name: "general", position: 1 })]]),
  }));
}

function openDm(channelId: number, extra: Parameters<typeof makeDm>[0] = {}): void {
  const dm = makeDm({
    channelId,
    recipient: dmRecipient(10 + channelId, `User${channelId}`),
    ...extra,
  });
  addDmChannel(dm);
  addDmToChannelsStore(dm);
}

const flush = (): void => {
  channelsStore.flush();
  uiStore.flush();
  dmStore.flush();
};

let owner: Disposable;
const modeAtForget: string[] = [];
const forget = vi.fn(() => {
  modeAtForget.push(uiStore.getState().sidebarMode);
});

beforeEach(() => {
  resetDmAndUiState();
  resetChannelsState();
  seedChannels();
  modeAtForget.length = 0;
  forget.mockClear();
  owner = new Disposable();
  followActiveChannel(owner, forget);
});

afterEach(() => {
  owner.destroy();
});

describe("followActiveChannel", () => {
  it("leaves DM mode when a text channel becomes active, then forgets the channel once", () => {
    openDm(100);
    setActiveChannel(100);
    setSidebarMode("dms");
    flush();

    setActiveChannel(TEXT);
    flush();

    expect(uiStore.getState().sidebarMode).toBe("channels");
    expect(forget).toHaveBeenCalledTimes(1);
    // The mode was already written when the channel was forgotten.
    expect(modeAtForget).toEqual(["channels"]);
  });

  it("stays in DM mode for a group DM, a null id and an id that is not in the store", () => {
    openDm(100);
    openDm(101, { isGroup: true });
    setActiveChannel(100);
    setSidebarMode("dms");
    flush();

    setActiveChannel(101);
    flush();
    setActiveChannel(null);
    flush();
    setActiveChannel(999);
    flush();

    expect(uiStore.getState().sidebarMode).toBe("dms");
    expect(forget).not.toHaveBeenCalled();
  });

  it("writes nothing while the sidebar is in channels mode", () => {
    const write = vi.spyOn(uiStore, "setState");
    setActiveChannel(TEXT);
    flush();
    expect(write).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("writes nothing after the owner is destroyed", () => {
    openDm(100);
    setActiveChannel(100);
    setSidebarMode("dms");
    flush();
    owner.destroy();

    setActiveChannel(TEXT);
    flush();

    expect(uiStore.getState().sidebarMode).toBe("dms");
    expect(forget).not.toHaveBeenCalled();
  });

  describe("a close from the server", () => {
    it("leaves DM mode when the last DM closes while it is open: the first text channel opens", () => {
      openDm(100);
      setActiveChannel(100);
      setSidebarMode("dms");
      flush();

      handleDmChannelClose({ channel_id: 100 });
      flush();

      expect(channelsStore.getState().activeChannelId).toBe(TEXT);
      expect(uiStore.getState().sidebarMode).toBe("channels");
      expect(forget).toHaveBeenCalledTimes(1);
    });

    it("stays in DM mode when another DM is left to open", () => {
      openDm(100);
      openDm(101);
      setActiveChannel(100);
      setSidebarMode("dms");
      flush();

      handleDmChannelClose({ channel_id: 100 });
      flush();

      expect(channelsStore.getState().activeChannelId).toBe(101);
      expect(uiStore.getState().sidebarMode).toBe("dms");
      expect(forget).not.toHaveBeenCalled();
    });
  });
});
