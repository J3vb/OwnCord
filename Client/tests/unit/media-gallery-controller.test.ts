import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const panel = vi.hoisted(() => ({
  mount: vi.fn(),
  destroy: vi.fn(),
  removeMessages: vi.fn(),
}));
const createChannelMediaGallery = vi.hoisted(() => vi.fn((_opts: unknown) => panel));

vi.mock("@components/ChannelMediaGallery", () => ({ createChannelMediaGallery }));
vi.mock("@lib/toast", () => ({ showToast: vi.fn() }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createMediaGalleryController } from "../../src/pages/main-page/MediaGalleryController";
import type { ChannelMediaGalleryOptions } from "@components/ChannelMediaGallery";
import type { ApiClient } from "@lib/api";
import {
  channelsStore,
  removeChannel,
  resetChannelsStore,
  setActiveChannel,
  setChannels,
} from "@stores/channels.store";

type DeleteListener = (channelId: number, ids: readonly number[]) => void;

describe("createMediaGalleryController", () => {
  let root: HTMLDivElement;
  let deleteListener: DeleteListener | null;
  const unsubscribeDeletes = vi.fn();
  const onJump = vi.fn();
  const api = {
    listChannelMedia: vi.fn(() => Promise.resolve({ items: [], next_cursor: "" })),
    getChannelMediaMonths: vi.fn(() => Promise.resolve({ months: [] })),
  } as unknown as ApiClient;

  function make(): ReturnType<typeof createMediaGalleryController> {
    return createMediaGalleryController({
      api,
      getRoot: () => root,
      getCurrentChannelId: () => channelsStore.getState().activeChannelId,
      subscribeDeletes: (listener) => {
        deleteListener = listener;
        return unsubscribeDeletes;
      },
      onJumpToMessage: onJump,
    });
  }

  const lastOptions = (): ChannelMediaGalleryOptions =>
    createChannelMediaGallery.mock.calls.at(-1)![0] as ChannelMediaGalleryOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    deleteListener = null;
    root = document.createElement("div");
    resetChannelsStore();
    setChannels([
      { id: 5, name: "photos", type: "text", category: null, position: 0 },
      { id: 6, name: "other", type: "text", category: null, position: 1 },
      {
        id: 7,
        name: "spicy",
        type: "text",
        category: null,
        position: 2,
        nsfw: true,
        nsfw_acknowledged: false,
      },
    ]);
    setActiveChannel(5);
  });

  afterEach(() => {
    resetChannelsStore();
  });

  it("opens for the current channel and loads through its id", async () => {
    const ctrl = make();
    await ctrl.toggle();

    expect(panel.mount).toHaveBeenCalledWith(root);
    const opts = lastOptions();
    expect(opts.channelName).toBe("photos");
    const signal = new AbortController().signal;
    void opts.loadPage({ kind: "files" }, signal);
    expect(api.listChannelMedia).toHaveBeenCalledWith(5, { kind: "files" }, signal);
    ctrl.cleanup();
  });

  it("jumps in the channel it opened for and closes", async () => {
    const ctrl = make();
    await ctrl.toggle();
    lastOptions().onJumpToMessage(42);
    expect(onJump).toHaveBeenCalledWith(5, 42);
    expect(panel.destroy).toHaveBeenCalled();
    expect(unsubscribeDeletes).toHaveBeenCalled();
  });

  it("passes only this channel's deletes to the panel", async () => {
    const ctrl = make();
    await ctrl.toggle();
    deleteListener!(6, [1]);
    expect(panel.removeMessages).not.toHaveBeenCalled();
    deleteListener!(5, [3, 4]);
    expect(panel.removeMessages).toHaveBeenCalledWith([3, 4]);
    ctrl.cleanup();
  });

  it("closes when the viewer switches channel or loses the channel", async () => {
    const ctrl = make();
    await ctrl.toggle();
    setActiveChannel(6);
    channelsStore.flush();
    expect(panel.destroy).toHaveBeenCalledTimes(1);

    setActiveChannel(5);
    await ctrl.toggle();
    removeChannel(5);
    channelsStore.flush();
    expect(panel.destroy).toHaveBeenCalledTimes(2);
  });

  it("does not open on a channel gated behind the NSFW check", async () => {
    setActiveChannel(7);
    const ctrl = make();
    await ctrl.toggle();
    expect(createChannelMediaGallery).not.toHaveBeenCalled();
  });

  it("toggles closed on a second press", async () => {
    const ctrl = make();
    await ctrl.toggle();
    await ctrl.toggle();
    expect(panel.destroy).toHaveBeenCalledTimes(1);
  });
});
