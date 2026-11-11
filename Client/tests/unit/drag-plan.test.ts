/**
 * The reorders a channel drop plans, and the optimistic move that applies
 * them, with no DOM gestures: the guards a mouse-driven drop never reaches
 * (a target outside the group, a dragged channel the group does not hold) and
 * the store writes of both optimistic paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelsStore, type Channel } from "@stores/channels.store";
import type { ChannelDrag, DropTarget } from "../../src/features/channels/sidebar/dragHitTest";
import {
  applyOptimistic,
  dropRefused,
  planDrop,
} from "../../src/features/channels/sidebar/dragPlan";
import { makeChannel } from "../helpers/channelFactory";
import { resetChannelsState } from "../helpers/storeSeeds";

const ch = (id: number, position: number, over: Partial<Channel> = {}): Channel =>
  makeChannel({ id, name: `ch-${id}`, position, ...over });

const container = document.createElement("div");

function dragOf(channelId: number, channels: Channel[]): ChannelDrag {
  return {
    kind: "channel",
    channelId,
    sourceEl: document.createElement("div"),
    containerEl: container,
    channels,
    onReorder: vi.fn(),
    owner: new AbortController().signal,
  };
}

const rowTarget = (channelId: number, before: boolean): DropTarget => ({
  kind: "row",
  el: document.createElement("div"),
  channelId,
  before,
  container,
});

beforeEach(() => {
  resetChannelsState();
});

describe("planDrop within the dragged channel's own group", () => {
  const group = [ch(1, 0), ch(2, 1), ch(3, 2)];

  it("moves the dragged channel before or after the target and re-slots the group", () => {
    expect(planDrop(dragOf(1, group), rowTarget(3, false))).toEqual([
      { channelId: 2, newPosition: 0, previousPosition: 1 },
      { channelId: 3, newPosition: 1, previousPosition: 2 },
      { channelId: 1, newPosition: 2, previousPosition: 0 },
    ]);
    expect(planDrop(dragOf(3, group), rowTarget(2, true))).toEqual([
      { channelId: 3, newPosition: 1, previousPosition: 2 },
      { channelId: 2, newPosition: 2, previousPosition: 1 },
    ]);
  });

  it("plans nothing for a drop on itself, on a row the group does not hold, or for a channel it does not hold", () => {
    expect(planDrop(dragOf(2, group), rowTarget(2, true))).toEqual([]);
    expect(planDrop(dragOf(2, group), rowTarget(99, true))).toEqual([]);
    expect(planDrop(dragOf(99, group), rowTarget(1, true))).toEqual([]);
  });

  it("refuses a drop across the text-above-voice line, and nothing else", () => {
    const mixed = [ch(1, 0), ch(2, 1, { type: "voice" })];
    expect(dropRefused(dragOf(1, mixed), rowTarget(2, true))).toBe(true);
    expect(planDrop(dragOf(1, mixed), rowTarget(2, true))).toEqual([]);
    expect(dropRefused(dragOf(1, mixed), rowTarget(1, true))).toBe(false);
    // A dragged channel the group does not hold is not "refused": there is nothing to refuse.
    expect(dropRefused(dragOf(99, mixed), rowTarget(1, true))).toBe(false);
  });
});

describe("applyOptimistic", () => {
  it("writes the new position, and the category fields when the move carries them", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([
        [1, ch(1, 0)],
        [2, ch(2, 1)],
      ]),
    }));
    applyOptimistic([
      { channelId: 1, newPosition: 5, previousPosition: 0 },
      {
        channelId: 2,
        newPosition: 6,
        previousPosition: 1,
        category: {
          previous: { categoryId: 0, category: null, categoryPosition: 0 },
          next: { categoryId: 9, category: "Games", categoryPosition: 3 },
        },
      },
    ]);
    const { channels } = channelsStore.getState();
    expect(channels.get(1)?.position).toBe(5);
    expect(channels.get(2)).toMatchObject({
      position: 6,
      categoryId: 9,
      category: "Games",
      categoryPosition: 3,
    });
  });

  it("defaults an absent category to none", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[1, ch(1, 0, { categoryId: 4, category: "Old", categoryPosition: 1 })]]),
    }));
    applyOptimistic([
      {
        channelId: 1,
        newPosition: 2,
        previousPosition: 0,
        category: {
          previous: { categoryId: 4, category: "Old", categoryPosition: 1 },
          next: { categoryId: undefined, category: null, categoryPosition: undefined },
        },
      },
    ]);
    expect(channelsStore.getState().channels.get(1)).toMatchObject({
      position: 2,
      categoryId: 0,
      category: "",
      categoryPosition: 0,
    });
  });
});
