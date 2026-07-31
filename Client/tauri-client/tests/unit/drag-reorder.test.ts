/**
 * Tests for src/components/channel-sidebar/drag-reorder.ts.
 *
 * This module was the least-covered file in the client (38.8% statements) and
 * had no test of its own — the reorder index arithmetic, the admin-only gate,
 * the 5px drag threshold and the listener ref-counting were all unverified.
 * Off-by-one errors in the insert index silently reorder the wrong pair of
 * channels for every member of the server.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  attachDragHandlers,
  ensureGlobalDragListeners,
  releaseGlobalDragListeners,
} from "@components/channel-sidebar/drag-reorder";
import type { ChannelReorderData } from "@components/ChannelSidebar";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import type { UserWithRole } from "@lib/types";

// ── helpers ────────────────────────────────────────────────────────────────

function makeUser(role: string): UserWithRole {
  return { id: 1, username: "tester", avatar: null, role };
}

function signIn(role: string): void {
  authStore.setState(() => ({
    token: "t",
    user: makeUser(role),
    serverName: "s",
    motd: "",
    isAuthenticated: true,
  }));
}

function makeCh(id: number, position: number, name = `ch-${id}`): Channel {
  return {
    id,
    name,
    type: "text",
    category: null,
    position,
    unreadCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
  };
}

interface Rig {
  container: HTMLElement;
  items: Map<number, HTMLElement>;
  channels: Channel[];
  onReorder: ReturnType<typeof vi.fn>;
  abort: AbortController;
}

/** Builds a container with one 20px-tall row per channel, stacked vertically. */
function buildRig(channels: Channel[]): Rig {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const items = new Map<number, HTMLElement>();
  const onReorder = vi.fn();
  const abort = new AbortController();

  channels.forEach((ch, idx) => {
    const el = document.createElement("div");
    container.appendChild(el);
    // jsdom does not lay out, so stub the geometry the module reads.
    const top = idx * 20;
    el.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + 20,
        height: 20,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    attachDragHandlers(el, ch, container, channels, abort.signal, onReorder);
    items.set(ch.id, el);
  });

  return { container, items, channels, onReorder, abort };
}

/** Row `idx` spans y = idx*20 .. idx*20+20; its midpoint is +10. */
function yInRow(idx: number, half: "top" | "bottom"): number {
  return idx * 20 + (half === "top" ? 4 : 16);
}

function mouse(type: string, clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true });
}

/** Drives a full drag of `fromId` onto the given half of row `toIdx`. */
function drag(rig: Rig, fromId: number, toIdx: number, half: "top" | "bottom"): void {
  const source = rig.items.get(fromId);
  if (source === undefined) throw new Error(`no row for channel ${fromId}`);
  const fromIdx = rig.channels.findIndex((c) => c.id === fromId);

  source.dispatchEvent(mouse("mousedown", 0, yInRow(fromIdx, "top")));
  // Past the 5px threshold so the drag activates.
  source.dispatchEvent(mouse("mousemove", 0, yInRow(fromIdx, "top") + 20));
  document.dispatchEvent(mouse("mouseup", 0, yInRow(toIdx, half)));
}

beforeEach(() => {
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: false,
  }));
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
  document.body.className = "";
  document.body.innerHTML = "";
});

afterEach(() => {
  // End any drag still in flight. `activeDrag` is module-level state and
  // releaseGlobalDragListeners() only clears it when handed the owning
  // container, so without this a half-finished drag leaks into the next test
  // and blocks it from starting one. Re-arm the global handlers first: a test
  // that drained the ref-count has aborted them, and the mouseup below needs a
  // live listener to do the clearing.
  ensureGlobalDragListeners();
  document.dispatchEvent(mouse("mouseup", 0, -1000));
  // Drain the ref-count so the document listeners do not leak between tests.
  for (let i = 0; i < 50; i++) releaseGlobalDragListeners();
  document.body.innerHTML = "";
  document.body.className = "";
});

// ── permission gate ────────────────────────────────────────────────────────

