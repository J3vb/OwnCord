import { beforeEach, describe, expect, it } from "vitest";
import {
  followedThreadsStore,
  publishFollowedThreads,
  type FollowedThreadRow,
  type FollowedThreadsView,
} from "../../src/stores/followedThreads.store";

const row = (over: Partial<FollowedThreadRow> = {}): FollowedThreadRow => ({
  id: 1,
  parentId: 10,
  name: "plan",
  unread: 0,
  mentions: 0,
  activityAt: 100,
  ...over,
});

const view = (
  rows: readonly FollowedThreadRow[],
  focusedId: number | null = null,
): FollowedThreadsView => ({ byParent: new Map([[10, rows]]), focusedId });

beforeEach(() => {
  publishFollowedThreads({ byParent: new Map(), focusedId: null });
});

describe("publishFollowedThreads", () => {
  it("drops a view equal to the one held", () => {
    const first = view([row()], 1);
    publishFollowedThreads(first);
    publishFollowedThreads(view([row()], 1));
    expect(followedThreadsStore.getState()).toBe(first);
  });

  it.each<[string, FollowedThreadsView]>([
    ["thread id", view([row({ id: 2 })])],
    ["parent id", view([row({ parentId: 11 })])],
    ["name", view([row({ name: "other" })])],
    ["unread count", view([row({ unread: 1 })])],
    ["mention count", view([row({ mentions: 1 })])],
    ["activity time", view([row({ activityAt: 200 })])],
    ["row count", view([row(), row({ id: 2 })])],
    ["focused thread", view([row()], 1)],
  ])("takes a view that differs only in the %s", (_label, next) => {
    publishFollowedThreads(view([row()]));
    publishFollowedThreads(next);
    expect(followedThreadsStore.getState()).toBe(next);
  });

  it("takes a view with another parent or one parent more", () => {
    publishFollowedThreads(view([row()]));
    const moved: FollowedThreadsView = { byParent: new Map([[11, [row()]]]), focusedId: null };
    publishFollowedThreads(moved);
    expect(followedThreadsStore.getState()).toBe(moved);

    const wider: FollowedThreadsView = {
      byParent: new Map([
        [11, [row()]],
        [12, [row({ id: 3, parentId: 12 })]],
      ]),
      focusedId: null,
    };
    publishFollowedThreads(wider);
    expect(followedThreadsStore.getState()).toBe(wider);
  });

  it("takes a view that has dropped a parent the old one had", () => {
    const wide: FollowedThreadsView = {
      byParent: new Map([
        [10, [row()]],
        [12, [row({ id: 3, parentId: 12 })]],
      ]),
      focusedId: null,
    };
    publishFollowedThreads(wide);
    const narrow = view([row()]);
    publishFollowedThreads(narrow);
    expect(followedThreadsStore.getState()).toBe(narrow);
  });
});
