import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { messageActionGates } from "../../src/features/messaging/message-list/messageActions";
import {
  openMessageMenu,
  closeMessageMenu,
} from "../../src/features/messaging/message-list/messageMenu";
import {
  applyReadyCapabilities,
  resetServerCapabilities,
} from "../../src/lib/net/serverCapabilities";
import { resetThreadsStore } from "../../src/stores/threads.store";
import {
  ME,
  makeMessage,
  makeOpts,
  resetGateStores,
  seedMessages,
  setChannel,
  setDeveloperMode,
  signInAs,
} from "../helpers/message-actions-fixtures";

type Msg = ReturnType<typeof makeMessage>;

const mine = (over: Partial<Msg> = {}): Msg =>
  makeMessage({ user: { id: ME, username: "me", avatar: null }, ...over });
const theirs = (over: Partial<Msg> = {}): Msg => makeMessage(over);

const GATE_KEYS = [
  "react",
  "edit",
  "forward",
  "createThread",
  "pin",
  "delete",
  "report",
  "copyId",
] as const;

function callbacks(over = {}) {
  return makeOpts({
    onForwardClick: vi.fn(),
    onReportClick: vi.fn(),
    onCreateThreadClick: vi.fn(),
    channelType: "text",
    ...over,
  });
}

function shownGates(msg: Msg, over = {}): string[] {
  const g = messageActionGates(msg, callbacks(over));
  return GATE_KEYS.filter((k) => g[k].shown);
}

beforeEach(() => {
  resetGateStores();
  signInAs("moderator");
  setChannel();
  applyReadyCapabilities({ threads: true });
});
afterEach(() => {
  closeMessageMenu();
  document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  setDeveloperMode(false);
  resetServerCapabilities();
  resetThreadsStore();
  resetGateStores();
});

describe("action gates across message kinds", () => {
  it("another member's ordinary message as a moderator", () => {
    expect(shownGates(theirs())).toEqual([
      "react",
      "forward",
      "createThread",
      "pin",
      "delete",
      "report",
    ]);
  });

  it("my own ordinary message as a moderator", () => {
    expect(shownGates(mine())).toEqual([
      "react",
      "edit",
      "forward",
      "createThread",
      "pin",
      "delete",
    ]);
  });

  it("a call row offers only Copy ID, and only in developer mode", () => {
    expect(shownGates(theirs({ kind: "call" }))).toEqual([]);
    setDeveloperMode(true);
    expect(shownGates(theirs({ kind: "call" }))).toEqual(["copyId"]);
  });

  it.each(["pin_add", "member_join"])("a %s row offers Delete under the ordinary rule", (kind) => {
    expect(shownGates(theirs({ kind }))).toEqual(["delete"]);
    signInAs("member");
    expect(shownGates(theirs({ kind }))).toEqual([]);
    expect(shownGates(mine({ kind }))).toEqual(["delete"]);
  });

  it("a sticker message cannot be edited or forwarded", () => {
    const sticker = { id: 3, name: "wave", url: "/s/3.png" };
    expect(shownGates(mine({ sticker }))).toEqual(["react", "createThread", "pin", "delete"]);
  });

  it("an imported message cannot be reported", () => {
    const importedAuthor = { name: "bob", avatar_url: null } as unknown as Msg["importedAuthor"];
    expect(shownGates(theirs({ importedAuthor }))).not.toContain("report");
  });

  it("a plain member in a channel: no pin, no delete of others", () => {
    signInAs("member");
    expect(shownGates(theirs())).toEqual(["react", "forward", "createThread", "report"]);
  });

  it("a voice list offers no Create Thread", () => {
    expect(shownGates(theirs(), { channelType: "voice" })).not.toContain("createThread");
  });
});