describe("attachDragHandlers permission gate", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["Owner", true],
    ["ADMIN", true],
    ["moderator", false],
    ["member", false],
    ["", false],
  ])("role %s → draggable %s", (role, draggable) => {
    signIn(role);
    const rig = buildRig([makeCh(1, 0)]);
    const el = rig.items.get(1);

    expect(el?.classList.contains("channel-draggable")).toBe(draggable);
  });

  it("does nothing when no user is signed in", () => {
    const rig = buildRig([makeCh(1, 0)]);

    expect(rig.items.get(1)?.classList.contains("channel-draggable")).toBe(false);
  });

  it("does nothing when no onReorderChannel callback is supplied", () => {
    signIn("owner");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const el = document.createElement("div");
    container.appendChild(el);

    attachDragHandlers(el, makeCh(1, 0), container, [makeCh(1, 0)], new AbortController().signal);

    expect(el.classList.contains("channel-draggable")).toBe(false);
    expect(el.dataset.dragChannelId).toBeUndefined();
  });

  it("stamps the channel id for hit-testing when permitted", () => {
    signIn("admin");
    const rig = buildRig([makeCh(7, 0)]);

    expect(rig.items.get(7)?.dataset.dragChannelId).toBe("7");
  });
});

// ── drag threshold ─────────────────────────────────────────────────────────

describe("drag activation threshold", () => {
  it("does not start a drag below the 5px threshold", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);
    const el = rig.items.get(1);

    el?.dispatchEvent(mouse("mousedown", 0, 4));
    el?.dispatchEvent(mouse("mousemove", 2, 6)); // dx+dy = 4

    expect(el?.classList.contains("dragging")).toBe(false);
    expect(document.body.classList.contains("channel-reordering")).toBe(false);
  });

  it("starts a drag once movement exceeds the threshold", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);
    const el = rig.items.get(1);

    el?.dispatchEvent(mouse("mousedown", 0, 4));
    el?.dispatchEvent(mouse("mousemove", 3, 10)); // dx+dy = 9

    expect(el?.classList.contains("dragging")).toBe(true);
    expect(document.body.classList.contains("channel-reordering")).toBe(true);
  });

  it("ignores non-left mouse buttons", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);
    const el = rig.items.get(1);

    el?.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 4, button: 2 }));
    el?.dispatchEvent(mouse("mousemove", 0, 40));

    expect(el?.classList.contains("dragging")).toBe(false);
  });

  it("a mouseup before the threshold cancels the pending drag", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);
    const el = rig.items.get(1);

    el?.dispatchEvent(mouse("mousedown", 0, 4));
    el?.dispatchEvent(mouse("mouseup", 0, 4));
    el?.dispatchEvent(mouse("mousemove", 0, 60));

    expect(el?.classList.contains("dragging")).toBe(false);
  });
});

// ── reorder arithmetic ─────────────────────────────────────────────────────

