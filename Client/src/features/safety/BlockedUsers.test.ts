// 3B-7: the Privacy & Safety tab's blocked-users list — load, empty, error and
// Retry, unblock success and failure, live updates from blocksStore, name
// fallback and the teardown/refetch edge cases.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/ui/toast", () => ({ showToast: vi.fn() }));

import { expectConsole } from "../../../tests/helpers/console";
import { captureLogs } from "../../../tests/helpers/log-capture";
import { ApiClientError } from "@lib/api";
import { showToast } from "../../lib/ui/toast";
import { blocksStore, setUserBlockedByMe } from "@stores/blocks.store";
import { dmStore, type DmChannel, type DmUser } from "@stores/dm.store";
import { membersStore, type Member } from "@stores/members.store";
import { createAvatarElement } from "@components/message-list/avatar";
import {
  buildBlockedUsersSection,
  resetPendingUnblocks,
  type BlockedUsersApi,
  type CreateAvatar,
} from "./BlockedUsers";

interface Deferred<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  signal: AbortSignal | undefined;
}

let gets: Deferred<{ blocked_user_ids: number[] }>[];
let deletes: (Deferred<void> & { userId: number })[];
let tab: AbortController;

const api: BlockedUsersApi = {
  listBlocks: (signal) => new Promise((resolve, reject) => gets.push({ resolve, reject, signal })),
  unblockUser: (userId, signal) =>
    new Promise<void>((resolve, reject) => deletes.push({ resolve, reject, signal, userId })),
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function member(id: number, username: string, over: Partial<Member> = {}): Member {
  return { id, username, avatar: null, role: "member", status: "online", ...over };
}

function setRoster(...ms: Member[]): void {
  membersStore.setState((prev) => ({ ...prev, members: new Map(ms.map((m) => [m.id, m])) }));
}

function setDms(...channels: DmChannel[]): void {
  dmStore.setState((prev) => ({ ...prev, channels }));
}

function dm(userId: number, username: string, displayName = ""): DmChannel {
  const user = { id: userId, username, avatar: "", status: "online", displayName };
  return {
    channelId: 900 + userId,
    recipient: user,
    participants: [user],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
  };
}

function mount(): HTMLElement {
  const section = buildBlockedUsersSection(tab.signal, api, createAvatarElement);
  document.body.appendChild(section);
  return section;
}

const rowsOf = (s: HTMLElement): HTMLElement[] => [
  ...s.querySelectorAll<HTMLElement>("[data-testid='blocked-user-row']"),
];
const status = (s: HTMLElement): string => s.querySelector("[role=status]")!.textContent ?? "";
const alertText = (s: HTMLElement): string => s.querySelector("[role=alert]")!.textContent ?? "";
const retryBtn = (s: HTMLElement): HTMLButtonElement =>
  s.querySelector<HTMLButtonElement>("[data-testid='blocked-users-retry']")!;
const unblockBtn = (r: HTMLElement): HTMLButtonElement =>
  r.querySelector<HTMLButtonElement>("[data-testid='blocked-user-unblock']")!;

beforeEach(() => {
  resetPendingUnblocks();
  gets = [];
  deletes = [];
  tab = new AbortController();
  blocksStore.setState(() => ({
    blockedByMe: new Set(),
    blockedByThem: new Set(),
    blockedByMeRev: 0,
  }));
  setRoster();
  setDms();
  vi.mocked(showToast).mockClear();
});
afterEach(() => {
  tab.abort();
  document.body.replaceChildren();
});

const idOf = (s: HTMLElement): number =>
  Number(/^blocked-users-(\d+)$/.exec(s.querySelector("h3")!.id)![1]);

describe("blocked users list", () => {
  it("loads GET /blocks and shows avatar, name, @username and Unblock per row in server order", async () => {
    setRoster(member(3, "carol", { displayName: "Carol C" }), member(4, "dave"));
    const s = mount();
    expect(status(s)).toBe("Loading blocked users…");
    expect(s.getAttribute("aria-busy")).toBe("true");
    gets[0]!.resolve({ blocked_user_ids: [4, 3] });
    await flush();
    const rows = rowsOf(s);
    expect(rows.map((r) => r.dataset["userId"])).toEqual(["4", "3"]);
    expect(rows[1]!.querySelector(".session-device")!.textContent).toBe("Carol C");
    expect(rows[1]!.querySelector(".session-detail")!.textContent).toBe("@carol");
    expect(rows[1]!.querySelector(".blocked-user-avatar .avatar-initial")!.textContent).toBe("C");
    expect(unblockBtn(rows[0]!).textContent).toBe("Unblock");
    expect(unblockBtn(rows[0]!).getAttribute("aria-label")).toBe("Unblock dave");
    expect(s.hasAttribute("aria-busy")).toBe(false);
    expect([...blocksStore.getState().blockedByMe]).toEqual([4, 3]);
  });

  it("shows the empty state", async () => {
    const s = mount();
    gets[0]!.resolve({ blocked_user_ids: [] });
    await flush();
    expect(rowsOf(s)).toHaveLength(0);
    expect(status(s)).toBe("You haven't blocked anyone.");
  });

  it("alerts on a load failure and Retry loads again", async () => {
    const s = mount();
    gets[0]!.reject(new Error("offline"));
    await flush();
    expectConsole("warn", "Failed to load blocked users");
    expect(alertText(s)).toBe("Couldn't load your blocked users.");
    expect(retryBtn(s).hidden).toBe(false);
    expect(status(s)).toBe("");
    retryBtn(s).focus();
    retryBtn(s).click();
    expect(gets).toHaveLength(2);
    expect(alertText(s)).toBe("");
    // Retry stays (disabled) while loading, so focus is not dropped to <body>.
    expect(retryBtn(s).hidden).toBe(false);
    expect(retryBtn(s).getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(retryBtn(s));
    gets[1]!.resolve({ blocked_user_ids: [5] });
    await flush();
    expect(retryBtn(s).hidden).toBe(true);
    expect(document.activeElement).toBe(s.querySelector("h3"));
    expect(rowsOf(s)).toHaveLength(1);
    expect(alertText(s)).toBe("");
  });

  it("unblocks: pending label, store write, success toast, row removed", async () => {
    setRoster(member(3, "carol"));
    const s = mount();
    gets[0]!.resolve({ blocked_user_ids: [3] });
    await flush();
    const button = unblockBtn(rowsOf(s)[0]!);
    button.click();
    const pendingBtn = unblockBtn(rowsOf(s)[0]!);
    expect(pendingBtn.textContent).toBe("Unblocking…");
    expect(pendingBtn.getAttribute("aria-disabled")).toBe("true");
    expect(pendingBtn.getAttribute("aria-label")).toBe("Unblocking carol");
    pendingBtn.click();
    expect(deletes).toHaveLength(1);
    deletes[0]!.resolve();
    await flush();
    expect(deletes[0]!.userId).toBe(3);
    expect(blocksStore.getState().blockedByMe.has(3)).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Unblocked carol", "success");
    expect(rowsOf(s)).toHaveLength(0);
    expect(status(s)).toBe("You haven't blocked anyone.");
  });

  it("keeps the row and brings the button back when the unblock fails", async () => {
    setRoster(member(3, "carol"));
    const s = mount();
    gets[0]!.resolve({ blocked_user_ids: [3] });
    await flush();
    unblockBtn(rowsOf(s)[0]!).click();
    deletes[0]!.reject(new ApiClientError(500, "INTERNAL", "boom"));
    await flush();
    expect(rowsOf(s)).toHaveLength(1);
    const button = unblockBtn(rowsOf(s)[0]!);
    expect(button.textContent).toBe("Unblock");
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(blocksStore.getState().blockedByMe.has(3)).toBe(true);
    expect(showToast).toHaveBeenCalledWith(expect.any(String), "error");
    // Retry is possible.
    button.click();
    expect(deletes).toHaveLength(2);
  });

  it("falls back to the failure toast copy for a network drop", async () => {
    setRoster(member(3, "carol"));
    const s = mount();
    gets[0]!.resolve({ blocked_user_ids: [3] });
    await flush();
    unblockBtn(rowsOf(s)[0]!).click();
    deletes[0]!.reject(new TypeError(""));
    await flush();
    expect(showToast).toHaveBeenCalledWith("Failed to unblock user", "error");
    expect(rowsOf(s)).toHaveLength(1);
  });

  it("updates live when a block or unblock happens elsewhere", async () => {
    setRoster(member(3, "carol"), member(4, "dave"));
    const s = mount();
    gets[0]!.resolve({ blocked_user_ids: [3] });
    await flush();
    setUserBlockedByMe(4, true);
    blocksStore.flush();
    expect(rowsOf(s).map((r) => r.dataset["userId"])).toEqual(["3", "4"]);
    setUserBlockedByMe(3, false);
    blocksStore.flush();
    expect(rowsOf(s).map((r) => r.dataset["userId"])).toEqual(["4"]);
    setUserBlockedByMe(4, false);
    blocksStore.flush();
    expect(status(s)).toBe("You haven't blocked anyone.");
  });

  it("names users from the roster, then DM participants, then Unknown user", async () => {
    setRoster(member(3, "carol"));
    setDms(dm(4, "dave", "Dave D"), dm(6, "frank"));
    const s = mount();
    gets[0]!.resolve({ blocked_user_ids: [3, 4, 6, 9] });
    await flush();
    const r = rowsOf(s);
    const name = (i: number): string => r[i]!.querySelector(".session-device")!.textContent;
    const detail = (i: number): string | null =>
      r[i]!.querySelector(".session-detail")?.textContent ?? null;
    expect([name(0), detail(0)]).toEqual(["carol", "@carol"]);
    expect([name(1), detail(1)]).toEqual(["Dave D", "@dave"]);
    expect([name(2), detail(2)]).toEqual(["frank", "@frank"]);
    expect([name(3), detail(3)]).toEqual(["Unknown user", null]);
    expect(r[3]!.querySelector(".avatar-initial")!.textContent).toBe("?");
  });

  it("refetches GET /blocks on each open", async () => {
    const first = mount();
    gets[0]!.resolve({ blocked_user_ids: [3] });
    await flush();
    tab.abort();
    first.remove();
    tab = new AbortController();
    const second = mount();
    expect(gets).toHaveLength(2);
    expect(rowsOf(second)).toHaveLength(1);
    gets[1]!.resolve({ blocked_user_ids: [3, 8] });
    await flush();
    expect(rowsOf(second)).toHaveLength(2);
  });
});

async function mountWith(...ids: number[]): Promise<HTMLElement> {
  setRoster(...ids.map((id) => member(id, `u${id}`)));
  const s = mount();
  gets[0]!.resolve({ blocked_user_ids: ids });
  await flush();
  return s;
}
const finish = async (i: number): Promise<void> => {
  deletes[i]!.resolve();
  await flush();
};

describe("focus after an unblock", () => {
  it("moves focus to the next row's Unblock", async () => {
    const s = await mountWith(1, 2, 3);
    unblockBtn(rowsOf(s)[0]!).focus();
    unblockBtn(rowsOf(s)[0]!).click();
    await finish(0);
    expect(document.activeElement).toBe(unblockBtn(rowsOf(s)[0]!));
    expect(rowsOf(s)[0]!.dataset["userId"]).toBe("2");
  });

  it("moves focus to the previous row when the last one goes", async () => {
    const s = await mountWith(1, 2);
    unblockBtn(rowsOf(s)[1]!).focus();
    unblockBtn(rowsOf(s)[1]!).click();
    await finish(0);
    expect(document.activeElement).toBe(unblockBtn(rowsOf(s)[0]!));
  });

  it("moves focus to the heading when the list empties", async () => {
    const s = await mountWith(1);
    unblockBtn(rowsOf(s)[0]!).focus();
    unblockBtn(rowsOf(s)[0]!).click();
    await finish(0);
    expect(document.activeElement).toBe(s.querySelector("h3"));
  });
});

describe("teardown and races", () => {
  it("shows a reopened view's row as busy until the shared DELETE settles, with one toast", async () => {
    setRoster(member(3, "carol"));
    const first = mount();
    gets[0]!.resolve({ blocked_user_ids: [3] });
    await flush();
    unblockBtn(rowsOf(first)[0]!).click();
    tab.abort();
    first.remove();
    tab = new AbortController();
    const second = mount();
    gets[1]!.resolve({ blocked_user_ids: [3] });
    await flush();
    const busy = unblockBtn(rowsOf(second)[0]!);
    expect(busy.textContent).toBe("Unblocking…");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    busy.click();
    expect(deletes).toHaveLength(1);
    deletes[0]!.resolve();
    await flush();
    expect(rowsOf(second)).toHaveLength(0);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("aborts the GET with the tab and ignores its late reply", async () => {
    const s = mount();
    tab.abort();
    expect(gets[0]!.signal!.aborted).toBe(true);
    gets[0]!.resolve({ blocked_user_ids: [3] });
    await flush();
    expect(rowsOf(s)).toHaveLength(0);
    expect(blocksStore.getState().blockedByMe.size).toBe(0);
  });

  it("ignores a late GET failure after teardown", async () => {
    const s = mount();
    tab.abort();
    gets[0]!.reject(new Error("aborted"));
    await flush();
    expect(alertText(s)).toBe("");
    expect(retryBtn(s).hidden).toBe(true);
  });

  it("stops listening to blocksStore after teardown", async () => {
    setRoster(member(3, "carol"));
    const s = mount();
    gets[0]!.resolve({ blocked_user_ids: [] });
    await flush();
    tab.abort();
    setUserBlockedByMe(3, true);
    blocksStore.flush();
    expect(rowsOf(s)).toHaveLength(0);
  });

  it("builds nothing for a tab already closed", () => {
    tab.abort();
    mount();
    expect(gets).toHaveLength(0);
  });

  it("does not let a stale GET overwrite a newer store state", async () => {
    mount();
    setUserBlockedByMe(5, true);
    // A delta while the GET is in flight bumps the revision it snapshotted.
    setUserBlockedByMe(6, true);
    gets[0]!.resolve({ blocked_user_ids: [] });
    await flush();
    expect([...blocksStore.getState().blockedByMe].toSorted()).toEqual([5, 6]);
  });

  it("lets an unblock finish after the tab closes: store and toast, no view writes", async () => {
    setRoster(member(3, "carol"));
    const s = mount();
    gets[0]!.resolve({ blocked_user_ids: [3] });
    await flush();
    unblockBtn(rowsOf(s)[0]!).click();
    expect(deletes[0]!.signal).toBeUndefined();
    tab.abort();
    deletes[0]!.resolve();
    await flush();
    expect(blocksStore.getState().blockedByMe.has(3)).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Unblocked carol", "success");
    expect(rowsOf(s)).toHaveLength(1);
  });

  it("a failed unblock after the tab closes only toasts", async () => {
    setRoster(member(3, "carol"));
    const s = mount();
    gets[0]!.resolve({ blocked_user_ids: [3] });
    await flush();
    unblockBtn(rowsOf(s)[0]!).click();
    tab.abort();
    deletes[0]!.reject(new Error("x"));
    await flush();
    expect(showToast).toHaveBeenCalledWith("x", "error");
    expect(blocksStore.getState().blockedByMe.has(3)).toBe(true);
    expect(unblockBtn(rowsOf(s)[0]!).textContent).toBe("Unblocking…");
  });
});

// ---------------------------------------------------------------------------
// Markup, who each row is drawn as, focus, live-region text and teardown.
// ---------------------------------------------------------------------------

function mountSpy(createAvatar: CreateAvatar): HTMLElement {
  const section = buildBlockedUsersSection(tab.signal, api, createAvatar);
  document.body.appendChild(section);
  return section;
}

function dmUser(id: number, username: string, over: Partial<DmUser> = {}): DmUser {
  return { id, username, avatar: "", status: "online", displayName: "", ...over };
}

function dmOf(participants: DmUser[], recipient: DmUser): DmChannel {
  return { ...dm(recipient.id, recipient.username), participants, recipient };
}

describe("blocked users markup", () => {
  it("builds the section, heading, description, live regions, Retry and list", async () => {
    const s = mount();
    expect(s.tagName).toBe("SECTION");
    expect(s.className).toBe("blocked-users");
    expect(s.dataset["testid"]).toBe("blocked-users");
    const heading = s.querySelector("h3")!;
    expect(heading.className).toBe("safety-heading");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(heading.textContent).toBe("Blocked users");
    expect(heading.id).toMatch(/^blocked-users-\d+$/);
    expect(s.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(s.querySelector("p")!.className).toBe("setting-desc");
    const region = s.querySelector("[role=status]")!;
    expect(region.className).toBe("my-reports-status");
    const alert = s.querySelector("[role=alert]")!;
    expect(alert.className).toBe("form-error");
    expect(retryBtn(s).type).toBe("button");
    expect(retryBtn(s).className).toBe("ac-btn secondary");
    expect(retryBtn(s).hidden).toBe(true);
    expect(s.querySelector("ul")!.className).toBe("blocked-users-list");
    gets[0]!.resolve({ blocked_user_ids: [] });
    await flush();
  });

  it("gives each section its own title id, counting up", () => {
    const first = mount();
    const second = mount();
    expect(idOf(second)).toBe(idOf(first) + 1);
  });

  it("builds a row with its classes, ids, avatar class and a typed Unblock button", async () => {
    const s = await mountWith(7);
    const li = rowsOf(s)[0]!;
    expect(li.tagName).toBe("LI");
    expect(li.className).toBe("session-row blocked-user-row");
    expect(li.dataset["userId"]).toBe("7");
    expect(li.querySelector(".blocked-user-info")!.className).toBe(
      "session-info blocked-user-info",
    );
    expect(li.querySelector(".blocked-user-avatar")).not.toBeNull();
    const button = unblockBtn(li);
    expect(button.type).toBe("button");
    expect(button.className).toBe("ac-btn secondary");
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("who a blocked user is drawn as", () => {
  it("draws a roster member with their own name, username and avatar", async () => {
    setRoster(member(3, "carol", { displayName: "Carol C", avatar: "a/carol.png" }));
    const createAvatar = vi.fn<CreateAvatar>(createAvatarElement);
    mountSpy(createAvatar);
    gets[0]!.resolve({ blocked_user_ids: [3] });
    await flush();
    expect(createAvatar).toHaveBeenCalledWith(
      { username: "carol", displayName: "Carol C", avatar: "a/carol.png", isDeleted: false },
      { className: "blocked-user-avatar" },
    );
  });

  it("draws an unknown id as a deleted user with a '?' avatar", async () => {
    const createAvatar = vi.fn<CreateAvatar>(createAvatarElement);
    mountSpy(createAvatar);
    gets[0]!.resolve({ blocked_user_ids: [9] });
    await flush();
    expect(createAvatar).toHaveBeenCalledWith(
      { username: "?", displayName: "Unknown user", avatar: null, isDeleted: true },
      { className: "blocked-user-avatar" },
    );
  });

  it("names a DM participant by display name, or by username when the display name is blank or absent", async () => {
    setDms(
      dmOf([dmUser(4, "dave", { displayName: "  Dave D  " })], dmUser(40, "x")),
      dmOf([dmUser(5, "erin", { displayName: "   " })], dmUser(50, "y")),
      dmOf([dmUser(6, "frank", { displayName: undefined })], dmUser(60, "z")),
    );
    const s = mountSpy(vi.fn<CreateAvatar>(createAvatarElement));
    gets[0]!.resolve({ blocked_user_ids: [4, 5, 6] });
    await flush();
    const names = rowsOf(s).map((r) => r.querySelector(".session-device")!.textContent);
    expect(names).toEqual(["  Dave D  ", "erin", "frank"]);
  });

  it("passes a DM participant's avatar through, and no avatar when it is empty", async () => {
    setDms(
      dmOf([dmUser(4, "dave", { avatar: "a/dave.png" })], dmUser(40, "x")),
      dmOf([dmUser(5, "erin", { avatar: "" })], dmUser(50, "y")),
    );
    const createAvatar = vi.fn<CreateAvatar>(createAvatarElement);
    mountSpy(createAvatar);
    gets[0]!.resolve({ blocked_user_ids: [4, 5] });
    await flush();
    const avatars = createAvatar.mock.calls.map(([subject]) => [subject.username, subject.avatar]);
    expect(avatars).toEqual([
      ["dave", "a/dave.png"],
      ["erin", null],
    ]);
  });

  it("skips a DM participant entry that has no username and uses the next entry for the same id", async () => {
    setDms(
      dmOf([dmUser(4, "", { displayName: "Ghost" })], dmUser(4, "dave", { displayName: "Dave D" })),
    );
    const s = mountSpy(vi.fn<CreateAvatar>(createAvatarElement));
    gets[0]!.resolve({ blocked_user_ids: [4] });
    await flush();
    const r = rowsOf(s)[0]!;
    expect(r.querySelector(".session-device")!.textContent).toBe("Dave D");
    expect(r.querySelector(".session-detail")!.textContent).toBe("@dave");
  });
});

describe("blocked users status text", () => {
  it("keeps the loading line off while known blocks are already listed", () => {
    setUserBlockedByMe(3, true);
    blocksStore.flush();
    setRoster(member(3, "carol"));
    const s = mount();
    expect(rowsOf(s)).toHaveLength(1);
    expect(status(s)).toBe("");
  });

  it("keeps the empty line off once blocks are listed", async () => {
    const s = await mountWith(1, 2);
    expect(status(s)).toBe("");
  });

  it("shows the loading line again while Retry is in flight with nothing listed", async () => {
    const s = mount();
    gets[0]!.reject(new Error("offline"));
    await flush();
    expectConsole("warn", "Failed to load blocked users");
    expect(status(s)).toBe("");
    retryBtn(s).click();
    expect(status(s)).toBe("Loading blocked users…");
  });
});

describe("blocked users load failure", () => {
  it("logs the error under BlockedUsers, clears busy and re-enables Retry", async () => {
    const logs = captureLogs();
    const s = mount();
    gets[0]!.reject(new Error("offline"));
    await flush();
    expectConsole("warn", "Failed to load blocked users");
    expect(logs.find("Failed to load blocked users")).toMatchObject([
      { level: "warn", component: "BlockedUsers", data: { error: "Error: offline" } },
    ]);
    expect(s.hasAttribute("aria-busy")).toBe(false);
    expect(retryBtn(s).hasAttribute("aria-disabled")).toBe(false);
    expect(retryBtn(s).hidden).toBe(false);
  });

  it("ignores Retry presses while a load is in flight", async () => {
    const s = mount();
    gets[0]!.reject(new Error("offline"));
    await flush();
    expectConsole("warn", "Failed to load blocked users");
    retryBtn(s).click();
    retryBtn(s).click();
    expect(gets).toHaveLength(2);
  });

  it("ignores Retry once the tab was closed", async () => {
    const s = mount();
    gets[0]!.reject(new Error("offline"));
    await flush();
    expectConsole("warn", "Failed to load blocked users");
    tab.abort();
    retryBtn(s).click();
    expect(gets).toHaveLength(1);
  });
});

describe("blocked users revision guard", () => {
  it("applies a reply when the store's revision has moved on from zero but not since the request", async () => {
    setUserBlockedByMe(8, true);
    setUserBlockedByMe(8, false);
    expect(blocksStore.getState().blockedByMeRev).toBe(2);
    mount();
    gets[0]!.resolve({ blocked_user_ids: [5] });
    await flush();
    expect([...blocksStore.getState().blockedByMe]).toEqual([5]);
  });
});

describe("blocked users focus", () => {
  it("leaves focus alone while rows are first drawn and when the first load ends", async () => {
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    setRoster(member(1, "u1"), member(2, "u2"));
    const s = mount();
    gets[0]!.resolve({ blocked_user_ids: [1, 2] });
    await flush();
    expect(rowsOf(s)).toHaveLength(2);
    expect(document.activeElement).toBe(outside);
  });

  it("keeps focus on a row's button when that row is redrawn as busy", async () => {
    const s = await mountWith(1, 2);
    const button = unblockBtn(rowsOf(s)[1]!);
    button.focus();
    button.click();
    const busy = unblockBtn(rowsOf(s)[1]!);
    expect(busy).not.toBe(button);
    expect(busy.textContent).toBe("Unblocking…");
    expect(document.activeElement).toBe(busy);
  });

  it("does not move focus when a row is redrawn while focus is elsewhere", async () => {
    const s = await mountWith(1, 2);
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    unblockBtn(rowsOf(s)[0]!).click();
    expect(unblockBtn(rowsOf(s)[0]!).textContent).toBe("Unblocking…");
    expect(document.activeElement).toBe(outside);
  });

  it("moves focus to the row that takes the place of a removed middle row", async () => {
    const s = await mountWith(1, 2, 3);
    unblockBtn(rowsOf(s)[1]!).focus();
    unblockBtn(rowsOf(s)[1]!).click();
    await finish(0);
    expect(rowsOf(s).map((r) => r.dataset["userId"])).toEqual(["1", "3"]);
    expect(document.activeElement).toBe(unblockBtn(rowsOf(s)[1]!));
  });

  it("leaves focus alone when the unblocked row did not hold it", async () => {
    const s = await mountWith(1, 2);
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    unblockBtn(rowsOf(s)[0]!).click();
    await finish(0);
    expect(rowsOf(s)).toHaveLength(1);
    expect(document.activeElement).toBe(outside);
  });

  it("leaves focus on another row's button when a different row is unblocked", async () => {
    const s = await mountWith(1, 2);
    const other = unblockBtn(rowsOf(s)[1]!);
    other.focus();
    unblockBtn(rowsOf(s)[0]!).click();
    await finish(0);
    expect(rowsOf(s).map((r) => r.dataset["userId"])).toEqual(["2"]);
    expect(document.activeElement).toBe(other);
  });
});

describe("blocked users row lifecycle", () => {
  it("keeps an unchanged row's element when another block arrives", async () => {
    const s = await mountWith(1, 2);
    const before = rowsOf(s)[0]!;
    setRoster(member(1, "u1"), member(2, "u2"), member(3, "u3"));
    setUserBlockedByMe(3, true);
    blocksStore.flush();
    expect(rowsOf(s)).toHaveLength(3);
    expect(rowsOf(s)[0]).toBe(before);
  });

  it("builds a fresh row when a user is blocked again after an unblock elsewhere", async () => {
    const s = await mountWith(1);
    const before = rowsOf(s)[0]!;
    setUserBlockedByMe(1, false);
    blocksStore.flush();
    expect(rowsOf(s)).toHaveLength(0);
    setUserBlockedByMe(1, true);
    blocksStore.flush();
    const after = rowsOf(s)[0]!;
    expect(after).not.toBe(before);
    expect(after.isConnected).toBe(true);
  });

  it("shows a user blocked again after an unblock as ready, not busy", async () => {
    const s = await mountWith(1);
    unblockBtn(rowsOf(s)[0]!).click();
    await finish(0);
    setUserBlockedByMe(1, true);
    blocksStore.flush();
    const again = unblockBtn(rowsOf(s)[0]!);
    expect(again.textContent).toBe("Unblock");
    expect(again.hasAttribute("aria-disabled")).toBe(false);
  });

  it("has removed the row and told the user by the time the success toast shows", async () => {
    const s = await mountWith(1, 2);
    const rowsAtToast: number[] = [];
    vi.mocked(showToast).mockImplementation(() => {
      rowsAtToast.push(rowsOf(s).length);
    });
    unblockBtn(rowsOf(s)[0]!).click();
    deletes[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(rowsAtToast).toEqual([1]);
    vi.mocked(showToast).mockReset();
  });

  it("answers no Unblock press once the tab was closed", async () => {
    const s = await mountWith(1);
    const button = unblockBtn(rowsOf(s)[0]!);
    tab.abort();
    button.click();
    expect(deletes).toHaveLength(0);
  });
});

describe("blocked users teardown", () => {
  it("drops its store subscription when the tab closes", async () => {
    const stop = vi.fn();
    const subscribe = vi.spyOn(blocksStore, "subscribeSelector").mockReturnValue(stop);
    try {
      mount();
      expect(stop).not.toHaveBeenCalled();
      tab.abort();
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      subscribe.mockRestore();
    }
  });
});
