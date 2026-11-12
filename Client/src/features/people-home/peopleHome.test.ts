// The People view: who it lists, Active now, and that a live update keeps the
// search text and the focused Message button. Also the phone's Active now strip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { ApiClient } from "@lib/api";
import type { UserStatus } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { blocksStore } from "@stores/blocks.store";
import { channelsStore, type Channel } from "@stores/channels.store";
import { membersStore, type Member } from "@stores/members.store";
import { voiceStore, type VoiceUser } from "@stores/voice.store";
import { activeNow, peopleRows } from "./model";
import { renderPeopleHome } from "./PeopleHome";
import { renderActiveStrip } from "./activeStrip";

const ME = 1;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function member(
  id: number,
  username: string,
  status: UserStatus,
  extra: Partial<Member> = {},
): Member {
  return { id, username, avatar: null, role: "member", status, ...extra };
}

function roster(...list: Member[]): Map<number, Member> {
  return new Map(list.map((m) => [m.id, m]));
}

function voiceChannel(id: number, name: string, type: "voice" | "dm"): Channel {
  return {
    id,
    name,
    type,
    category: null,
    position: id,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    topic: "",
    slowMode: 0,
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
  };
}

function inVoice(...userIds: number[]): ReadonlyMap<number, VoiceUser> {
  return new Map(
    userIds.map((userId) => [
      userId,
      {
        userId,
        username: `u${userId}`,
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    ]),
  );
}

/** Delivers the stores' pending notifications, then the view's one redraw for the frame. */
function flush(): void {
  membersStore.flush();
  voiceStore.flush();
  channelsStore.flush();
  blocksStore.flush();
  vi.advanceTimersToNextFrame();
}

function setRoster(...list: Member[]): void {
  membersStore.setState((prev) => ({ ...prev, members: roster(...list) }));
  flush();
}

const noScope = { selfId: ME, blocked: new Set<number>() };

describe("peopleRows", () => {
  const members = roster(
    member(ME, "me", "online"),
    member(2, "zed", "online"),
    member(3, "amy", "idle", { displayName: "Amy Pond" }),
    member(4, "bob", "offline"),
    member(5, "ghost", "invisible"),
    member(6, "carl", "dnd"),
  );

  it("lists online people by name, without you", () => {
    expect(peopleRows(members.values(), noScope, "online", "").map((p) => p.id)).toEqual([3, 6, 2]);
  });

  it("lists everyone on the All tab, offline and invisible too", () => {
    expect(peopleRows(members.values(), noScope, "all", "").map((p) => p.id)).toEqual([
      3, 4, 6, 5, 2,
    ]);
  });

  it("leaves out people you blocked", () => {
    const scope = { selfId: ME, blocked: new Set([6]) };
    expect(peopleRows(members.values(), scope, "online", "").map((p) => p.id)).toEqual([3, 2]);
  });

  it("searches the shown name and the username, ignoring case", () => {
    expect(peopleRows(members.values(), noScope, "all", "POND").map((p) => p.id)).toEqual([3]);
    expect(peopleRows(members.values(), noScope, "all", " amy ").map((p) => p.id)).toEqual([3]);
  });

  it("shows the custom status, else the game, else the status", () => {
    const list = roster(
      member(2, "a", "online", { customStatus: "brb", activity: { name: "Chess", startedAt: 0 } }),
      member(3, "b", "online", { activity: { name: "Chess", startedAt: 0 } }),
      member(4, "c", "idle"),
    );
    const lines = peopleRows(list.values(), noScope, "online", "").map((p) => [p.line, p.lineIcon]);
    expect(lines).toEqual([
      ["brb", null],
      ["Playing Chess", "gamepad-2"],
      ["Idle", null],
    ]);
  });
});

describe("activeNow", () => {
  it("lists people playing or in a server voice channel, never a DM call", () => {
    const members = roster(
      member(ME, "me", "online", { activity: { name: "Chess", startedAt: 0 } }),
      member(2, "gamer", "online", { activity: { name: "Chess", startedAt: 0 } }),
      member(3, "talker", "online"),
      member(4, "caller", "online"),
      member(5, "quiet", "online"),
      member(6, "away", "offline", { activity: { name: "Chess", startedAt: 0 } }),
    );
    const channels = new Map([
      [10, voiceChannel(10, "Lounge", "voice")],
      [20, voiceChannel(20, "secret call", "dm")],
    ]);
    const voice = new Map([
      [10, inVoice(3, 2)],
      [20, inVoice(4)],
      [30, inVoice(5)],
    ]);
    const cards = activeNow(members, voice, channels, noScope);
    expect(cards.map((c) => [c.id, c.game, c.voiceChannel])).toEqual([
      [2, "Playing Chess", "Lounge"],
      [3, null, "Lounge"],
    ]);
  });
});

describe("the view", () => {
  let root: HTMLDivElement;
  let owner: AbortController;
  const messageUser = vi.fn();

  function rowIds(): string[] {
    return [...root.querySelectorAll<HTMLElement>("[data-testid='people-list'] > li")].map(
      (li) => li.dataset["testid"] ?? "",
    );
  }

  beforeEach(() => {
    document.body.replaceChildren();
    authStore.setState((prev) => ({
      ...prev,
      user: { id: ME, username: "me", avatar: null, role: "member" },
    }));
    setRoster(member(ME, "me", "online"), member(2, "amy", "online"), member(3, "bob", "offline"));
    root = document.createElement("div");
    document.body.appendChild(root);
    owner = new AbortController();
    renderPeopleHome(root, {
      signal: owner.signal,
      close: vi.fn(),
      api: {} as ApiClient,
      messageUser,
    });
  });

  afterEach(() => {
    owner.abort();
    messageUser.mockReset();
  });

  it("starts on Online and switches to All", () => {
    expect(rowIds()).toEqual(["people-row-2"]);
    expect(root.querySelector("[data-testid='people-count']")?.textContent).toBe("Online — 1");
    root.querySelector<HTMLButtonElement>("[data-testid='people-tab-all']")?.click();
    expect(rowIds()).toEqual(["people-row-2", "people-row-3"]);
    expect(root.querySelector("[data-testid='people-tab-all']")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("opens the DM from the Message button and from the row", () => {
    root.querySelector<HTMLButtonElement>("[data-testid='people-message-2']")?.click();
    expect(messageUser).toHaveBeenCalledTimes(1);
    expect(messageUser).toHaveBeenLastCalledWith(2);
    root.querySelector<HTMLElement>("[data-testid='people-row-2'] .mi-name")?.click();
    expect(messageUser).toHaveBeenCalledTimes(2);
  });

  it("keeps the search and the focused button through a presence update", () => {
    const search = root.querySelector<HTMLInputElement>("[data-testid='people-search']")!;
    search.value = "a";
    search.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>("[data-testid='people-message-2']")?.focus();

    setRoster(
      member(ME, "me", "online"),
      member(2, "amy", "idle"),
      member(3, "bob", "offline"),
      member(4, "ada", "online"),
    );

    expect(search.value).toBe("a");
    expect(rowIds()).toEqual(["people-row-4", "people-row-2"]);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("people-message-2");
  });

  it("says so when nobody matches", () => {
    const search = root.querySelector<HTMLInputElement>("[data-testid='people-search']")!;
    search.value = "zzz";
    search.dispatchEvent(new Event("input"));
    const empty = root.querySelector<HTMLElement>("[data-testid='people-empty']")!;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe("No one matches “zzz”.");
  });

  it("stops updating once its view closes", () => {
    owner.abort();
    setRoster(member(ME, "me", "online"), member(5, "late", "online"));
    expect(rowIds()).toEqual(["people-row-2"]);
  });

  it("shows who sits in voice under Active now", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[10, voiceChannel(10, "Lounge", "voice")]]),
    }));
    voiceStore.setState((prev) => ({ ...prev, voiceUsers: new Map([[10, inVoice(2)]]) }));
    flush();
    const card = root.querySelector<HTMLElement>("[data-testid='people-active-2']")!;
    expect(card.textContent).toContain("In Lounge");
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(messageUser).toHaveBeenCalledWith(2);
  });

  it("keeps focus on an Active now card through an update", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[10, voiceChannel(10, "Lounge", "voice")]]),
    }));
    voiceStore.setState((prev) => ({ ...prev, voiceUsers: new Map([[10, inVoice(2)]]) }));
    flush();
    root.querySelector<HTMLElement>("[data-testid='people-active-2']")?.focus();
    setRoster(member(ME, "me", "online"), member(2, "amy", "idle"), member(3, "bob", "online"));
    expect(document.activeElement?.getAttribute("data-testid")).toBe("people-active-2");
  });

  it("keeps a row's element across a presence update and patches what changed", () => {
    const before = root.querySelector<HTMLElement>("[data-testid='people-row-2']")!;
    setRoster(member(ME, "me", "online"), member(2, "amy", "idle"), member(3, "bob", "offline"));
    const after = root.querySelector<HTMLElement>("[data-testid='people-row-2']")!;
    expect(after).toBe(before);
    expect(after.querySelector(".mi-custom-status")?.textContent).toBe("Idle");
  });

  it("keeps the avatar element when only the status changed", () => {
    const avatar = root.querySelector("[data-testid='people-row-2'] .mi-avatar");
    setRoster(member(ME, "me", "online"), member(2, "amy", "idle"), member(3, "bob", "offline"));
    const row = root.querySelector("[data-testid='people-row-2']")!;
    expect(row.querySelector(".mi-avatar")).toBe(avatar);
    expect(row.querySelector(".mi-status")?.getAttribute("aria-label")).toMatch(/idle/i);
  });

  it("keeps rows by identity while others join, leave and reorder", () => {
    setRoster(
      member(ME, "me", "online"),
      member(2, "amy", "online"),
      member(4, "ada", "online"),
      member(5, "zoe", "online"),
    );
    const amy = root.querySelector("[data-testid='people-row-2']");
    const zoe = root.querySelector("[data-testid='people-row-5']");
    expect(rowIds()).toEqual(["people-row-4", "people-row-2", "people-row-5"]);
    setRoster(
      member(ME, "me", "online"),
      member(2, "amy", "online", { displayName: "Zzz" }),
      member(5, "zoe", "online"),
    );
    expect(rowIds()).toEqual(["people-row-5", "people-row-2"]);
    expect(root.querySelector("[data-testid='people-row-2']")).toBe(amy);
    expect(root.querySelector("[data-testid='people-row-5']")).toBe(zoe);
  });

  it("draws a burst of changes once, on the next frame", () => {
    const draws = vi.spyOn(membersStore, "getState");
    for (let i = 10; i < 20; i++) {
      membersStore.setState((prev) => ({
        ...prev,
        members: new Map(prev.members).set(i, member(i, `user${i}`, "online")),
      }));
      membersStore.flush();
    }
    expect(rowIds()).toEqual(["people-row-2"]);
    draws.mockClear();
    vi.advanceTimersToNextFrame();
    expect(draws).toHaveBeenCalledTimes(1);
    expect(rowIds()).toHaveLength(11);
    draws.mockRestore();
  });

  it("ignores a channel update that changes no name", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[10, voiceChannel(10, "Lounge", "voice")]]),
    }));
    flush();
    const before = rowIds();
    const row = root.querySelector("[data-testid='people-row-2']");
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[10, { ...voiceChannel(10, "Lounge", "voice"), unreadCount: 3 }]]),
    }));
    channelsStore.flush();
    const spy = vi.spyOn(membersStore, "getState");
    vi.advanceTimersToNextFrame();
    expect(spy).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(before);
    expect(root.querySelector("[data-testid='people-row-2']")).toBe(row);
    spy.mockRestore();
  });

  it("moves focus to the search when the focused person leaves the tab", () => {
    root.querySelector<HTMLButtonElement>("[data-testid='people-message-2']")?.focus();
    setRoster(member(ME, "me", "online"), member(2, "amy", "offline"));
    expect(document.activeElement?.getAttribute("data-testid")).toBe("people-search");
  });
});

