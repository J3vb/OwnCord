/**
 * Explicit mark-as-read affordance in the channel sidebar: the per-channel
 * "Mark as Read" context-menu entry. The server-wide "Mark All as Read" button
 * lives in the unified sidebar header; see sidebar-area-mark-all-read.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as mocks from "../helpers/sidebarStubMocks";
import * as stubs from "../helpers/sidebarStubs";

vi.mock("@lib/voice/livekitSession", () => mocks.rePinOnlySessionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.inertE2eeCryptoMock());

import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
import { setMarkReadSender } from "@lib/readState";
import { readStateChannels } from "../helpers/sidebarAreaOpts";

const CHANNELS = readStateChannels();

describe("ChannelSidebar — mark as read", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let sent: number[];

  beforeEach(() => {
    sent = [];
    setMarkReadSender((id) => sent.push(id));
    stubs.resetSidebarStoresAsMember();

    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = stubs.createPlainChannelSidebar();
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
    setMarkReadSender(null);
  });

  function openCtxMenu(channelId: number): HTMLElement | null {
    const el = container.querySelector(`[data-channel-id="${channelId}"]`) as HTMLElement;
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    return document.querySelector('[data-testid="channel-context-menu"]');
  }

  it("marks a channel read from the context menu without activating it", () => {
    setChannels(CHANNELS);
    sidebar.mount(container);

    const menu = openCtxMenu(1);
    const item = menu?.querySelector('[data-testid="ctx-mark-read"]') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.classList.contains("disabled")).toBe(false);

    item.click();

    expect(sent).toEqual([1]);
    const ch = channelsStore.getState().channels.get(1);
    expect(ch?.unreadCount).toBe(0);
    expect(ch?.mentionCount).toBe(0);
    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("disables Mark as Read for a channel with nothing unread", () => {
    setChannels(CHANNELS);
    sidebar.mount(container);

    const menu = openCtxMenu(2);
    const item = menu?.querySelector('[data-testid="ctx-mark-read"]') as HTMLElement;
    expect(item.classList.contains("disabled")).toBe(true);

    item.click();
    expect(sent).toEqual([]);
  });

  it("omits Mark as Read for a voice channel, which holds no messages", () => {
    setChannels(CHANNELS);
    sidebar.mount(container);

    const el = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    const menu = document.querySelector('[data-testid="channel-context-menu"]');
    expect(menu?.querySelector('[data-testid="ctx-mark-read"]') ?? null).toBeNull();
  });

  it("omits Mark as Read for a forum, which has no unread state, but keeps Mute", () => {
    setChannels(CHANNELS);
    sidebar.mount(container);

    const el = container.querySelector('[data-channel-id="4"]') as HTMLElement;
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    const menu = document.querySelector('[data-testid="channel-context-menu"]');
    expect(menu?.querySelector('[data-testid="ctx-mark-read"]') ?? null).toBeNull();
    expect(menu?.querySelector('[data-testid="ctx-mute-channel"]')).not.toBeNull();
  });
});
