import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachChannelContextMenu } from "@components/channel-sidebar/context-menu";
import type { ChannelReorderData } from "@components/ChannelSidebar";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";

function channel(id: number, position: number): Channel {
  return {
    id,
    name: `ch-${id}`,
    type: "text",
    category: null,
    position,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    topic: "",
    nsfw: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
  };
}

let container: HTMLDivElement;
let ac: AbortController;

beforeEach(() => {
  authStore.setState(() => ({
    token: "t",
    user: { id: 1, username: "tester", avatar: null, role: "owner" },
    serverName: "s",
    motd: "",
    isAuthenticated: true,
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  container.remove();
  document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
});

function openMove(
  rows: readonly Channel[],
  target: Channel,
  onReorder: (reorders: readonly ChannelReorderData[]) => void,
): void {
  channelsStore.setState(() => ({
    channels: new Map(rows.map((c) => [c.id, c])),
    activeChannelId: null,
    roles: [],
  }));
  const el = document.createElement("div");
  container.appendChild(el);
  attachChannelContextMenu(
    el,
    target,
    ac.signal,
    ac.signal,
    undefined,
    undefined,
    undefined,
    rows,
    onReorder,
  );
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
}

describe("channel context menu - Move Up / Move Down", () => {
  it("emits entries that carry each channel's previous position", () => {
    const rows = [channel(1, 0), channel(2, 3), channel(3, 6)];
    const onReorder = vi.fn<(reorders: readonly ChannelReorderData[]) => void>();
    openMove(rows, rows[1]!, onReorder);

    (document.querySelector('[data-testid="ctx-move-up"]') as HTMLElement).click();

    expect(onReorder).toHaveBeenCalledWith([
      { channelId: 2, newPosition: 0, previousPosition: 3 },
      { channelId: 1, newPosition: 3, previousPosition: 0 },
    ]);
    expect(channelsStore.getState().channels.get(2)?.position).toBe(0);
  });

  it("records the pre-nudge position when tied positions are nudged apart", () => {
    const rows = [channel(1, 0), channel(2, 0)];
    const onReorder = vi.fn<(reorders: readonly ChannelReorderData[]) => void>();
    openMove(rows, rows[0]!, onReorder);

    (document.querySelector('[data-testid="ctx-move-down"]') as HTMLElement).click();

    expect(onReorder).toHaveBeenCalledWith([
      { channelId: 1, newPosition: 1, previousPosition: 0 },
      { channelId: 2, newPosition: 0, previousPosition: 0 },
    ]);
  });
});
