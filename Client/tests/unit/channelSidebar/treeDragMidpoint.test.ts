/**
 * Dragging a channel over a voice channel whose people are two lines tall
 * (tree branch 12). In the server tree "before" is the top half of the voice
 * channel's own row and anything lower, people included, is "after"; Classic
 * keeps the wrapper's midpoint.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  findDropTarget,
  type ChannelDrag,
} from "../../../src/features/channels/sidebar/dragHitTest";

const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, height, left: 0, right: 240, width: 240 }) as DOMRect;

/** A text channel (being dragged) above a voice wrapper: its own row 100..124, then three
 *  two-line users of 40 px each, so the wrapper spans 100..244. */
function build(inTree: boolean): { drag: ChannelDrag; wrapper: HTMLElement } {
  const root = document.createElement("div");
  root.className = inTree ? "server-tree" : "channel-sidebar";
  const list = document.createElement("div");
  list.className = "channel-list";
  const container = document.createElement("div");
  container.className = "category-channels-container";
  const source = document.createElement("div");
  source.className = "channel-item";
  source.dataset.dragChannelId = "1";
  source.getBoundingClientRect = () => rect(60, 24);
  const wrapper = document.createElement("div");
  wrapper.dataset.dragChannelId = "7";
  const own = document.createElement("div");
  own.className = "channel-item";
  own.getBoundingClientRect = () => rect(100, 24);
  const users = document.createElement("div");
  users.className = "voice-users-list";
  wrapper.append(own, users);
  wrapper.getBoundingClientRect = () => rect(100, 144);
  container.append(source, wrapper);
  list.appendChild(container);
  root.appendChild(list);
  document.body.appendChild(root);
  const drag = {
    kind: "channel",
    channelId: 1,
    sourceEl: source,
    containerEl: container,
    channels: [],
    onReorder: () => undefined,
    owner: new AbortController().signal,
  } satisfies ChannelDrag;
  return { drag, wrapper };
}

const at = (clientY: number): MouseEvent => new MouseEvent("mouseup", { clientX: 20, clientY });

afterEach(() => {
  document.body.replaceChildren();
});

describe("the drop midpoint over a voice channel", () => {
  it("in the tree, the top half of the channel's own row is before and everything lower is after", () => {
    const { drag, wrapper } = build(true);
    const hit = (y: number) => findDropTarget(drag, at(y));
    expect(hit(105)).toMatchObject({ kind: "row", el: wrapper, channelId: 7, before: true });
    expect(hit(111)).toMatchObject({ before: true });
    // Below the row's midpoint (112), and well inside the people, which the wrapper's own
    // midpoint (172) would still have called "before".
    expect(hit(113)).toMatchObject({ channelId: 7, before: false });
    expect(hit(140)).toMatchObject({ channelId: 7, before: false });
    expect(hit(230)).toMatchObject({ channelId: 7, before: false });
  });

  it("Classic keeps the wrapper's midpoint", () => {
    const { drag } = build(false);
    expect(findDropTarget(drag, at(140))).toMatchObject({ channelId: 7, before: true });
    expect(findDropTarget(drag, at(200))).toMatchObject({ channelId: 7, before: false });
  });

  it("a row that has no inner row of its own (a text channel) uses its own box", () => {
    const { drag } = build(true);
    expect(findDropTarget(drag, at(65))).toMatchObject({ channelId: 1, before: true });
    expect(findDropTarget(drag, at(80))).toMatchObject({ channelId: 1, before: false });
  });
});