describe("the phone Active now strip", () => {
  let strip: HTMLUListElement;
  let owner: AbortController;
  const onOpen = vi.fn();

  function cardIds(): string[] {
    return [...strip.querySelectorAll<HTMLElement>("[data-active-id]")].map(
      (b) => b.dataset["activeId"] ?? "",
    );
  }

  beforeEach(() => {
    document.body.replaceChildren();
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[10, voiceChannel(10, "Lounge", "voice")]]),
    }));
    voiceStore.setState((prev) => ({ ...prev, voiceUsers: new Map() }));
    setRoster(member(ME, "me", "online"), member(2, "amy", "online"), member(3, "bob", "online"));
    strip = document.createElement("ul");
    document.body.appendChild(strip);
    owner = new AbortController();
    renderActiveStrip(strip, { signal: owner.signal, onOpen });
  });

  afterEach(() => {
    owner.abort();
    onOpen.mockReset();
  });

  it("hides while nobody plays or sits in voice", () => {
    expect(strip.hidden).toBe(true);
    expect(cardIds()).toEqual([]);
  });

  it("shows a game and a voice seat, and a tap opens that DM", () => {
    setRoster(
      member(ME, "me", "online"),
      member(2, "amy", "online"),
      member(3, "bob", "online", { activity: { name: "Chess", startedAt: 0 } }),
    );
    voiceStore.setState((prev) => ({ ...prev, voiceUsers: new Map([[10, inVoice(2)]]) }));
    flush();
    expect(strip.hidden).toBe(false);
    expect(cardIds()).toEqual(["2", "3"]);
    const amy = strip.querySelector<HTMLButtonElement>("[data-testid='dm-active-2']")!;
    expect(amy.textContent).toContain("In Lounge");
    expect(strip.querySelector("[data-testid='dm-active-3']")?.textContent).toContain(
      "Playing Chess",
    );
    amy.click();
    expect(onOpen).toHaveBeenCalledWith(2);
  });

  it("keeps focus on a card through an update and stops after its owner goes", () => {
    voiceStore.setState((prev) => ({ ...prev, voiceUsers: new Map([[10, inVoice(2, 3)]]) }));
    flush();
    strip.querySelector<HTMLButtonElement>("[data-testid='dm-active-3']")?.focus();
    setRoster(member(ME, "me", "online"), member(2, "amy", "idle"), member(3, "bob", "online"));
    expect(document.activeElement?.getAttribute("data-testid")).toBe("dm-active-3");

    owner.abort();
    voiceStore.setState((prev) => ({ ...prev, voiceUsers: new Map() }));
    flush();
    expect(cardIds()).toEqual(["2", "3"]);
  });
});
