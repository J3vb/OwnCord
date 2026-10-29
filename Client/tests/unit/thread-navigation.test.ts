import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestOpenThread,
  requestOpenThreadList,
  setThreadNavigationConsumer,
  settleThreadNavigation,
} from "../../src/features/threads/threadNavigation";
import { channelsStore, resetChannelsStore, setChannels } from "../../src/stores/channels.store";

describe("threadNavigation", () => {
  let mounted: number | null;
  const open = vi.fn();

  beforeEach(() => {
    resetChannelsStore();
    setChannels([
      { id: 1, name: "a", type: "text", category: null, position: 0 },
      { id: 2, name: "b", type: "text", category: null, position: 1 },
    ]);
    mounted = null;
    open.mockClear();
    setThreadNavigationConsumer({
      get currentChannelId() {
        return mounted;
      },
      open,
    });
  });
  afterEach(() => setThreadNavigationConsumer(null));

  it("opens at once when the parent is already mounted", () => {
    mounted = 1;
    requestOpenThread(91, 1);
    expect(open).toHaveBeenCalledWith({ kind: "thread", threadId: 91, parentId: 1 });
  });

  it("navigates to the parent and opens once it has mounted", () => {
    requestOpenThread(91, 2);
    expect(channelsStore.getState().activeChannelId).toBe(2);
    expect(open).not.toHaveBeenCalled();
    settleThreadNavigation(2);
    expect(open).toHaveBeenCalledWith({ kind: "thread", threadId: 91, parentId: 2 });
    settleThreadNavigation(2);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("drops a request when a different channel mounts", () => {
    requestOpenThreadList(2);
    settleThreadNavigation(1);
    settleThreadNavigation(2);
    expect(open).not.toHaveBeenCalled();
  });

  it("does nothing for a parent the reader cannot list", () => {
    requestOpenThread(91, 77);
    settleThreadNavigation(77);
    expect(open).not.toHaveBeenCalled();
    expect(channelsStore.getState().activeChannelId).not.toBe(77);
  });
});
