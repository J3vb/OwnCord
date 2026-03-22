import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let storeCallback: (() => void) | null = null;
let typingUsers: Array<{ id: number; username: string }> = [];

vi.mock("@stores/members.store", () => ({
  membersStore: {
    subscribe: vi.fn((cb: () => void) => {
      storeCallback = cb;
      return () => {
        storeCallback = null;
      };
    }),
    subscribeSelector: vi.fn((_sel: unknown, listener: () => void) => {
      storeCallback = listener;
      return () => {
        storeCallback = null;
      };
    }),
  },
  getTypingUsers: vi.fn(() => typingUsers),
}));

import { createTypingIndicator } from "@components/TypingIndicator";

function setTypingUsers(users: Array<{ id: number; username: string }>): void {
  typingUsers = users;
  storeCallback?.();
}

describe("TypingIndicator", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createTypingIndicator>;

  beforeEach(() => {
    typingUsers = [];
    storeCallback = null;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    comp?.destroy?.();
    container.remove();
  });

  it("mounts with typing-bar class", () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 100 });
    comp.mount(container);

    expect(container.querySelector(".typing-bar")).not.toBeNull();
  });

  it("shows nothing when no one is typing", () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 100 });
    comp.mount(container);

    const bar = container.querySelector(".typing-bar") as HTMLDivElement;
    expect(bar.children.length).toBe(0);
    expect(bar.textContent).toBe("");
  });

  it('shows "X is typing..." for one user', () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 100 });
    comp.mount(container);

    setTypingUsers([{ id: 1, username: "alice" }]);

    const bar = container.querySelector(".typing-bar") as HTMLDivElement;
    expect(bar.textContent).toContain("alice is typing...");
  });

  it('shows "X and Y are typing..." for two users', () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 100 });
    comp.mount(container);

    setTypingUsers([
      { id: 1, username: "alice" },
      { id: 2, username: "bob" },
    ]);

    const bar = container.querySelector(".typing-bar") as HTMLDivElement;
    expect(bar.textContent).toContain("alice and bob are typing...");
  });

  it('shows "Several people are typing..." for 3+ users', () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 100 });
    comp.mount(container);

    setTypingUsers([
      { id: 1, username: "alice" },
      { id: 2, username: "bob" },
      { id: 3, username: "charlie" },
    ]);

    const bar = container.querySelector(".typing-bar") as HTMLDivElement;
    expect(bar.textContent).toContain("Several people are typing...");
  });

  it("filters out current user from typing list", () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 1 });
    comp.mount(container);

    // Only the current user is typing
    setTypingUsers([{ id: 1, username: "me" }]);

    const bar = container.querySelector(".typing-bar") as HTMLDivElement;
    // Should show nothing since current user is filtered
    expect(bar.children.length).toBe(0);
  });
});
