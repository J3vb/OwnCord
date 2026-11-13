import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggerMock } from "../helpers/loggerMock";

const list = vi.hoisted(() => ({ mount: vi.fn(), destroy: vi.fn() }));
const createThreadList = vi.hoisted(() =>
  vi.fn((_opts: { onOpenThread: (t: unknown) => void; onClose: () => void }) => list),
);
vi.mock("../../src/features/threads/ThreadList", () => ({ createThreadList }));
vi.mock("@lib/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("@lib/logger", () => loggerMock());

import { createThreadListPanelController } from "../../src/features/threads/threadListPanel";
import type { ApiClient } from "@lib/api";
import {
  channelsStore,
  removeChannel,
  resetChannelsStore,
  setActiveChannel,
  setChannels,
} from "@stores/channels.store";

const flushStore = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("createThreadListPanelController", () => {
  let root: HTMLDivElement;
  let available = true;
  const onOpenThread = vi.fn();

  function make(
    getCurrentChannelId = (): number | null => channelsStore.getState().activeChannelId,
  ): ReturnType<typeof createThreadListPanelController> {
    return createThreadListPanelController({
      api: {} as ApiClient,
      getRoot: () => root,
      getCurrentChannelId,
      available: () => available,
      onOpenThread,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    available = true;
    root = document.createElement("div");
    document.body.appendChild(root);
    setChannels([
      { id: 5, name: "general", type: "text", position: 0 },
      { id: 6, name: "random", type: "text", position: 1 },
    ] as never);
    setActiveChannel(5);
  });

  afterEach(() => {
    root.remove();
    resetChannelsStore();
  });

  it("opens the list for the current channel in the root", async () => {
    const ctrl = make();
    await ctrl.open();
    expect(createThreadList).toHaveBeenCalledWith(expect.objectContaining({ channelId: 5 }));
    expect(list.mount).toHaveBeenCalledWith(root);
    expect(ctrl.isOpen()).toBe(true);
    ctrl.cleanup();
    expect(list.destroy).toHaveBeenCalledOnce();
  });

  it("stays shut when the channel offers no threads", async () => {
    available = false;
    const ctrl = make();
    await ctrl.open();
    expect(createThreadList).not.toHaveBeenCalled();
  });

  it("closes before opening a picked thread", async () => {
    const ctrl = make();
    await ctrl.open();
    createThreadList.mock.calls[0]![0].onOpenThread({ id: 9 });
    expect(list.destroy).toHaveBeenCalledOnce();
    expect(onOpenThread).toHaveBeenCalledWith({ id: 9 });
  });

  it("closes when the viewer switches channel", async () => {
    const ctrl = make();
    await ctrl.open();
    setActiveChannel(6);
    await flushStore();
    expect(ctrl.isOpen()).toBe(false);
  });

  it("closes when its channel is deleted", async () => {
    const ctrl = make();
    await ctrl.open();
    removeChannel(5);
    await flushStore();
    expect(ctrl.isOpen()).toBe(false);
  });

  it("never mounts a list whose code lands after the viewer left the channel", async () => {
    let current: number | null = 5;
    const ctrl = make(() => current);
    const opening = ctrl.open();
    current = 6;
    await opening;
    expect(createThreadList).not.toHaveBeenCalled();
    expect(ctrl.isOpen()).toBe(false);
  });

  it("closes when its channel falls behind the NSFW gate", async () => {
    const ctrl = make();
    await ctrl.open();
    setChannels([
      { id: 5, name: "general", type: "text", position: 0, nsfw: true },
      { id: 6, name: "random", type: "text", position: 1 },
    ] as never);
    await flushStore();
    expect(ctrl.isOpen()).toBe(false);
  });

  it("opens for the new channel when asked again after a switch while loading", async () => {
    let current: number | null = 5;
    const ctrl = make(() => current);
    const first = ctrl.open();
    expect(ctrl.isPending()).toBe(true);
    current = 6;
    expect(ctrl.isPending()).toBe(false);
    await ctrl.open();
    await first;
    expect(createThreadList).toHaveBeenCalledOnce();
    expect(createThreadList).toHaveBeenCalledWith(expect.objectContaining({ channelId: 6 }));
    ctrl.cleanup();
  });
});
