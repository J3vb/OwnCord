import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";

let storeCallback: (() => void) | null = null;
let typingUsers: Array<{ id: number; username: string }> = [];

vi.mock("@stores/members.store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stores/members.store")>();
  return {
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
    // Real implementation, not a stub: TypingIndicator renders through this
    // helper, and the fixtures below (id/username only, no displayName) must
    // fall through to `username` exactly as production members do.
    memberDisplayName: actual.memberDisplayName,
  };
});

import { createTypingIndicator } from "@components/TypingIndicator";

function setTypingUsers(users: Array<{ id: number; username: string }>): void {
  typingUsers = users;
  storeCallback?.();
}

describe("TypingIndicator", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createTypingIndicator>;

  useMountContainer(
    (c) => {
      container = c;
    },
    () => comp?.destroy?.(),
  );

  beforeEach(() => {
    typingUsers = [];
    storeCallback = null;
  });

  it("mounts with typing-bar class", () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 100 });
    comp.mount(container);

    expect(container.querySelector(".typing-bar")).not.toBeNull();
  });

  it("mounts as a polite live region so typing changes are announced", () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 100 });
    comp.mount(container);

    const bar = container.querySelector(".typing-bar") as HTMLDivElement;
    expect(bar.getAttribute("role")).toBe("status");
    expect(bar.getAttribute("aria-live")).toBe("polite");
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

  it("names all three typers, each in bold", () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 100 });
    comp.mount(container);

    setTypingUsers([
      { id: 1, username: "alice" },
      { id: 2, username: "bob" },
      { id: 3, username: "charlie" },
    ]);

    const bar = container.querySelector(".typing-bar") as HTMLDivElement;
    expect(bar.textContent).toContain("alice, bob, and charlie are typing...");
    expect([...bar.querySelectorAll("strong")].map((n) => n.textContent)).toEqual([
      "alice",
      "bob",
      "charlie",
    ]);
  });

  it('shows "Several people are typing..." for 4+ users', () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 100 });
    comp.mount(container);

    setTypingUsers([
      { id: 1, username: "alice" },
      { id: 2, username: "bob" },
      { id: 3, username: "charlie" },
      { id: 4, username: "dana" },
    ]);

    const bar = container.querySelector(".typing-bar") as HTMLDivElement;
    expect(bar.textContent).toContain("Several people are typing...");
    expect(bar.querySelector("strong")).toBeNull();
  });

  it("sets a name containing markup as text, never as HTML", () => {
    comp = createTypingIndicator({ channelId: 1, currentUserId: 100 });
    comp.mount(container);

    setTypingUsers([{ id: 1, username: "<img src=x>" }]);

    const bar = container.querySelector(".typing-bar") as HTMLDivElement;
    expect(bar.querySelector("img")).toBeNull();
    expect(bar.querySelector("strong")?.textContent).toBe("<img src=x>");
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
