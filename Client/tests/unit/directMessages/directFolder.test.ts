/**
 * The Direct folder (Client brief, D3): the last group of the Command Deck
 * tree. It is mounted by the real `ChannelSidebar` in tree mode, so the first
 * draw, the levels and the Tab stop are the tree's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelSidebar } from "../../../src/features/channels/ChannelSidebar";
import {
  createDmFolder,
  type DmFolderOptions,
} from "../../../src/features/direct-messages/dmFolder";
import { handleDmChannelClose } from "../../../src/features/direct-messages/wsHandlers";
import type { CountSource } from "../../../src/features/navigation/destinations";
import { dmStore, addDmToChannelsStore, type DmChannel } from "../../../src/stores/dm.store";
import { channelsStore, setActiveChannel } from "../../../src/stores/channels.store";
import {
  DM_SECTION_COLLAPSED_KEY,
  isCategoryCollapsed,
  setSidebarMode,
  uiStore,
} from "../../../src/stores/ui.store";
import { setVoiceStates, voiceStore } from "../../../src/stores/voice.store";
import { formatBadgeCount } from "@lib/text/formatting";
import { totalDmUnread } from "@lib/dmUnread";
import { invalidateMuteCache, muteChannel } from "@lib/prefs/channelMutes";
import { dmRecipient, makeDm, resetDmAndUiState } from "../../helpers/dmHarness";
import { resetChannelsState } from "../../helpers/storeSeeds";

function countSource(initial: number): CountSource & { set: (n: number) => void } {
  let n = initial;
  const subs = new Set<() => void>();
  return {
    get: () => n,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    set: (next) => {
      n = next;
      for (const cb of subs) cb();
    },
  };
}

const standalones: Array<() => void> = [];
const flush = (): void => {
  channelsStore.flush();
  dmStore.flush();
  uiStore.flush();
  voiceStore.flush();
};

let container: HTMLDivElement;
let sidebar: ReturnType<typeof createChannelSidebar> | null = null;
let pending: ReturnType<typeof countSource>;
let opts: DmFolderOptions;
const onNewDm = vi.fn<() => void>();
const onSelectDm = vi.fn<(dm: DmChannel) => void>();

function folderOptions(over: Partial<DmFolderOptions> = {}): DmFolderOptions {
  return {
    onSelectDm,
    onNewDm,
    menu: undefined,
    destinations: {
      people: { build: vi.fn() },
      requests: { build: vi.fn(), pending },
    },
    onOpenView: vi.fn(),
    ...over,
  };
}

function mountTree(over: Partial<DmFolderOptions> = {}): void {
  opts = folderOptions(over);
  sidebar = createChannelSidebar({
    tree: true,
    onVoiceJoin: vi.fn(),
    onOpenCall: vi.fn(),
    direct: () => createDmFolder(opts),
  });
  sidebar.mount(container);
}

const dm = (id: number, extra: Partial<DmChannel> = {}): DmChannel =>
  makeDm({ channelId: id, recipient: dmRecipient(10 + id, `User${id}`), ...extra });

function seed(...channels: DmChannel[]): void {
  dmStore.setState(() => ({ channels }));
  for (const c of channels) addDmToChannelsStore(c);
  flush();
}

/** Replace one DM with a changed copy, as a store update would. */
function patch(id: number, change: (d: DmChannel) => DmChannel): void {
  dmStore.setState((p) => ({
    channels: p.channels.map((d) => (d.channelId === id ? change(d) : d)),
  }));
  flush();
}

const head = (): HTMLElement => container.querySelector<HTMLElement>(".server-tree-direct-head")!;
const people = (): HTMLElement =>
  container.querySelector<HTMLElement>("[data-testid=dm-people-entry]")!;
const requests = (): HTMLElement =>
  container.querySelector<HTMLElement>("[data-testid=dm-requests-entry]")!;
