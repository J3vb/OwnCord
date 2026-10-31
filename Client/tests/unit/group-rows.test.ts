/**
 * WP 3B-11a: group DM system rows. The five group kinds draw from `kind` +
 * `groupEvent` alone (never `content`), name people from live stores, and
 * behave like call rows: no grouping, no hover bar, Copy ID only, no folding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";

import { createMessageList } from "@components/MessageList";
import { renderMessage } from "@components/message-list/renderers";
import { messageActionGates } from "@components/message-list/messageActions";
import { groupRowText } from "@components/message-list/groupRows";
import { shouldGroup } from "@lib/text/formatting";
import { isServerRowKind } from "@lib/text/messageKind";
import { dmStore } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";
import {
  ME,
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  setDeveloperMode,
  signInAs,
} from "../helpers/message-actions-fixtures";
import { resetMembersState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";
import {
  expectNoRowMenu,
  messageMenuNames,
  openRowMenu,
  seedChannelOneRows,
  shownActions,
} from "../helpers/readOnlyRowMenu";

const CAROL = 12;

function groupRow(kind: string, groupEvent?: Message["groupEvent"], over: Partial<Message> = {}) {
  return makeMessage({
    id: 7,
    kind,
    content: "English fallback that must never be shown",
    ...(groupEvent === undefined ? {} : { groupEvent }),
    ...over,
  });
}

function render(msg: Message): HTMLElement {
  const ac = new AbortController();
  return renderMessage(msg, false, [msg], makeOpts(), ac.signal);
}
const textOf = (el: HTMLElement): string => el.textContent?.replace(/\s+/g, " ").trim() ?? "";

function seedDm(): void {
  dmStore.setState(() => ({
    channels: [
      {
        channelId: 1,
        recipient: { id: OTHER, username: "alice", avatar: "", status: "online" },
        participants: [
          { id: OTHER, username: "alice", avatar: "", status: "online" },
          { id: CAROL, username: "carol", avatar: "", status: "online", displayName: "Caz" },
        ],
        name: "",
        isGroup: true,
        ownerId: ME,
        lastMessageId: null,
        lastMessage: "",
        lastMessageAt: "",
        unreadCount: 0,
        mentionCount: 0,
      },
    ],
  }));
}

describe("isServerRowKind", () => {
  it("is false for an unset or empty kind and true for any other", () => {
    expect(isServerRowKind(undefined)).toBe(false);
    expect(isServerRowKind("")).toBe(false);
    expect(isServerRowKind("call")).toBe(true);
    expect(isServerRowKind("group_add")).toBe(true);
    expect(isServerRowKind("future_kind")).toBe(true);
  });
});

describe("group row wording", () => {
  beforeEach(() => {
    resetGateStores();
    signInAs("member");
    setChannel({ type: "dm" });
    seedDm();
    resetMembersState();
  });
  afterEach(() => {
    resetGateStores();
    dmStore.setState(() => ({ channels: [] }));
  });

  it("group_add: author added target, names from the DM's recipients", () => {
    const el = render(groupRow("group_add", { target_user_id: CAROL }));
    expect(el.classList.contains("group-row")).toBe(true);
    expect(textOf(el)).toContain("alice added Caz to the group");
    expect(textOf(el)).not.toContain("English fallback");
  });

  it("group_remove and group_leave", () => {
    expect(textOf(render(groupRow("group_remove", { target_user_id: CAROL })))).toContain(
      "alice removed Caz from the group",
    );
    expect(textOf(render(groupRow("group_leave", {})))).toContain("alice left the group");
  });

  it("uses You for the viewer, as author or as target", () => {
    const asTarget = render(groupRow("group_add", { target_user_id: ME }));
    expect(textOf(asTarget)).toContain("alice added You to the group");
    const asAuthor = render(
      groupRow(
        "group_remove",
        { target_user_id: CAROL },
        {
          user: { id: ME, username: "me", avatar: null },
        },
      ),
    );
    expect(textOf(asAuthor)).toContain("You removed Caz from the group");
  });

  it("falls back to the server member list, then to Unknown user", () => {
    membersStore.setState(() => ({
      members: new Map([
        [99, { id: 99, username: "dave", avatar: null, role: "member", status: "online" as const }],
      ]),
      typingUsers: new Map(),
    }));
    expect(textOf(render(groupRow("group_add", { target_user_id: 99 })))).toContain(
      "alice added dave to the group",
    );
    expect(textOf(render(groupRow("group_add", { target_user_id: 12345 })))).toContain(
      "alice added Unknown user to the group",
    );
    expect(textOf(render(groupRow("group_add")))).toContain(
      "alice added Unknown user to the group",
    );
  });

  it("group_rename shows the name, or says it was removed when empty", () => {
    expect(textOf(render(groupRow("group_rename", { name: "Weekend plans" })))).toContain(
      "alice changed the group name: Weekend plans",
    );
    expect(textOf(render(groupRow("group_rename", { name: "" })))).toContain(
      "alice removed the group name",
    );
    expect(textOf(render(groupRow("group_rename")))).toContain("alice removed the group name");
  });

  it("group_icon says changed or removed", () => {
    expect(textOf(render(groupRow("group_icon", { icon_removed: false })))).toContain(
      "alice changed the group icon",
    );
    expect(textOf(render(groupRow("group_icon", { icon_removed: true })))).toContain(
      "alice removed the group icon",
    );
  });

  it("shows the group name as plain text: no markdown, no mention parsing", () => {
    const name = "**bold** @everyone <b>x</b> `code`";
    const el = render(groupRow("group_rename", { name }));
    expect(textOf(el)).toContain(`alice changed the group name: ${name}`);
    expect(el.querySelector("strong, b, code, .mention, a")).toBeNull();
  });

  it("an unknown future kind still renders content as system text", () => {
    const el = render(groupRow("group_future", { name: "x" }, { content: "Something happened" }));
    expect(el.classList.contains("system-msg")).toBe(true);
    expect(textOf(el)).toContain("Something happened");
    expect(groupRowText(groupRow("group_future"), ME)).toBeNull();
  });

  it("an empty kind is an ordinary message", () => {
    const el = render(makeMessage({ kind: "", content: "plain words" }));
    expect(el.classList.contains("group-row")).toBe(false);
    expect(el.classList.contains("system-msg")).toBe(false);
    expect(textOf(el)).toContain("plain words");
  });
});

describe("group row gates", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList>;

  useMountContainer(
    (c) => {
      container = c;
    },
    () => {
      list?.destroy?.();
      document.querySelectorAll(".context-menu").forEach((el) => el.remove());
      setDeveloperMode(false);
      resetGateStores();
      dmStore.setState(() => ({ channels: [] }));
    },
  );

  beforeEach(() => {
    resetGateStores();
    localStorage.clear();
    signInAs("moderator");
    setChannel({ type: "dm" });
    seedDm();
  });

  function mount(rows: readonly Message[]): void {
    seedChannelOneRows(rows);
    list = createMessageList(makeOpts({ channelType: "dm" }));
    list.mount(container);
  }
  const rowEl = (id: number): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid="message-${id}"]`)!;
  const menuNames = messageMenuNames;

  it("action gates: only Copy ID can show, and only in developer mode", () => {
    const msg = groupRow("group_leave", {}, { user: { id: ME, username: "me", avatar: null } });
    expect(messageActionGates(msg, makeOpts()).copyId.shown).toBe(false);
    setDeveloperMode(true);
    const g = messageActionGates(msg, makeOpts({ onReportClick: vi.fn() }));
    expect(shownActions(g)).toEqual([false, false, false, false, false]);
    expect(g.copyId.shown).toBe(true);
  });

  it("an unknown future kind is read-only too", () => {
    const g = messageActionGates(groupRow("group_future"), makeOpts());
    expect(shownActions(g)).toEqual([false, false, false, false, false]);
  });

  it("no hover bar, and the right-click menu offers only Copy Message ID", async () => {
    setDeveloperMode(true);
    mount([groupRow("group_add", { target_user_id: CAROL })]);
    expect(rowEl(7).querySelector(".msg-actions-bar")).toBeNull();
    openRowMenu(rowEl(7));
    await vi.waitFor(() => expect(menuNames()).toEqual(["Copy Message ID"]));
  });

  it("without developer mode there is no menu at all", async () => {
    mount([groupRow("group_add", { target_user_id: CAROL })]);
    await expectNoRowMenu(rowEl(7));
  });

  it("is never grouped with a neighbour from the same author", () => {
    const row = groupRow("group_add", { target_user_id: CAROL });
    const next = makeMessage({ id: 8, timestamp: "2024-01-15T12:00:05Z" });
    const prev = makeMessage({ id: 6, timestamp: "2024-01-15T11:59:55Z" });
    expect(shouldGroup(prev, row)).toBe(false);
    expect(shouldGroup(row, next)).toBe(false);
    expect(shouldGroup(prev, next)).toBe(true);
    const future = groupRow("group_future");
    expect(shouldGroup(prev, future)).toBe(false);
    // An empty kind is an ordinary message and groups as one.
    expect(shouldGroup(prev, makeMessage({ id: 8, kind: "", timestamp: next.timestamp }))).toBe(
      true,
    );
  });
});
