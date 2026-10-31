import { afterEach, vi } from "vitest";
import { createDmSidebar, type DmConversation } from "@components/DmSidebar";
import { useMountContainer } from "./mountContainer";

type DmSidebarOpts = Partial<Parameters<typeof createDmSidebar>[0]>;

/**
 * Registers a per-test host element (removed afterwards, along with any open
 * context menu) and returns a `mount` that builds a DM sidebar into it with
 * no-op selection callbacks unless `opts` overrides them.
 */
export function useDmSidebarHost(bind: (container: HTMLDivElement) => void) {
  let host: HTMLDivElement;
  useMountContainer((container) => {
    host = container;
    bind(container);
  });
  afterEach(() => {
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });
  return (conversations: DmConversation[], opts: DmSidebarOpts = {}) => {
    const sidebar = createDmSidebar({
      conversations,
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
      ...opts,
    });
    sidebar.mount(host);
    return sidebar;
  };
}

export function makeDmConversation(overrides: Partial<DmConversation> = {}): DmConversation {
  return {
    channelId: 100,
    userId: 1,
    username: "Alice",
    avatar: null,
    status: "online",
    lastMessage: "Hello!",
    timestamp: "2025-01-01T00:00:00Z",
    unread: false,
    ...overrides,
  };
}
