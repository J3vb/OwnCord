import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelsStore, type Channel } from "../../stores/channels.store";
import { uiStore } from "../../stores/ui.store";
import { resetVoiceStore, voiceStore } from "../../stores/voice.store";
import { attachVoiceUserDrag, canDragVoiceUser, markVoiceDropTarget } from "./dragMove";

const FROM = 1;
const TO = 2;
const USER = 7;

function setRect(el: Element, left: number, top: number, right: number, bottom: number): void {
  el.getBoundingClientRect = () =>
    ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect;
}

function setChannels(flags: Record<number, { moderate?: boolean; move?: boolean }>): void {
  const channels = new Map<number, Channel>();
  for (const [id, f] of Object.entries(flags)) {
    channels.set(Number(id), {
      id: Number(id),
      canModerateVoice: f.moderate,
      canMoveVoice: f.move,
    } as unknown as Channel);
  }
  channelsStore.setState((prev) => ({ ...prev, channels }));
}

function setConnection(status: "connected" | "reconnecting" | "disconnected"): void {
  uiStore.setState((prev) => ({ ...prev, connectionStatus: status }));
}

function putUserIn(channelId: number | null): void {
  const voiceUsers = new Map(
    channelId === null ? [] : [[channelId, new Map([[USER, { userId: USER } as never]])]],
  );
  voiceStore.setState((prev) => ({ ...prev, voiceUsers }));
}

function mouse(type: string, x: number, y: number, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    buttons: type === "mouseup" ? 0 : 1,
    ...init,
  });
}

function key(k: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
}

const ghost = (): HTMLElement | null => document.body.querySelector(".voice-user-drag-ghost");

interface Rig {
  row: HTMLElement;
  liveRow: HTMLElement;
  fromArea: HTMLElement;
  toArea: HTMLElement;
  list: HTMLElement;
  onMove: ReturnType<typeof vi.fn>;
  rowLife: AbortController;
  sidebarLife: AbortController;
  press(x?: number, y?: number): void;
}

let rig: Rig;

/** A channel list at (0,0)-(300,300) holding the source channel's area, with
 *  the dragged user's row, and a target channel's area at (10,100)-(110,150). */
