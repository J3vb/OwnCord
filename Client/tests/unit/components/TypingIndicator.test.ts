import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTypingIndicator } from "@components/TypingIndicator";
import { membersStore, setMembers, setTyping } from "@stores/members.store";
import type { ReadyMember } from "@lib/types";

const MEMBER_BOB: ReadyMember = {
  id: 2,
  username: "bob",
  avatar: null,
  role: "member",
  status: "online",
  display_name: "Bobby",
};

const MEMBER_CAROL: ReadyMember = {
  id: 3,
  username: "carol",
  avatar: null,
  role: "member",
  status: "online",
  display_name: "Caro",
};

function resetStore(): void {
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
    roleRevision: 0,
  }));
}

describe("TypingIndicator", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("renders the member's display name, not the raw username, for a single typer", () => {
    setMembers([MEMBER_BOB]);
    setTyping(100, 2);

    const indicator = createTypingIndicator({ channelId: 100, currentUserId: 1 });
    indicator.mount(container);

    expect(container.textContent).toContain("Bobby is typing...");
    expect(container.textContent).not.toContain("bob is typing...");

    indicator.destroy?.();
  });

  it("renders display names, not raw usernames, for two typers", () => {
    setMembers([MEMBER_BOB, MEMBER_CAROL]);
    setTyping(100, 2);
    setTyping(100, 3);

    const indicator = createTypingIndicator({ channelId: 100, currentUserId: 1 });
    indicator.mount(container);

    const text = container.textContent ?? "";
    expect(text).toContain("Bobby");
    expect(text).toContain("Caro");
    expect(text).not.toContain("bob and");
    expect(text).not.toContain("carol are");

    indicator.destroy?.();
  });
});