describe("reorder index arithmetic", () => {
  it("dropping on the top half inserts before the target", () => {
    signIn("owner");
    // Rows: idx0=ch1, idx1=ch2, idx2=ch3.
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1), makeCh(3, 2)]);

    drag(rig, 3, 0, "top"); // ch3 before ch1 → [3, 1, 2]

    expect(rig.onReorder).toHaveBeenCalledTimes(1);
    const reorders = rig.onReorder.mock.calls[0]?.[0] as readonly ChannelReorderData[];
    expect(positionsOf(reorders)).toEqual({ 3: 0, 1: 1, 2: 2 });
  });

  it("dropping on the bottom half inserts after the target", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1), makeCh(3, 2)]);

    drag(rig, 1, 1, "bottom"); // ch1 after ch2 → [2, 1, 3]

    const reorders = rig.onReorder.mock.calls[0]?.[0] as readonly ChannelReorderData[];
    expect(positionsOf(reorders)).toEqual({ 2: 0, 1: 1 });
  });

  it("only reports channels whose position actually changed", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1), makeCh(3, 2), makeCh(4, 3)]);

    drag(rig, 1, 1, "bottom"); // → [2, 1, 3, 4]; ch3 and ch4 keep their slots

    const reorders = rig.onReorder.mock.calls[0]?.[0] as readonly ChannelReorderData[];
    const touched = reorders.map((r) => r.channelId).sort((a, b) => a - b);
    expect(touched).toEqual([1, 2]);
  });

  it("updates the channels store immediately (optimistic reorder)", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);
    channelsStore.setState(() => ({
      channels: new Map([
        [1, makeCh(1, 0)],
        [2, makeCh(2, 1)],
      ]),
      activeChannelId: null,
      roles: [],
    }));

    drag(rig, 1, 1, "bottom"); // → [2, 1]

    expect(channelsStore.select((s) => s.channels.get(1)?.position)).toBe(1);
    expect(channelsStore.select((s) => s.channels.get(2)?.position)).toBe(0);
  });

  it("does not fire when dropped on itself", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);

    drag(rig, 1, 0, "bottom"); // row 0 is ch1 itself

    expect(rig.onReorder).not.toHaveBeenCalled();
  });

  it("does not fire when dropped outside any row", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);
    const el = rig.items.get(1);

    el?.dispatchEvent(mouse("mousedown", 0, 4));
    el?.dispatchEvent(mouse("mousemove", 0, 30));
    document.dispatchEvent(mouse("mouseup", 0, 9999)); // below every row

    expect(rig.onReorder).not.toHaveBeenCalled();
  });

  it("does not fire when the drag lands back in its original slot", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1), makeCh(3, 2)]);

    // ch1 dropped on the top half of ch2 → insert before ch2 → [1, 2, 3],
    // which is the order it already had.
    drag(rig, 1, 1, "top");

    expect(rig.onReorder).not.toHaveBeenCalled();
  });

  it("clears visual state on drop", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);

    drag(rig, 1, 1, "bottom");

    expect(rig.items.get(1)?.classList.contains("dragging")).toBe(false);
    expect(document.body.classList.contains("channel-reordering")).toBe(false);
    expect(rig.container.querySelectorAll(".channel-drop-indicator")).toHaveLength(0);
  });
});

// ── drop indicator ─────────────────────────────────────────────────────────

describe("drop indicator", () => {
  it("marks the hovered row and never the dragged row", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1), makeCh(3, 2)]);
    const source = rig.items.get(1);

    source?.dispatchEvent(mouse("mousedown", 0, yInRow(0, "top")));
    source?.dispatchEvent(mouse("mousemove", 0, yInRow(0, "top") + 20));

    document.dispatchEvent(mouse("mousemove", 0, yInRow(2, "top")));
    expect(rig.items.get(3)?.classList.contains("channel-drop-indicator")).toBe(true);

    // Hovering the dragged row itself must not show a drop target.
    document.dispatchEvent(mouse("mousemove", 0, yInRow(0, "top")));
    expect(rig.items.get(1)?.classList.contains("channel-drop-indicator")).toBe(false);
    expect(rig.items.get(3)?.classList.contains("channel-drop-indicator")).toBe(false);
  });

  it("moves the indicator as the cursor moves between rows", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1), makeCh(3, 2)]);
    const source = rig.items.get(1);

    source?.dispatchEvent(mouse("mousedown", 0, yInRow(0, "top")));
    source?.dispatchEvent(mouse("mousemove", 0, yInRow(0, "top") + 20));

    document.dispatchEvent(mouse("mousemove", 0, yInRow(1, "top")));
    expect(rig.items.get(2)?.classList.contains("channel-drop-indicator")).toBe(true);

    document.dispatchEvent(mouse("mousemove", 0, yInRow(2, "top")));
    expect(rig.items.get(2)?.classList.contains("channel-drop-indicator")).toBe(false);
    expect(rig.items.get(3)?.classList.contains("channel-drop-indicator")).toBe(true);
  });

  it("global handlers no-op when no drag is active", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);

    document.dispatchEvent(mouse("mousemove", 0, yInRow(1, "top")));
    document.dispatchEvent(mouse("mouseup", 0, yInRow(1, "top")));

    expect(rig.container.querySelectorAll(".channel-drop-indicator")).toHaveLength(0);
    expect(rig.onReorder).not.toHaveBeenCalled();
  });
});

