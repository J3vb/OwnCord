import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../helpers/memberListMocks";
import "../../../src/features/profiles/userProfilePopup";
import "../../../src/features/moderation/AdminActions";
import { createMemberList } from "../../../src/features/members/MemberList";
import { classicMemberRows, classicView } from "../../../src/features/members/memberRowRenderer";
import { flattenModel, type MemberModel } from "../../../src/features/members/memberModel";
import { membersStore, updatePresence } from "@stores/members.store";
import { channelsStore } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import { makeChannel } from "../../helpers/channelFactory";
import { resetVoiceState } from "../../helpers/storeSeeds";
import { voiceUser } from "../../helpers/voiceUsers";
import {
  defaultOpts,
  makeMember,
  setTestMembers,
  useMemberListSuite,
} from "../../helpers/memberListHarness";
import { runListContract, tagSource, type ContractEntry } from "../../helpers/memberListContract";
import { buddiesListOptions } from "../../../src/features/members/buddies/buddiesSetup";

const classicEntry: ContractEntry = {
  options: { view: classicView() },
  headerSelector: ".member-role-group",
  firstHeader: { before: "ADMIN — 1", after: "ADMIN — 2" },
};

/** Command Deck's options, as the member panel passes them. */
function deckOptions(): ContractEntry["options"] {
  const options = buddiesListOptions();
  if (options.view === undefined) throw new Error("the Deck options carry no view");
  return { ...options, view: options.view };
}

const deckEntry: ContractEntry = {
  options: deckOptions(),
  headerSelector: ".buddies-group",
  firstHeader: { before: "ONLINE — 3", after: "ONLINE — 4" },
};

const ENTRIES: Readonly<Record<string, ContractEntry>> = {
  classic: classicEntry,
  deck: deckEntry,
};

for (const [name, entry] of Object.entries(ENTRIES)) runListContract(name, entry);

const roster = () => [
  makeMember({ id: 1, username: "ann" }),
  makeMember({ id: 2, username: "bob" }),
  makeMember({ id: 3, username: "cy", status: "offline" }),
];

describe("member list options: view, rows and flatten", () => {
  let host: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;
  useMemberListSuite(
    (c) => {
      host = c;
      list = null;
    },
    () => list,
  );

  const tagOf = (id: number): string | undefined =>
    host.querySelector<HTMLElement>(`[data-testid="member-${id}"]`)?.dataset["tag"];

  it("a context change with no member change patches the drawn rows in place", () => {
    setTestMembers(roster());
    const source = tagSource("one");
    list = createMemberList({ ...defaultOpts(), view: source.view });
    list.mount(host);
    const row = host.querySelector<HTMLElement>('[data-testid="member-2"]')!;
    row.focus();
    expect(tagOf(2)).toBe("one");

    source.set("two");

    expect(source.seen.at(-1)).toBe("two");
    expect(host.querySelector('[data-testid="member-2"]')).toBe(row);
    expect(tagOf(1)).toBe("two");
    expect(tagOf(2)).toBe("two");
    expect(document.activeElement).toBe(row);
  });

  it("a member change reads the current context", () => {
    setTestMembers(roster());
    const source = tagSource("one");
    list = createMemberList({ ...defaultOpts(), view: source.view });
    list.mount(host);
    source.set("two");
    updatePresence(1, "idle");
    membersStore.flush();
    expect(tagOf(1)).toBe("two");
  });

  it("destroy ends the view's subscription", () => {
    setTestMembers(roster());
    const source = tagSource("one");
    list = createMemberList({ ...defaultOpts(), view: source.view });
    list.mount(host);
    expect(source.listening()).toBe(true);
    list.destroy?.();
    list = null;
    expect(source.listening()).toBe(false);
  });

  it("the view wins over rows", () => {
    setTestMembers(roster());
    const source = tagSource("view");
    list = createMemberList({ ...defaultOpts(), rows: classicMemberRows, view: source.view });
    list.mount(host);
    expect(tagOf(1)).toBe("view");
  });

  it("flatten gets the model, the search text and an empty collapsed set", () => {
    setTestMembers(roster());
    const flatten = vi.fn((model: MemberModel, query: string, _collapsed: ReadonlySet<string>) =>
      flattenModel(model, query),
    );
    list = createMemberList({ ...defaultOpts(), flatten });
    list.mount(host);
    const box = host.querySelector<HTMLInputElement>('[data-testid="member-search"]')!;
    box.value = "bo";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const [model, query, collapsed] = flatten.mock.lastCall!;
    expect(model.members.size).toBe(3);
    expect(query).toBe("bo");
    expect(collapsed.size).toBe(0);
    expect(host.querySelectorAll(".member-item")).toHaveLength(1);
  });

  it("a flatten of its own decides the drawn items", () => {
    setTestMembers(roster());
    list = createMemberList({
      ...defaultOpts(),
      flatten: (model) =>
        [...model.members.values()].map((member) => ({
          kind: "row" as const,
          key: `u:${member.id}`,
          member,
          colorVar: "var(--text-normal)",
        })),
    });
    list.mount(host);
    expect(host.querySelector(".member-role-group")).toBeNull();
    expect(host.querySelectorAll(".member-item")).toHaveLength(3);
  });
});

