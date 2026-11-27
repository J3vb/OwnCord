// A long-press on a tree row on a phone: the row sheet opens, and the mouse
// events the lift sends do not start a drag reorder.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachChannelContextMenu } from "../../../src/features/channels/sidebar/contextMenu";
import { attachDragHandlers } from "../../../src/features/channels/sidebar/dragReorder";
import { closeBottomSheet } from "@lib/ui/bottomSheet";
import { installTouchInput } from "../../../src/lib/ui/touchInput";
import { makeChannel } from "../../helpers/channelFactory";
import { usePhone } from "../../helpers/phoneMedia";
import { pointer } from "../../helpers/touch";
import { settle } from "../../helpers/backNav";

const SHEET = '[data-testid="channel-sheet"]';

function mouse(type: "mousedown" | "mousemove" | "mouseup", y: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 20,
    clientY: y,
    button: 0,
    buttons: type === "mouseup" ? 0 : 1,
  });
}

/** The compatibility mouse events of a press that moves past the drag threshold. */
function mousePressAndMove(row: HTMLElement): void {
  row.dispatchEvent(mouse("mousedown", 20));
  row.dispatchEvent(mouse("mousemove", 40));
  row.dispatchEvent(mouse("mouseup", 40));
}

describe("a tree row on a phone", () => {
  let owner: AbortController;
  let row: HTMLElement;
  let watch: MutationObserver;
  /** Every class the body has had since the set-up, the current one last. */
  const bodyClasses = (): string[] => [
    ...watch.takeRecords().map((r) => r.oldValue ?? ""),
    document.body.className,
  ];

  beforeEach(() => {
    usePhone();
    owner = new AbortController();
    document.documentElement.classList.add("layout-deck");
    const tree = document.createElement("div");
    tree.className = "server-tree";
    row = document.createElement("div");
    row.className = "channel-item";
    row.setAttribute("role", "treeitem");
    tree.appendChild(row);
    document.body.appendChild(tree);
    const channel = makeChannel({ id: 5, position: 0 });
    attachDragHandlers(row, channel, tree, [channel], owner.signal, owner.signal, vi.fn(), true);
    attachChannelContextMenu(row, channel, owner.signal, owner.signal);
    installTouchInput(owner.signal);
    watch = new MutationObserver(() => undefined);
    watch.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
      attributeOldValue: true,
    });
  });

  afterEach(async () => {
    watch.disconnect();
    vi.useRealTimers();
    closeBottomSheet();
    await settle();
    owner.abort();
    document.body.className = "";
    document.body.replaceChildren();
    document.documentElement.classList.remove("layout-deck");
    vi.unstubAllGlobals();
  });

  it("a long-press opens the row sheet, and the lift's mouse events start no drag", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    pointer("pointerdown", row, 20, 20);
    vi.advanceTimersByTime(500);
    pointer("pointerup", row, 20, 20);
    mousePressAndMove(row);
    vi.useRealTimers();

    await vi.waitFor(() => expect(document.querySelector(SHEET)).not.toBeNull());
    expect(bodyClasses().filter((c) => c.includes("channel-reordering"))).toEqual([]);
  });

  it("the same mouse press with no long-press does start a drag", () => {
    mousePressAndMove(row);
    expect(bodyClasses().filter((c) => c.includes("channel-reordering"))).not.toEqual([]);
    expect(document.querySelector(SHEET)).toBeNull();
  });
});
