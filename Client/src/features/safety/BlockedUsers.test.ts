// 3B-7: the Privacy & Safety tab's blocked-users list — load, empty, error and
// Retry, unblock success and failure, live updates from blocksStore, name
// fallback and the teardown/refetch edge cases.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));

import { expectConsole } from "../../../tests/helpers/console";
import { ApiClientError } from "@lib/api";
import { showToast } from "../../lib/toast";
import { blocksStore, setUserBlockedByMe } from "@stores/blocks.store";
import { dmStore, type DmChannel } from "@stores/dm.store";
import { membersStore, type Member } from "@stores/members.store";
import { createAvatarElement } from "@components/message-list/avatar";
import {
  buildBlockedUsersSection,
  resetPendingUnblocks,
  type BlockedUsersApi,
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