describe("menu items", () => {
  function openFor(msg: Msg, over = {}, extra = {}): string[] {
    seedMessages([msg]);
    openMessageMenu({
      msg,
      opts: callbacks(over),
      x: 5,
      y: 5,
      target: null,
      signal: new AbortController().signal,
      ...extra,
    });
    return [...document.querySelectorAll<HTMLElement>('.context-menu [role="menuitem"]')]
      .map((el) => el.dataset["testid"] ?? "")
      .filter((id) => !id.startsWith("msg-menu-quick-"));
  }

  function reset(): void {
    closeMessageMenu();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  }

  it("another member's message as a moderator: full ordered list", () => {
    expect(openFor(theirs())).toEqual([
      "msg-menu-add-reaction",
      "msg-menu-reply",
      "msg-menu-forward",
      "msg-menu-create-thread",
      "msg-menu-copy-text",
      "msg-menu-pin",
      "msg-menu-copy-message-link",
      "msg-menu-delete",
      "msg-menu-report",
    ]);
  });

  it("my own message in a DM: no thread, no report", () => {
    expect(openFor(mine(), { channelType: "dm" })).toEqual([
      "msg-menu-add-reaction",
      "msg-menu-edit",
      "msg-menu-reply",
      "msg-menu-forward",
      "msg-menu-copy-text",
      "msg-menu-pin",
      "msg-menu-copy-message-link",
      "msg-menu-delete",
    ]);
  });

  it("Mark Unread sits between Pin and Copy Link when the server has a read pointer", () => {
    applyReadyCapabilities({ threads: true, read_pointer: true });
    const ids = openFor(theirs(), {}, { markUnread: vi.fn() });
    const at = ids.indexOf("msg-menu-mark-unread");
    expect(at).toBeGreaterThan(-1);
    expect(ids[at - 1]).toBe("msg-menu-pin");
    expect(ids[at + 1]).toBe("msg-menu-copy-message-link");
  });

  it("no Mark Unread without the callback", () => {
    applyReadyCapabilities({ threads: true, read_pointer: true });
    expect(openFor(theirs())).not.toContain("msg-menu-mark-unread");
  });

  it("a call row in developer mode: Copy ID alone", () => {
    setDeveloperMode(true);
    expect(openFor(theirs({ kind: "call" }))).toEqual(["msg-menu-copy-id"]);
  });

  it("a pin row: Delete alone; in developer mode Copy ID then Delete", () => {
    expect(openFor(theirs({ kind: "pin_add" }))).toEqual(["msg-menu-delete"]);
    reset();
    setDeveloperMode(true);
    expect(openFor(theirs({ kind: "pin_add" }))).toEqual(["msg-menu-copy-id", "msg-menu-delete"]);
  });

  it("a call row outside developer mode opens no menu", () => {
    expect(openFor(theirs({ kind: "call" }))).toEqual([]);
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("a pinned message reads Unpin; attachment-only has no Copy Text", () => {
    const ids = openFor(theirs({ pinned: true, content: "" }));
    expect(ids).not.toContain("msg-menu-copy-text");
    expect(document.querySelector('[data-testid="msg-menu-pin"]')?.textContent).toContain("Unpin");
  });

  it("a developer-mode ordinary message ends with a separator then Copy ID", () => {
    setDeveloperMode(true);
    const ids = openFor(theirs());
    expect(ids.at(-1)).toBe("msg-menu-copy-id");
    expect(ids.at(-2)).toBe("msg-menu-report");
  });

  it("separators fall before Reply, before the danger rows and before Copy ID", () => {
    setDeveloperMode(true);
    openFor(theirs());
    const seq = [...document.querySelectorAll<HTMLElement>(".context-menu [role]")]
      .filter((el) => el.getAttribute("role") !== "group" && el.getAttribute("role") !== "menu")
      .map((el) => (el.getAttribute("role") === "separator" ? "---" : (el.dataset["testid"] ?? "")))
      .filter((id) => !id.startsWith("msg-menu-quick-"));
    expect(seq).toEqual([
      "msg-menu-add-reaction",
      "---",
      "msg-menu-reply",
      "msg-menu-forward",
      "msg-menu-create-thread",
      "msg-menu-copy-text",
      "msg-menu-pin",
      "msg-menu-copy-message-link",
      "---",
      "msg-menu-delete",
      "msg-menu-report",
      "---",
      "msg-menu-copy-id",
    ]);
  });
});