const rowEls = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-testid=dm-entry]"));
const row = (id: number): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-testid=dm-entry][data-channel-id="${id}"]`);
const badge = (): HTMLElement => head().querySelector<HTMLElement>(".dm-header-unread-badge")!;
const key = (target: Element, init: KeyboardEventInit): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
};
const collapse = (): void => {
  head().click();
  flush();
};

beforeEach(() => {
  localStorage.clear();
  invalidateMuteCache();
  resetDmAndUiState();
  resetChannelsState();
  voiceStore.setState((p) => ({ ...p, voiceUsers: new Map() }));
  pending = countSource(0);
  onNewDm.mockClear();
  onSelectDm.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  sidebar?.destroy?.();
  sidebar = null;
  for (const destroy of standalones.splice(0)) destroy();
  container.remove();
  document
    .querySelectorAll(".context-menu, [data-testid=dm-leave-modal]")
    .forEach((e) => e.remove());
});

describe("first draw and keys", () => {
  it("stamps the folder on the first render, even with no channels", () => {
    mountTree();
    expect(head().getAttribute("tabindex")).toBe("0");
    expect(head().getAttribute("aria-level")).toBe("1");
    expect(people().getAttribute("aria-level")).toBe("2");
  });

  it("puts People, Message requests and every conversation at level 2", () => {
    seed(dm(100), dm(101, { isGroup: true, name: "Crew", participants: [dmRecipient(5, "a")] }));
    mountTree();
    for (const el of [people(), requests(), ...rowEls()]) {
      expect(el.getAttribute("role")).toBe("treeitem");
      expect(el.getAttribute("aria-level")).toBe("2");
    }
    expect(rowEls()).toHaveLength(2);
  });

  it("walks Left from People to the header and Right from the header to People", () => {
    mountTree();
    people().focus();
    key(people(), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(head());
    key(head(), { key: "ArrowRight" });
    expect(document.activeElement).toBe(people());
  });

  it("opens People and Message requests from the keyboard", () => {
    mountTree();
    people().focus();
    key(people(), { key: "Enter" });
    expect(opts.onOpenView).toHaveBeenCalledWith("people", people());
    key(requests(), { key: "Enter" });
    expect(opts.onOpenView).toHaveBeenCalledWith("requests", requests());
  });
});

describe("the Message requests row", () => {
  it("is always there: no count at 0, a count and a name when one is waiting, the same node after", () => {
    mountTree();
    const entry = requests();
    const count = (): HTMLElement =>
      entry.querySelector<HTMLElement>("[data-testid=dm-requests-entry-badge]")!;
    expect(count().hidden).toBe(true);
    expect(entry.hasAttribute("aria-label")).toBe(false);

    entry.focus();
    pending.set(1);
    expect(count().hidden).toBe(false);
    expect(count().textContent).toBe("1");
    expect(entry.getAttribute("aria-label")).toBe("Message requests, 1 waiting");

    pending.set(0);
    expect(requests()).toBe(entry);
    expect(count().hidden).toBe(true);
    expect(document.activeElement).toBe(entry);
  });

  it("is absent only when the build has no requests destination", () => {
    mountTree({ destinations: { people: { build: vi.fn() } } });
    expect(container.querySelector("[data-testid=dm-requests-entry]")).toBeNull();
    expect(people()).not.toBeNull();
  });
});

describe("collapse", () => {
  it.each([
    ["no request waiting", 0],
    ["a request waiting", 2],
  ])("keeps the open chat, People and requests, and drops the rest (%s)", (_name, waiting) => {
    pending = countSource(waiting);
    seed(dm(100), dm(101), dm(102));
    setActiveChannel(101);
    flush();
    mountTree();
    const open = row(101)!;
    const [p, r] = [people(), requests()];

    collapse();

    expect(isCategoryCollapsed(DM_SECTION_COLLAPSED_KEY)).toBe(true);
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(rowEls()).toEqual([open]);
    expect(row(101)).toBe(open);
    expect(people()).toBe(p);
    expect(requests()).toBe(r);

    collapse();
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(rowEls().map((e) => e.dataset["channelId"])).toEqual(["100", "101", "102"]);
    expect(row(101)).toBe(open);
  });

  it("keeps focus on the header through a keyboard collapse", () => {
    seed(dm(100));
    mountTree();
    head().focus();
    key(head(), { key: "ArrowLeft" });
    flush();
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(head());
  });

  it("hands focus to the header when the focused row goes away", () => {
    seed(dm(100), dm(101));
    mountTree();
    row(100)!.focus();
    collapse();
    expect(row(100)).toBeNull();
    expect(document.activeElement).toBe(head());
  });

  it("hides every conversation when none is open", () => {
    seed(dm(100), dm(101));
    mountTree();
    collapse();
    expect(rowEls()).toEqual([]);
    expect(people()).not.toBeNull();
  });
});

describe("collapsed, the DMs with something waiting stay", () => {
  /** Set the joined call alone, as a local join or leave does, without touching who is in which channel. */
  const setCall = (id: number | null): void => {
    voiceStore.setState((p) => ({ ...p, currentChannelId: id }));
    flush();
  };
  const ids = (): Array<string | undefined> => rowEls().map((e) => e.dataset["channelId"]);

  afterEach(() => {
    voiceStore.setState((p) => ({ ...p, currentChannelId: null }));
    voiceStore.flush();
  });

  it("collapsed, it also keeps DMs with something unread and the DM whose call is joined, in the list's order", () => {
    seed(
      dm(100),
      dm(101, { unreadCount: 2 }),
      dm(102),
      dm(103),
      dm(104, { unreadCount: 1, mentionCount: 1 }),
    );
    setActiveChannel(103);
    setCall(102);
    mountTree();
    const kept = [row(101), row(102), row(103), row(104)];

    collapse();

    expect(ids()).toEqual(["101", "102", "103", "104"]);
    expect(rowEls()).toEqual(kept);
    expect(people()).not.toBeNull();
    expect(requests()).not.toBeNull();

    collapse();
    expect(ids()).toEqual(["100", "101", "102", "103", "104"]);
  });

  it("a muted DM with unread messages but no mention is not kept", () => {
    seed(dm(100, { unreadCount: 4 }), dm(101, { unreadCount: 2, mentionCount: 1 }));
    muteChannel(100);
    muteChannel(101);
    flush();
    mountTree();

    collapse();

    expect(ids()).toEqual(["101"]);
    // The badge counts what the collapsed list keeps: the muted DM's mention only.
    expect(badge().textContent).toBe("1");
  });

  it("a kept DM leaves the collapsed list once it is read, and focus on it moves to the header", () => {
    seed(dm(100, { unreadCount: 2 }), dm(101));
    mountTree();
    collapse();
    expect(ids()).toEqual(["100"]);
    row(100)!.focus();

    patch(100, (d) => ({ ...d, unreadCount: 0 }));

    expect(rowEls()).toEqual([]);
    expect(document.activeElement).toBe(head());
  });

  it("leaving the call drops the call DM unless it is the open chat", () => {
    seed(dm(100), dm(101));
    setActiveChannel(101);
    setCall(100);
    mountTree();
    collapse();
    expect(ids()).toEqual(["100", "101"]);
    row(100)!.focus();

    setCall(null);
    expect(ids()).toEqual(["101"]);
    expect(document.activeElement).toBe(head());

    const open = row(101);
    setCall(101);
    setCall(null);
    expect(rowEls()).toEqual([open]);
  });

  it("a change of the joined call alone redraws the collapsed list", () => {
    seed(dm(100), dm(101));
    mountTree();
    collapse();
    expect(rowEls()).toEqual([]);

    setCall(101);
    expect(ids()).toEqual(["101"]);

    setCall(100);
    expect(ids()).toEqual(["100"]);
  });
});

describe("a conversation row", () => {
  it("draws one presence dot, the name and no preview line for a 1:1 DM", () => {
    seed(dm(100, { lastMessage: "see you", lastMessageAt: "2026-01-01T00:00:00Z" }));
    mountTree();
    const el = row(100)!;
    expect(el.querySelector(".dm-section-status")).toBeNull();
    expect(el.querySelectorAll(".dm-status")).toHaveLength(1);
    expect(el.querySelector(".ch-name")?.textContent).toBe("User100");
    expect(el.querySelector(".dm-preview, .dm-preview-time, .dm-activity")).toBeNull();
    expect(el.getAttribute("title")).toBe("see you");
    expect(el.getAttribute("role")).toBe("treeitem");
    expect(el.getAttribute("data-tree-kind")).toBe("row");
  });

  it("shows a group's member count and no presence dot", () => {
    seed(
      dm(101, {
        isGroup: true,
        name: "Crew",
        participants: [dmRecipient(5, "a"), dmRecipient(6, "b")],
      }),
    );
    mountTree();
    const el = row(101)!;
    expect(el.querySelector(".dm-member-count")?.textContent).toBe("3");
    expect(el.querySelector(".dm-status")).toBeNull();
  });

  it("marks unread on an unmuted row only, and keeps a mention badge on a muted one", () => {
    seed(dm(100, { unreadCount: 3 }), dm(101, { unreadCount: 2 }), dm(102, { mentionCount: 1 }));
    muteChannel(101);
    muteChannel(102);
    flush();
    mountTree();
    expect(row(100)!.classList.contains("unread")).toBe(true);
    expect(row(100)!.querySelector(".dm-unread-badge")?.textContent).toBe("3");
    expect(row(101)!.classList.contains("unread")).toBe(false);
    expect(row(101)!.classList.contains("muted")).toBe(true);
    expect(row(101)!.querySelector(".dm-unread-badge.muted")).not.toBeNull();
    expect(row(102)!.querySelector(".dm-mention-badge")?.textContent).toBe("1");
  });

  it("selects the conversation on a click and on Enter", () => {
    seed(dm(100));
    mountTree();
    row(100)!.click();
    row(100)!.focus();
    key(row(100)!, { key: "Enter" });
    expect(onSelectDm).toHaveBeenCalledTimes(2);
    expect(onSelectDm.mock.calls[0]![0].channelId).toBe(100);
  });

  it("marks a DM opened by permalink while the sidebar is in channels mode", () => {
    seed(dm(100), dm(101));
    mountTree();
    expect(uiStore.getState().sidebarMode).toBe("channels");
    setActiveChannel(101);
    flush();
    expect(row(101)!.getAttribute("aria-current")).toBe("page");
    expect(row(101)!.classList.contains("active")).toBe(true);
    expect(row(100)!.hasAttribute("aria-current")).toBe(false);
  });
});

describe("the header", () => {
  it("shows the unread total, counting a muted DM's mentions only", () => {
    seed(
      dm(100, { unreadCount: 3 }),
      dm(101, { unreadCount: 5, mentionCount: 2 }),
      dm(102, { unreadCount: 4 }),
    );
    muteChannel(101);
    muteChannel(102);
    flush();
    mountTree();
    const channels = dmStore.getState().channels;
    expect(totalDmUnread(channels)).toBe(3 + 2);
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe(formatBadgeCount(totalDmUnread(channels)));
  });

  it("is hidden at zero and caps the total", () => {
    seed(dm(100, { unreadCount: 0 }));
    mountTree();
    expect(badge().hidden).toBe(true);
    patch(100, (d) => ({ ...d, unreadCount: 150 }));
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe(formatBadgeCount(150));
  });

  it('"+" starts a new DM once and does not toggle the folder', () => {
    mountTree();
    head().querySelector<HTMLElement>(".category-add-btn")!.click();
    flush();
    expect(onNewDm).toHaveBeenCalledTimes(1);
    expect(isCategoryCollapsed(DM_SECTION_COLLAPSED_KEY)).toBe(false);
    expect(head().querySelector(".category-add-btn")?.getAttribute("tabindex")).toBe("-1");
  });

  it("opens a one-item menu on Shift+F10 and on a right-click", () => {
    mountTree();
    head().focus();
    key(head(), { key: "F10", shiftKey: true });
    const item = document.querySelector<HTMLElement>("[data-testid=ctx-dm-new]");
    expect(item?.textContent).toContain("New DM");
    item!.click();
    expect(onNewDm).toHaveBeenCalledTimes(1);

    head().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(document.querySelector("[data-testid=ctx-dm-new]")).not.toBeNull();
  });

  it("names itself Direct and is a head item with a decorative chevron", () => {
    mountTree();
    expect(head().getAttribute("aria-labelledby")).toBe("server-tree-direct-label");
    expect(container.querySelector("#server-tree-direct-label")?.textContent).toBe("Direct");
    expect(head().getAttribute("data-tree-kind")).toBe("head");
    expect(head().querySelector(".category-arrow")?.getAttribute("aria-hidden")).toBe("true");
    expect(head().classList.contains("category")).toBe(false);
  });
});

describe("each model field rebuilds its row and no other", () => {
  const A = 100;
  const B = 101;
  const G = 102;
  const base = (): DmChannel[] => [
    dm(A, { lastMessage: "hi", lastMessageAt: "2026-01-01T00:00:00Z" }),
    dm(B),
    dm(G, {
      isGroup: true,
      name: "Crew",
      participants: [dmRecipient(5, "a"), dmRecipient(6, "b")],
    }),
  ];

  const changes: ReadonlyArray<readonly [string, number, () => void]> = [
    [
      "the name",
      A,
      () => patch(A, (d) => ({ ...d, recipient: { ...d.recipient, username: "Renamed" } })),
    ],
    [
      "the status",
      A,
      () => patch(A, (d) => ({ ...d, recipient: { ...d.recipient, status: "idle" } })),
    ],
    [
      "the avatar",
      A,
      () => patch(A, (d) => ({ ...d, recipient: { ...d.recipient, avatar: "x" } })),
    ],
    ["the group icon", G, () => patch(G, (d) => ({ ...d, icon: "x" }))],
    [
      "the participant count",
      G,
      () => patch(G, (d) => ({ ...d, participants: [...d.participants, dmRecipient(7, "c")] })),
    ],
    [
      "the mute",
      A,
      () => {
        muteChannel(A);
        flush();
      },
    ],
    ["the unread count", A, () => patch(A, (d) => ({ ...d, unreadCount: 2 }))],
    ["the mention count", A, () => patch(A, (d) => ({ ...d, mentionCount: 1 }))],
    [
      "the call state",
      A,
      () => {
        setVoiceStates([{ user_id: 11, channel_id: A, muted: false, deafened: false }]);
        flush();
      },
    ],
    [
      "the highlight",
      A,
      () => {
        setActiveChannel(A);
        flush();
      },
    ],
    ["the preview", A, () => patch(A, (d) => ({ ...d, lastMessage: "changed" }))],
  ];

  it.each(changes)("%s", (_name, target, change) => {
    seed(...base());
    mountTree();
    const before = new Map(rowEls().map((e) => [e.dataset["channelId"], e]));
    change();
    for (const [id, el] of before) {
      if (id === String(target)) expect(row(Number(id))).not.toBe(el);
      else expect(row(Number(id))).toBe(el);
    }
  });

  it("keeps every row for a change the folder does not draw (the time of the last message)", () => {
    seed(...base());
    mountTree();
    const before = rowEls();
    patch(A, (d) => ({ ...d, lastMessageAt: "2026-02-02T00:00:00Z" }));
    expect(rowEls()).toEqual(before);
  });
});

describe("a conversation that goes away", () => {
  const menu = {
    onCloseDm: vi.fn(),
  };

  it("moves the highlight to the DM a server close opens, never to a removed row", () => {
    seed(dm(100, { lastMessageId: 1 }), dm(101, { lastMessageId: 9 }));
    setActiveChannel(100);
    flush();
    mountTree();
    expect(row(100)!.getAttribute("aria-current")).toBe("page");

    handleDmChannelClose({ channel_id: 100 });
    flush();

    expect(row(100)).toBeNull();
    expect(row(101)!.getAttribute("aria-current")).toBe("page");
    expect(container.querySelectorAll("[aria-current=page][data-testid=dm-entry]")).toHaveLength(1);
  });

  it("highlights nothing when the last DM closes, and holds no removed row", () => {
    seed(dm(100));
    setActiveChannel(100);
    flush();
    mountTree();
    const gone = row(100)!;

    handleDmChannelClose({ channel_id: 100 });
    flush();

    expect(rowEls()).toEqual([]);
    expect(container.contains(gone)).toBe(false);
    expect(container.querySelector("[data-testid=dm-entry][aria-current]")).toBeNull();
  });

  it("closes an open leave prompt for the DM that went away", () => {
    seed(dm(100, { isGroup: true, name: "Crew", participants: [dmRecipient(5, "a")] }), dm(101));
    mountTree({ menu });
    row(100)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    document.querySelector<HTMLElement>("[data-testid=dm-close-100]")!.click();
    expect(document.querySelector("[data-testid=dm-leave-modal]")).not.toBeNull();

    handleDmChannelClose({ channel_id: 100 });
    flush();

    expect(document.querySelector("[data-testid=dm-leave-modal]")).toBeNull();
  });

  it("keeps a leave prompt open while its DM is still in the list", () => {
    seed(dm(100, { isGroup: true, name: "Crew", participants: [dmRecipient(5, "a")] }), dm(101));
    mountTree({ menu });
    row(100)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    document.querySelector<HTMLElement>("[data-testid=dm-close-100]")!.click();

    handleDmChannelClose({ channel_id: 101 });
    flush();

    expect(document.querySelector("[data-testid=dm-leave-modal]")).not.toBeNull();
  });
});

describe("redraws", () => {
  function standalone(): {
    render: ReturnType<typeof vi.fn>;
    el: HTMLElement;
    destroy: () => void;
  } {
    const folder = createDmFolder(folderOptions());
    container.appendChild(folder.element);
    const render = vi.fn();
    folder.onRender(render);
    standalones.push(folder.destroy);
    return { render, el: folder.element, destroy: folder.destroy };
  }

  it("draws itself on creation without calling onRender", () => {
    seed(dm(100));
    const { render, el } = standalone();
    expect(el.querySelectorAll("[data-testid=dm-entry]")).toHaveLength(1);
    expect(render).not.toHaveBeenCalled();
  });

  it.each<readonly [string, () => void]>([
    [
      "a mute event",
      () => {
        muteChannel(100);
        flush();
      },
    ],
    [
      "a voice channel becoming occupied",
      () => {
        setVoiceStates([{ user_id: 11, channel_id: 100, muted: false, deafened: false }]);
        flush();
      },
    ],
    ["a DM list change", () => patch(100, (d) => ({ ...d, unreadCount: 1 }))],
    [
      "an open-channel change",
      () => {
        setActiveChannel(100);
        flush();
      },
    ],
    ["a collapse toggle", collapse],
  ])("redraws once on %s", (_name, trigger) => {
    seed(dm(100));
    const { render } = standalone();
    trigger();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("does not redraw on a speaking flip, and a mode change only scrolls", () => {
    seed(dm(100));
    setVoiceStates([{ user_id: 11, channel_id: 100, muted: false, deafened: false }]);
    flush();
    const { render, el } = standalone();
    const before = Array.from(el.querySelectorAll("[data-testid=dm-entry]"));
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");

    voiceStore.setState((p) => ({ ...p, speakers: new Set([11]) }));
    flush();
    expect(render).not.toHaveBeenCalled();

    setSidebarMode("dms");
    flush();
    expect(render).not.toHaveBeenCalled();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(Array.from(el.querySelectorAll("[data-testid=dm-entry]"))).toEqual(before);
    scroll.mockRestore();
  });

  it("stops redrawing once destroyed", () => {
    seed(dm(100));
    const { render, destroy } = standalone();
    destroy();
    patch(100, (d) => ({ ...d, unreadCount: 1 }));
    muteChannel(100);
    expect(render).not.toHaveBeenCalled();
  });

  it("keeps the collapsed state, the highlight and every row through a ready resync", () => {
    seed(dm(100), dm(101));
    setActiveChannel(101);
    flush();
    mountTree();
    collapse();
    const open = row(101)!;

    // `ready` replaces the list with equal data in new objects.
    dmStore.setState((p) => ({
      channels: p.channels.map((d) => ({ ...d, recipient: { ...d.recipient } })),
    }));
    flush();

    expect(isCategoryCollapsed(DM_SECTION_COLLAPSED_KEY)).toBe(true);
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(row(101)).toBe(open);
    expect(open.getAttribute("aria-current")).toBe("page");

    collapse();
    const all = rowEls();
    dmStore.setState((p) => ({ channels: p.channels.map((d) => ({ ...d })) }));
    flush();
    expect(rowEls()).toEqual(all);
  });

  it("adds no subscription or listener over 20 renders", () => {
    seed(dm(100), dm(101));
    mountTree();
    const spies = [
      vi.spyOn(channelsStore, "subscribeSelector"),
      vi.spyOn(dmStore, "subscribeSelector"),
      vi.spyOn(uiStore, "subscribeSelector"),
      vi.spyOn(voiceStore, "subscribeSelector"),
      vi.spyOn(window, "addEventListener"),
    ];
    for (let i = 1; i <= 20; i++) patch(100, (d) => ({ ...d, unreadCount: i }));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
