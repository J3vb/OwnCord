import { vi } from "vitest";
import type { SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";
import { dmStore } from "@stores/dm.store";
import { uiStore } from "@stores/ui.store";
import { resetMembersState } from "./storeResets";
import { resetChannelsState, signInAs } from "./storeSeeds";

/**
 * Fresh SidebarArea options. Kept apart from sidebarAreaHarness, which imports
 * the real components, so a suite that gates those imports can use it.
 */
export function defaultSidebarAreaOpts(): SidebarAreaOptions {
  return {
    ws: {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(() => vi.fn()),
      off: vi.fn(),
    } as unknown as SidebarAreaOptions["ws"],
    api: {
      createDm: vi.fn().mockResolvedValue({
        channel_id: 200,
        recipient: { id: 20, username: "Bob", avatar: "", status: "online" },
      }),
      closeDm: vi.fn().mockResolvedValue(undefined),
      getInvites: vi.fn().mockResolvedValue([]),
      createInvite: vi
        .fn()
        .mockResolvedValue({ code: "abc", expires_at: "", max_uses: 0, use_count: 0 }),
      revokeInvite: vi.fn().mockResolvedValue(undefined),
      adminCreateChannel: vi.fn().mockResolvedValue(undefined),
      adminUpdateChannel: vi.fn().mockResolvedValue(undefined),
      adminDeleteChannel: vi.fn().mockResolvedValue(undefined),
      purgeMessages: vi.fn().mockResolvedValue({ channel_id: 1, ids: [3, 2], count: 2 }),
      adminKickMember: vi.fn().mockResolvedValue(undefined),
      adminBanMember: vi.fn().mockResolvedValue(undefined),
      adminChangeRole: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockReturnValue({ host: "localhost:8080" }),
    } as unknown as SidebarAreaOptions["api"],
    limiters: {
      voice: { tryConsume: vi.fn().mockReturnValue(true) },
      voiceVideo: { tryConsume: vi.fn().mockReturnValue(true) },
    } as unknown as SidebarAreaOptions["limiters"],
    presenceSender: {
      send: vi.fn(),
      rollbackRefused: vi.fn(),
      destroy: vi.fn(),
    },
    getRoot: vi.fn().mockReturnValue(document.createElement("div")),
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  };
}

/** Bare SidebarArea options: inert socket and api, with `host` as the connected server. */
export function lightSidebarAreaOpts(host: string): SidebarAreaOptions {
  return {
    ws: { send: vi.fn(), close: vi.fn(), on: vi.fn(), off: vi.fn() } as never,
    api: { getConfig: vi.fn().mockReturnValue({ host }) } as never,
    limiters: {
      voice: { tryConsume: vi.fn().mockReturnValue(true) },
      voiceVideo: { tryConsume: vi.fn().mockReturnValue(true) },
    } as never,
    presenceSender: { send: vi.fn(), rollbackRefused: vi.fn(), destroy: vi.fn() },
    getRoot: vi.fn().mockReturnValue(document.createElement("div")),
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  };
}

/** Empty channels, DMs and members, expanded categories and channel mode, signed in as a member. */
export function resetSidebarStoresAsMember(): void {
  resetChannelsState();
  dmStore.setState(() => ({ channels: [] }));
  resetMembersState();
  uiStore.setState((prev) => ({
    ...prev,
    collapsedCategories: new Set(),
    sidebarMode: "channels" as const,
  }));
  signInAs({ id: 2, username: "Member", avatar: null, role: "member" });
}