describe("member list contract: deck", () => {
  let host: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;
  useMemberListSuite(
    (c) => {
      host = c;
      list = null;
      resetVoiceState();
      channelsStore.setState((prev) => ({ ...prev, channels: new Map() }));
    },
    () => list,
  );

  const mount = (): void => {
    setTestMembers([
      makeMember({ id: 1, username: "ann" }),
      makeMember({ id: 2, username: "bob", status: "idle" }),
      makeMember({ id: 3, username: "cy", status: "offline" }),
    ]);
    list = createMemberList({ ...defaultOpts(), ...deckOptions() });
    list.mount(host);
  };
  const row = (id: number): HTMLElement =>
    host.querySelector<HTMLElement>(`[data-testid="member-${id}"]`)!;
  const headers = (): string[] =>
    [...host.querySelectorAll(".buddies-group")].map((el) => el.textContent ?? "");

  it("keeps focus on a member who starts a game while idle, then stops", () => {
    mount();
    const away = host.querySelector('[data-testid="buddies-group-away"]');
    const online = host.querySelector('[data-testid="buddies-group-online"]');
    row(2).focus();
    updatePresence(2, "idle", undefined, undefined, { name: "Chess", started_at: 1 });
    membersStore.flush();
    expect(headers()).toEqual(["IN GAME — 1", "ONLINE — 1", "OFFLINE — 1"]);
    expect(document.activeElement).toBe(row(2));
    expect(host.querySelector('[data-testid="buddies-group-online"]')).toBe(online);
    updatePresence(2, "idle", undefined, undefined, null);
    membersStore.flush();
    expect(headers()).toEqual(["ONLINE — 1", "AWAY — 1", "OFFLINE — 1"]);
    expect(document.activeElement).toBe(row(2));
    expect(host.querySelector('[data-testid="buddies-group-away"]')).not.toBe(away);
  });

  it("patches the voice icon in place when a member joins a room", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[6, makeChannel({ id: 6, name: "Lounge", type: "voice" })]]),
    }));
    channelsStore.flush();
    mount();
    const kept = row(1);
    kept.focus();
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([[6, new Map([[1, voiceUser(1, { username: "ann" })]])]]),
    }));
    voiceStore.flush();
    expect(row(1)).toBe(kept);
    expect(document.activeElement).toBe(kept);
    expect(kept.querySelector<HTMLElement>(".buddy-voice")?.title).toBe("In Lounge");
  });
});