function buildRig(): Rig {
  const list = document.createElement("div");
  list.className = "channel-list";
  setRect(list, 0, 0, 300, 300);

  const fromArea = document.createElement("div");
  markVoiceDropTarget(fromArea, FROM);
  setRect(fromArea, 120, 0, 280, 60);
  // The row pressed, and the copy a re-render drew under the source area.
  const row = document.createElement("div");
  row.dataset.voiceUid = String(USER);
  row.setAttribute("tabindex", "0");
  row.textContent = "u7";
  const liveRow = document.createElement("div");
  liveRow.dataset.voiceUid = String(USER);
  fromArea.append(row);

  const toArea = document.createElement("div");
  markVoiceDropTarget(toArea, TO);
  setRect(toArea, 10, 100, 110, 150);
  toArea.append(liveRow);

  list.append(fromArea, toArea);
  document.body.append(list);

  const onMove = vi.fn();
  const rowLife = new AbortController();
  const sidebarLife = new AbortController();
  attachVoiceUserDrag(row, FROM, USER, onMove, rowLife.signal, sidebarLife.signal);
  return {
    row,
    liveRow,
    fromArea,
    toArea,
    list,
    onMove,
    rowLife,
    sidebarLife,
    press: (x = 100, y = 100) => row.dispatchEvent(mouse("mousedown", x, y, { button: 0 })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  setConnection("connected");
  setChannels({ [FROM]: { move: true }, [TO]: {} });
  putUserIn(FROM);
  rig = buildRig();
});

afterEach(() => {
  // Lets the swallow-next-click listener of a finished drag expire.
  vi.runAllTimers();
  rig.sidebarLife.abort();
  rig.rowLife.abort();
  document.body.replaceChildren();
  document.body.className = "";
  resetVoiceStore();
  vi.useRealTimers();
});

function dragTo(x: number, y: number): void {
  rig.press(100, 100);
  document.dispatchEvent(mouse("mousemove", x, y));
  document.dispatchEvent(mouse("mouseup", x, y));
}

function moved(dx: number, dy: number): boolean {
  document.dispatchEvent(mouse("mousemove", 100 + dx, 100 + dy));
  const shown = ghost() !== null;
  document.dispatchEvent(mouse("mouseup", 100 + dx, 100 + dy));
  return shown;
}

function dragToEnd(): void {
  rig.press();
  document.dispatchEvent(mouse("mousemove", 200, 250));
  document.dispatchEvent(mouse("mouseup", 200, 250));
}

function clickRow(): MouseEvent {
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  rig.row.dispatchEvent(click);
  return click;
}

describe("canDragVoiceUser", () => {
  it("allows a channel the server lets the user moderate or move out of", () => {
    setChannels({ 1: { moderate: true }, 2: { move: true }, 3: { moderate: false, move: false } });
    expect(canDragVoiceUser(1)).toBe(true);
    expect(canDragVoiceUser(2)).toBe(true);
    expect(canDragVoiceUser(3)).toBe(false);
    expect(canDragVoiceUser(4)).toBe(false);
  });

  it("refuses everything while the connection is not live", () => {
    setChannels({ 1: { moderate: true } });
    setConnection("reconnecting");
    expect(canDragVoiceUser(1)).toBe(false);
    setConnection("disconnected");
    expect(canDragVoiceUser(1)).toBe(false);
    setConnection("connected");
    expect(canDragVoiceUser(1)).toBe(true);
  });
});

describe("attachVoiceUserDrag", () => {
  it("moves the user to the channel whose area holds the release point", () => {
    dragTo(60, 125);
    expect(rig.onMove).toHaveBeenCalledTimes(1);
    expect(rig.onMove).toHaveBeenCalledWith(USER, TO);
  });

  it("counts every edge of the drop area as inside and the next pixel as outside", () => {
    for (const [x, y] of [
      [10, 100],
      [110, 100],
      [10, 150],
      [110, 150],
      [60, 125],
    ] as const) {
      rig.onMove.mockClear();
      dragTo(x, y);
      expect(rig.onMove, `inside ${x},${y}`).toHaveBeenCalledWith(USER, TO);
    }
    for (const [x, y] of [
      [9, 125],
      [111, 125],
      [60, 99],
      [60, 151],
      [250, 125],
      [5, 400],
    ] as const) {
      rig.onMove.mockClear();
      dragTo(x, y);
      expect(rig.onMove, `outside ${x},${y}`).not.toHaveBeenCalled();
    }
  });

  it("ignores a release over its own channel's area", () => {
    dragTo(200, 30);
    expect(rig.onMove).not.toHaveBeenCalled();
  });

  it("ignores a drop area scrolled out of the visible channel list", () => {
    setRect(rig.toArea, 10, 280, 110, 400);
    dragTo(60, 350);
    expect(rig.onMove).not.toHaveBeenCalled();
    dragTo(60, 290);
    expect(rig.onMove).toHaveBeenCalledWith(USER, TO);
  });

  it("starts no drag from a press that is not the main button, or after the sidebar is gone", () => {
    rig.row.dispatchEvent(mouse("mousedown", 100, 100, { button: 2 }));
    document.dispatchEvent(mouse("mousemove", 60, 125));
    expect(ghost()).toBeNull();
    rig.row.dispatchEvent(mouse("mousedown", 100, 100, { button: 1 }));
    document.dispatchEvent(mouse("mousemove", 60, 125));
    expect(ghost()).toBeNull();

    rig.sidebarLife.abort();
    rig.press();
    document.dispatchEvent(mouse("mousemove", 60, 125));
    expect(ghost()).toBeNull();
  });

  it("starts no drag when the live state no longer lets the user move people", () => {
    setChannels({ [FROM]: {}, [TO]: {} });
    rig.press();
    document.dispatchEvent(mouse("mousemove", 60, 125));
    expect(ghost()).toBeNull();
    document.dispatchEvent(mouse("mouseup", 60, 125));
    expect(rig.onMove).not.toHaveBeenCalled();
  });

  it("starts no drag once the row's own signal has ended", () => {
    rig.rowLife.abort();
    rig.press();
    document.dispatchEvent(mouse("mousemove", 60, 125));
    expect(ghost()).toBeNull();
  });

  it("leaves the pressed event alone so outside-press listeners still see it", () => {
    const seen = vi.fn();
    document.addEventListener("mousedown", seen, { signal: rig.sidebarLife.signal });
    rig.press();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  describe("drag threshold", () => {
    it("starts a drag only once the pointer has travelled 5 px in total", () => {
      rig.press();
      expect(moved(4, 0)).toBe(false);
      rig.press();
      expect(moved(3, 1)).toBe(false);
      rig.press();
      expect(moved(5, 0)).toBe(true);
      rig.press();
      expect(moved(3, 2)).toBe(true);
    });

    it("measures the travel in either direction on each axis", () => {
      rig.press();
      expect(moved(-2, 2)).toBe(false);
      rig.press();
      expect(moved(2, -2)).toBe(false);
      rig.press();
      expect(moved(-5, 0)).toBe(true);
      rig.press();
      expect(moved(0, -5)).toBe(true);
    });
  });

  describe("drag visuals", () => {
    it("shows a copy of the row that follows the pointer and is hidden from assistive tech", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 150, 200));
      const g = ghost();
      expect(g).not.toBeNull();
      expect(g?.textContent).toBe("u7");
      expect(g?.style.left).toBe("158px");
      expect(g?.style.top).toBe("208px");
      expect(g?.hasAttribute("tabindex")).toBe(false);
      expect(g?.hasAttribute("data-voice-uid")).toBe(false);
      expect(g?.getAttribute("aria-hidden")).toBe("true");
      expect(document.body.classList.contains("voice-user-moving")).toBe(true);
      // The pressed row itself keeps its identity.
      expect(rig.row.getAttribute("tabindex")).toBe("0");
      expect(rig.row.dataset.voiceUid).toBe(String(USER));

      document.dispatchEvent(mouse("mousemove", 20, 30));
      expect(ghost()).toBe(g);
      expect(g?.style.left).toBe("28px");
      expect(g?.style.top).toBe("38px");
    });

    it("marks the user's live rows as dragging, and the area under the pointer as the target", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      expect(rig.liveRow.classList.contains("dragging")).toBe(true);
      expect(rig.toArea.classList.contains("voice-drop-target")).toBe(true);
      expect(rig.fromArea.classList.contains("voice-drop-target")).toBe(false);

      document.dispatchEvent(mouse("mousemove", 200, 250));
      expect(rig.toArea.classList.contains("voice-drop-target")).toBe(false);
    });

    it("clears every mark when the drag ends", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      document.dispatchEvent(mouse("mouseup", 60, 125));
      expect(ghost()).toBeNull();
      expect(document.body.classList.contains("voice-user-moving")).toBe(false);
      expect(rig.liveRow.classList.contains("dragging")).toBe(false);
      expect(rig.toArea.classList.contains("voice-drop-target")).toBe(false);
    });
  });

  describe("ending a gesture", () => {
    it("drops the gesture when the button is already up on a move, before and after it shows", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 100, 100, { buttons: 0 }));
      document.dispatchEvent(mouse("mousemove", 60, 125));
      expect(ghost()).toBeNull();

      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      expect(ghost()).not.toBeNull();
      document.dispatchEvent(mouse("mousemove", 60, 125, { buttons: 0 }));
      expect(ghost()).toBeNull();
      expect(document.body.classList.contains("voice-user-moving")).toBe(false);
      document.dispatchEvent(mouse("mouseup", 60, 125));
      expect(rig.onMove).not.toHaveBeenCalled();
    });

    it("ends when the sidebar is destroyed mid-drag", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      expect(ghost()).not.toBeNull();
      rig.sidebarLife.abort();
      expect(ghost()).toBeNull();
      expect(rig.liveRow.classList.contains("dragging")).toBe(false);
      document.dispatchEvent(mouse("mouseup", 60, 125));
      expect(rig.onMove).not.toHaveBeenCalled();
    });

    it("does not react to the sidebar's end once its own gesture is over", () => {
      dragToEnd();
      // State owned by something else must survive a later sidebar teardown.
      document.body.classList.add("voice-user-moving");
      rig.toArea.classList.add("voice-drop-target");
      rig.sidebarLife.abort();
      expect(document.body.classList.contains("voice-user-moving")).toBe(true);
      expect(rig.toArea.classList.contains("voice-drop-target")).toBe(true);
    });

    it("ends when the window loses focus", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      window.dispatchEvent(new Event("blur"));
      expect(ghost()).toBeNull();
      document.dispatchEvent(mouse("mouseup", 60, 125));
      expect(rig.onMove).not.toHaveBeenCalled();
    });

    it("stops listening after the release", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      document.dispatchEvent(mouse("mouseup", 200, 250));
      document.dispatchEvent(mouse("mousemove", 60, 125));
      expect(ghost()).toBeNull();
    });
  });

  describe("release", () => {
    it("moves nobody for a press and release without travel", () => {
      rig.press(60, 125);
      document.dispatchEvent(mouse("mouseup", 60, 125));
      expect(rig.onMove).not.toHaveBeenCalled();
    });

    it("moves nobody who left the channel while the pointer was down", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      putUserIn(null);
      document.dispatchEvent(mouse("mouseup", 60, 125));
      expect(rig.onMove).not.toHaveBeenCalled();
    });

    it("moves nobody who was moved to another channel while the pointer was down", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      putUserIn(TO);
      document.dispatchEvent(mouse("mouseup", 60, 125));
      expect(rig.onMove).not.toHaveBeenCalled();
    });

    it("moves nobody once the user may no longer move people", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      setChannels({ [FROM]: {}, [TO]: {} });
      document.dispatchEvent(mouse("mouseup", 60, 125));
      expect(rig.onMove).not.toHaveBeenCalled();
    });
  });

  describe("Escape", () => {
    it("cancels a drag in flight: visuals go, and the release moves nobody", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      const esc = key("Escape");
      document.dispatchEvent(esc);
      expect(esc.defaultPrevented).toBe(true);
      expect(ghost()).toBeNull();
      expect(document.body.classList.contains("voice-user-moving")).toBe(false);
      expect(rig.liveRow.classList.contains("dragging")).toBe(false);

      // Further movement shows nothing; the release moves nobody.
      document.dispatchEvent(mouse("mousemove", 70, 130));
      expect(ghost()).toBeNull();
      document.dispatchEvent(mouse("mouseup", 70, 130));
      expect(rig.onMove).not.toHaveBeenCalled();
    });

    it("answers a second Escape without taking it from the page", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      document.dispatchEvent(key("Escape"));
      const again = key("Escape");
      document.dispatchEvent(again);
      expect(again.defaultPrevented).toBe(false);
    });

    it("ignores other keys during a drag", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      const other = key("a");
      document.dispatchEvent(other);
      expect(other.defaultPrevented).toBe(false);
      expect(ghost()).not.toBeNull();
      document.dispatchEvent(mouse("mouseup", 60, 125));
      expect(rig.onMove).toHaveBeenCalledWith(USER, TO);
    });

    it("ends a press that has not become a drag yet", () => {
      rig.press();
      const esc = key("Escape");
      document.dispatchEvent(esc);
      expect(esc.defaultPrevented).toBe(true);
      document.dispatchEvent(mouse("mousemove", 60, 125));
      expect(ghost()).toBeNull();
    });

    it("ends a press that has not become a drag yet, so the release is an ordinary click", () => {
      rig.press();
      document.dispatchEvent(key("Escape"));
      document.dispatchEvent(mouse("mouseup", 100, 100));
      expect(clickRow().defaultPrevented).toBe(false);
    });
  });

  describe("the click after a release", () => {
    it("is swallowed after a drag, once", () => {
      const reached = vi.fn();
      rig.row.addEventListener("click", reached);
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      document.dispatchEvent(mouse("mouseup", 60, 125));
      const first = clickRow();
      expect(first.defaultPrevented).toBe(true);
      expect(reached).not.toHaveBeenCalled();
      const second = clickRow();
      expect(second.defaultPrevented).toBe(false);
      expect(reached).toHaveBeenCalledTimes(1);
    });

    it("is swallowed after a cancelled drag", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      document.dispatchEvent(key("Escape"));
      document.dispatchEvent(mouse("mouseup", 60, 125));
      expect(clickRow().defaultPrevented).toBe(true);
    });

    it("is no longer swallowed once the event loop has turned", () => {
      rig.press();
      document.dispatchEvent(mouse("mousemove", 60, 125));
      document.dispatchEvent(mouse("mouseup", 60, 125));
      vi.runAllTimers();
      expect(clickRow().defaultPrevented).toBe(false);
    });

    it("is left alone after a plain press and release", () => {
      rig.press();
      document.dispatchEvent(mouse("mouseup", 100, 100));
      expect(clickRow().defaultPrevented).toBe(false);
    });
  });
});
