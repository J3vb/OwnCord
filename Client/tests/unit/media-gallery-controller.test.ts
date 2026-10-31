import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const panel = vi.hoisted(() => ({
  mount: vi.fn(),
  destroy: vi.fn(),
  removeMessages: vi.fn(),
  syncMessageAttachments: vi.fn(),
}));
const createChannelMediaGallery = vi.hoisted(() => vi.fn((_opts: unknown) => panel));

vi.mock("@components/ChannelMediaGallery", () => ({ createChannelMediaGallery }));
vi.mock("@lib/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createMediaGalleryController } from "../../src/pages/main-page/MediaGalleryController";
import type { ChannelMediaGalleryOptions } from "@components/ChannelMediaGallery";
import type { ApiClient } from "@lib/api";
import { closeSettings, uiStore } from "@stores/ui.store";
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
  let attachmentsListener:
    ((channelId: number, messageId: number, remaining: readonly string[]) => void) | null;
  const unsubscribeDeletes = vi.fn();
  const unsubscribeAttachments = vi.fn();
  const onJump = vi.fn();
  const api = {
    listChannelMedia: vi.fn(() => Promise.resolve({ items: [], next_cursor: "" })),
    getChannelMediaMonths: vi.fn(() => Promise.resolve({ months: [] })),
    getUserStorage: vi.fn(() => Promise.resolve({ used_bytes: 1, quota_bytes: 0 })),
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
      subscribeAttachments: (listener) => {
        attachmentsListener = listener;
        return unsubscribeAttachments;
      },
      onJumpToMessage: onJump,
    });
  }

  const lastOptions = (): ChannelMediaGalleryOptions =>
    createChannelMediaGallery.mock.calls.at(-1)![0] as ChannelMediaGalleryOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    deleteListener = null;
    attachmentsListener = null;
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

  it("closes on a press outside it but not inside it or on its header button", async () => {
    document.body.appendChild(root);
    const mediaBtn = document.createElement("button");
    mediaBtn.className = "pin-btn media-btn";
    const outside = document.createElement("div");
    root.append(mediaBtn, outside);
    panel.mount.mockImplementationOnce((container: Element) => {
      const el = document.createElement("div");
      el.className = "media-gallery";
      el.appendChild(document.createElement("button"));
      container.appendChild(el);
    });
    const press = (el: Element): void => {
      el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    };
    const ctrl = make();
    await ctrl.toggle();

    press(root.querySelector(".media-gallery button")!);
    press(mediaBtn);
    expect(panel.destroy).not.toHaveBeenCalled();

    press(outside);
    expect(panel.destroy).toHaveBeenCalledOnce();
    root.remove();
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

  it("passes only this channel's attachment removals to the panel", async () => {
    const ctrl = make();
    await ctrl.toggle();
    attachmentsListener!(6, 1, ["a"]);
    expect(panel.syncMessageAttachments).not.toHaveBeenCalled();
    attachmentsListener!(5, 1, ["a"]);
    expect(panel.syncMessageAttachments).toHaveBeenCalledWith(1, ["a"]);
    ctrl.cleanup();
    expect(unsubscribeAttachments).toHaveBeenCalled();
  });

  it("reads storage through the API and opens Settings at My uploads", async () => {
    const ctrl = make();
    await ctrl.toggle();
    const signal = new AbortController().signal;
    void lastOptions().loadStorage!(signal);
    expect(api.getUserStorage).toHaveBeenCalledWith(signal);
    lastOptions().onManageUploads!();
    expect(uiStore.getState().settingsOpen).toBe(true);
    expect(uiStore.getState().settingsTab).toBe("My uploads");
    expect(panel.destroy).toHaveBeenCalled();
    closeSettings();
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