describe("member list contract: deck, folded groups", () => {
  let host: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;
  beforeEach(() => localStorage.removeItem("owncord:settings:buddiesCollapsed"));
  useMemberListSuite(
    (c) => {
      host = c;
      list = null;
      resetVoiceState();
    },
    () => list,
  );

  /** ann and bob online, cy and dee offline. */
  const mount = (): void => {
    setTestMembers([
      makeMember({ id: 1, username: "ann" }),
      makeMember({ id: 2, username: "bob" }),
      makeMember({ id: 3, username: "cy", status: "offline" }),
      makeMember({ id: 4, username: "dee", status: "offline" }),
    ]);
    list = createMemberList({ ...defaultOpts(), ...deckOptions() });
    list.mount(host);
  };
  const row = (id: number): HTMLElement | null =>
    host.querySelector<HTMLElement>(`[data-testid="member-${id}"]`);
  const header = (group: string): HTMLElement =>
    host.querySelector<HTMLElement>(`[data-testid="buddies-group-${group}"]`)!;
  const press = (el: HTMLElement, k: string): void => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  };
  const search = (text: string): void => {
    const box = host.querySelector<HTMLInputElement>('[data-testid="member-search"]')!;
    box.value = text;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("a header is a Tab stop with no search and plain text during one", () => {
    mount();
    expect(header("online").getAttribute("tabindex")).toBe("0");
    expect(header("offline").getAttribute("aria-expanded")).toBe("true");
    search("a");
    expect(header("online").hasAttribute("tabindex")).toBe(false);
    expect(header("online").hasAttribute("aria-expanded")).toBe(false);
    search("");
    expect(header("online").getAttribute("tabindex")).toBe("0");
  });

  it("Enter folds the focused header in place, and a search still shows its rows", () => {
    mount();
    const offline = header("offline");
    offline.focus();
    press(offline, "Enter");
    expect(header("offline")).toBe(offline);
    expect(document.activeElement).toBe(offline);
    expect(offline.getAttribute("aria-expanded")).toBe("false");
    expect(offline.textContent).toBe("OFFLINE — 2");
    expect(row(3)).toBeNull();
    expect(row(4)).toBeNull();
    expect(row(1)).not.toBeNull();

    search("dee");
    expect(row(4)).not.toBeNull();
    expect(header("offline").textContent).toBe("OFFLINE — 1");
    search("");
    expect(row(4)).toBeNull();

    press(header("offline"), " ");
    expect(row(3)).not.toBeNull();
  });

  it("a click folds and opens a group, and the fold is kept on the device", () => {
    mount();
    header("online").click();
    expect(row(1)).toBeNull();
    list?.destroy?.();
    host.replaceChildren();
    mount();
    expect(row(1)).toBeNull();
    expect(header("online").getAttribute("aria-expanded")).toBe("false");
    header("online").click();
    expect(row(1)).not.toBeNull();
  });

  it("a focused member who goes offline while OFFLINE is folded leaves focus on its header", () => {
    mount();
    header("offline").click();
    row(2)!.focus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    updatePresence(2, "offline");
    membersStore.flush();
    expect(row(2)).toBeNull();
    expect(document.activeElement).toBe(header("offline"));
    expect(header("offline").textContent).toBe("OFFLINE — 3");
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it("a focused member renamed while their group is open keeps row focus", () => {
    mount();
    header("offline").click();
    row(2)!.focus();
    setTestMembers([
      makeMember({ id: 1, username: "ann" }),
      makeMember({ id: 2, username: "bob", displayName: "Bobby" }),
      makeMember({ id: 3, username: "cy", status: "offline" }),
      makeMember({ id: 4, username: "dee", status: "offline" }),
    ]);
    membersStore.flush();
    expect(document.activeElement).toBe(row(2));
  });

  it("a focused row that leaves a search's matches gives focus to a row, not a plain header", () => {
    setTestMembers([
      makeMember({ id: 1, username: "ann" }),
      makeMember({ id: 2, username: "bob" }),
      makeMember({ id: 5, username: "bea" }),
    ]);
    list = createMemberList({ ...defaultOpts(), ...deckOptions() });
    list.mount(host);
    search("b");
    row(2)!.focus();
    setTestMembers([
      makeMember({ id: 1, username: "ann" }),
      makeMember({ id: 2, username: "rex" }),
      makeMember({ id: 5, username: "bea" }),
    ]);
    membersStore.flush();
    expect(row(2)).toBeNull();
    expect(header("online").hasAttribute("tabindex")).toBe(false);
    expect(document.activeElement).toBe(row(5));
  });

  it("a fold saved between building the options and mounting is drawn", () => {
    setTestMembers([
      makeMember({ id: 1, username: "ann" }),
      makeMember({ id: 3, username: "cy", status: "offline" }),
    ]);
    const options = deckOptions();
    localStorage.setItem("owncord:settings:buddiesCollapsed", JSON.stringify(["a:offline"]));
    list = createMemberList({ ...defaultOpts(), ...options });
    list.mount(host);
    expect(header("offline").getAttribute("aria-expanded")).toBe("false");
    expect(row(3)).toBeNull();
  });

  it("a focused header whose group empties gives focus to the first row in view", () => {
    mount();
    header("online").click();
    const online = header("online");
    online.focus();
    updatePresence(1, "offline");
    updatePresence(2, "offline");
    membersStore.flush();
    expect(online.isConnected).toBe(false);
    expect(document.activeElement).toBe(row(1));
  });

  it("arrows, Home and End on a header are left to the browser", () => {
    mount();
    const online = header("online");
    online.focus();
    for (const k of ["ArrowDown", "End", "Home"]) {
      const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
      online.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(online);
    }
  });

  it("Classic's role headers never fold", () => {
    mount();
    list?.destroy?.();
    list = createMemberList(defaultOpts());
    list.mount(host);
    const roleHeader = host.querySelector<HTMLElement>(".member-role-group")!;
    expect(roleHeader.hasAttribute("tabindex")).toBe(false);
    roleHeader.click();
    expect(host.querySelectorAll(".member-item")).toHaveLength(4);
  });
});