// ── listener lifecycle ─────────────────────────────────────────────────────

describe("global listener ref-counting", () => {
  it("keeps listeners alive until every ref is released", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]); // 2 channels → 2 refs
    ensureGlobalDragListeners(); // a second sidebar → 3

    releaseGlobalDragListeners(); // → 2

    // Refs still outstanding, so a drag must still work.
    drag(rig, 1, 1, "bottom");
    expect(rig.onReorder).toHaveBeenCalledTimes(1);
  });

  /**
   * KNOWN BUG — the ref-count is asymmetric.
   *
   * `attachDragHandlers` calls `ensureGlobalDragListeners()` once per *channel
   * element* (ChannelSidebar.ts:431, inside the per-channel render), but
   * `releaseGlobalDragListeners` is called once per *sidebar destroy*
   * (ChannelSidebar.ts:703). So a sidebar showing N channels takes N refs and
   * gives back 1, and every re-render takes N more. In production the count
   * never returns to 0, the AbortController never fires, and the two document
   * listeners (plus the `activeDrag` closure they capture) live for the rest
   * of the process.
   *
   * The leak is currently benign — both handlers return immediately while
   * `activeDrag` is null, and re-registration is guarded — so this test pins
   * the behaviour as it actually is rather than as the doc comment describes
   * it ("only the last destroy tears them down"). If the ref-counting is
   * fixed so one release per sidebar suffices, this test should change with it.
   */
  it("takes one ref per channel, so a single release does not tear down", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]); // 2 refs, not 1

    releaseGlobalDragListeners(); // → 1, not 0

    drag(rig, 1, 1, "bottom");
    expect(rig.onReorder).toHaveBeenCalledTimes(1);
  });

  it("tears listeners down once the ref-count reaches zero", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);

    releaseGlobalDragListeners();
    releaseGlobalDragListeners(); // drops to 0 → AbortController fires

    drag(rig, 1, 1, "bottom");
    expect(rig.onReorder).not.toHaveBeenCalled();
  });

  it("clears an in-flight drag owned by the released container", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);
    const source = rig.items.get(1);

    source?.dispatchEvent(mouse("mousedown", 0, yInRow(0, "top")));
    source?.dispatchEvent(mouse("mousemove", 0, yInRow(0, "top") + 20));
    expect(source?.classList.contains("dragging")).toBe(true);

    releaseGlobalDragListeners(rig.container);

    // A sidebar destroyed mid-drag must not leave the row stuck in the
    // dragging state or the body stuck in reorder mode.
    expect(source?.classList.contains("dragging")).toBe(false);
    expect(document.body.classList.contains("channel-reordering")).toBe(false);
  });

  it("leaves a drag owned by a different container alone", () => {
    signIn("owner");
    const rig = buildRig([makeCh(1, 0), makeCh(2, 1)]);
    const source = rig.items.get(1);
    const otherContainer = document.createElement("div");

    source?.dispatchEvent(mouse("mousedown", 0, yInRow(0, "top")));
    source?.dispatchEvent(mouse("mousemove", 0, yInRow(0, "top") + 20));

    ensureGlobalDragListeners(); // keep the count above zero
    releaseGlobalDragListeners(otherContainer);

    expect(source?.classList.contains("dragging")).toBe(true);
  });

  it("release is safe to over-call", () => {
    expect(() => {
      releaseGlobalDragListeners();
      releaseGlobalDragListeners();
      releaseGlobalDragListeners();
    }).not.toThrow();
  });
});

/** Collapses reorder data into a channelId → newPosition map. */
function positionsOf(reorders: readonly ChannelReorderData[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of reorders) out[r.channelId] = r.newPosition;
  return out;
}
