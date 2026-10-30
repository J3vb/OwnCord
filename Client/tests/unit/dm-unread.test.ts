import { describe, expect, it, vi } from "vitest";

vi.mock("@lib/prefs/channelMutes", () => ({
  isChannelMuted: (id: number) => id === 2,
}));

const { totalDmUnread } = await import("@lib/dmUnread");

describe("totalDmUnread", () => {
  it("adds unread counts, but only mentions for a muted conversation", () => {
    expect(
      totalDmUnread([
        { channelId: 1, unreadCount: 3, mentionCount: 0 },
        { channelId: 2, unreadCount: 9, mentionCount: 1 },
        { channelId: 3, unreadCount: 2, mentionCount: 2 },
      ]),
    ).toBe(6);
  });

  it("is zero with nothing unread", () => {
    expect(totalDmUnread([])).toBe(0);
    expect(totalDmUnread([{ channelId: 2, unreadCount: 4, mentionCount: 0 }])).toBe(0);
  });
});
