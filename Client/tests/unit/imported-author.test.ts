/**
 * Messages imported from a Discord export share one hidden account. The row
 * shows the export's name instead, as plain text, with an "Imported" tag and a
 * letter avatar, and nothing on it opens a profile.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { renderMessage } from "@components/message-list/renderers";
import { messageActionGates } from "@components/message-list/messageActions";
import { shouldGroup } from "@lib/text/formatting";
import { messageResponseToMessage } from "../../src/features/messaging/messageModel";
import {
  IMPORTED_NAME_MAX,
  importedColor,
  importedName,
} from "../../src/features/messaging/importedAuthor";
import { mapToPinnedMessage } from "../../src/pages/main-page/OverlayManagers";
import type { MessageResponse } from "@lib/types";
import type { Message } from "@stores/messages.store";
import {
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
} from "../helpers/message-actions-fixtures";
import "../helpers/resizeObserverStub";

const HIDDEN = { id: 77, username: "[imported]", avatar: null };

function imported(name: string, over: Partial<Message> = {}, color?: string): Message {
  return makeMessage({
    user: HIDDEN,
    importedAuthor: color === undefined ? { name } : { name, color },
    ...over,
  });
}

function render(msg: Message, all: readonly Message[] = [msg], grouped = false): HTMLElement {
  return renderMessage(msg, grouped, all, makeOpts(), new AbortController().signal);
}

beforeEach(() => {
  resetGateStores();
  setChannel();
});

describe("imported author row", () => {
  it("shows the Discord name, the tag and a letter avatar", () => {
    const el = render(imported("Ann", { id: 5 }, "#ff8800"));
    const name = el.querySelector<HTMLElement>(".msg-author");
    expect(name?.textContent).toBe("Ann");
    expect(name?.textContent).not.toContain("[imported]");
    const tag = el.querySelector<HTMLElement>(".imported-tag");
    expect(tag?.textContent).toBe("Imported");
    expect(tag?.title).toBe("Imported from Discord");
    expect(el.querySelector(".msg-avatar .avatar-initial")?.textContent).toBe("A");
    expect(el.querySelector("img")).toBeNull();
  });

  it("opens no profile: no user id, no button role on the name or avatar", () => {
    const el = render(imported("Ann"));
    expect(el.querySelector(".msg-author[data-user-id], .msg-avatar[data-user-id]")).toBeNull();
    const name = el.querySelector<HTMLElement>(".msg-author");
    expect(name?.getAttribute("role")).toBeNull();
    expect(name?.getAttribute("tabindex")).toBeNull();
  });

  it("leaves a native message as it was: profile controls and no tag", () => {
    const el = render(makeMessage());
    expect(el.querySelector(".msg-author[data-user-id]")).not.toBeNull();
    expect(el.querySelector(".msg-avatar[data-user-id]")).not.toBeNull();
    expect(el.querySelector(".imported-tag")).toBeNull();
  });

  it("uses a valid #rrggbb colour and falls back otherwise", () => {
    const ok = render(imported("Ann", {}, "#336699")).querySelector<HTMLElement>(".msg-author");
    expect(ok?.dataset["roleColor"]).toBe("#336699");
    for (const bad of ["red; background:url(http://x/y)", "#fff", "rgb(1,2,3)", "#12345g", ""]) {
      const el = render(imported("Ann", {}, bad)).querySelector<HTMLElement>(".msg-author");
      expect(el?.dataset["roleColor"], bad).toBeUndefined();
      expect(el?.getAttribute("style") ?? "", bad).not.toContain("url");
      expect(el?.style.color, bad).toBe("");
    }
    expect(importedColor({ name: "x", color: "#AbCdEf" })).toBe("#AbCdEf");
    expect(importedColor({ name: "x", color: "red; x" })).toBeUndefined();
    expect(importedColor({ name: "x" })).toBeUndefined();
  });

  it("renders a markup name as plain text", () => {
    const name = "<img src=x onerror=alert(1)>";
    const el = render(imported(name));
    expect(el.querySelector(".msg-author img")).toBeNull();
    expect(el.querySelector("img[src='x']")).toBeNull();
    expect(el.querySelector(".msg-author")?.textContent).toBe(name);
  });

  it("cuts a 200 character name with an ellipsis", () => {
    const long = "n".repeat(200);
    const shown = render(imported(long)).querySelector(".msg-author")?.textContent ?? "";
    expect(Array.from(shown)).toHaveLength(IMPORTED_NAME_MAX);
    expect(shown.endsWith("…")).toBe(true);
    expect(importedName({ name: "short" })).toBe("short");
    expect(importedName({ name: "a‮b\u0000c" })).toBe("abc");
  });

  it("offers no report of the author, while pin and delete follow the message", () => {
    const opts = makeOpts({ onReportClick: vi.fn() });
    const gates = messageActionGates(imported("Ann"), opts);
    const native = messageActionGates(makeMessage(), opts);
    expect(gates.report.shown).toBe(false);
    expect(native.report.shown).toBe(true);
    expect(gates.pin).toEqual(native.pin);
    expect(gates.delete).toEqual(native.delete);
  });
});

const at = (s: number): string => new Date(Date.UTC(2024, 0, 15, 12, 0, s)).toISOString();

describe("imported author grouping", () => {
  it("groups consecutive messages of one Discord author only", () => {
    const a1 = imported("Ann", { id: 1, timestamp: at(0) });
    const a2 = imported("Ann", { id: 2, timestamp: at(5) });
    const b1 = imported("Bob", { id: 3, timestamp: at(10) });
    expect(shouldGroup(a1, a2)).toBe(true);
    expect(shouldGroup(a2, b1)).toBe(false);
  });

  it("never groups an imported message with a native one, even on the same user id", () => {
    const imp = imported("Ann", { id: 1, timestamp: at(0) });
    const native = makeMessage({ id: 2, user: HIDDEN, timestamp: at(5) });
    expect(shouldGroup(imp, native)).toBe(false);
    expect(shouldGroup(native, imp)).toBe(false);
  });

  it("draws two separate groups, each with its own name", () => {
    const a = imported("Ann", { id: 1, timestamp: at(0) });
    const b = imported("Bob", { id: 2, timestamp: at(5) });
    const rows = [a, b].map((m, i) => render(m, [a, b], i > 0 && shouldGroup(a, m)));
    expect(rows[1]?.classList.contains("grouped")).toBe(false);
    expect(rows.map((r) => r.querySelector(".msg-author")?.textContent)).toEqual(["Ann", "Bob"]);
  });
});

describe("reply to an imported message", () => {
  it("shows the Discord name when the parent is loaded", () => {
    const parent = imported("Ann", { id: 4, content: "original" });
    const reply = makeMessage({ id: 5, replyTo: 4 });
    const bar = render(reply, [parent, reply]).querySelector(".msg-reply-ref");
    expect(bar?.querySelector(".rr-author")?.textContent).toBe("Ann");
    expect(bar?.querySelector(".imported-tag")?.textContent).toBe("Imported");
    expect(bar?.querySelector(".rr-avatar .avatar-initial")?.textContent).toBe("A");
    expect(bar?.querySelector(".rr-text")?.textContent).toBe("original");
  });

  it("shows the Discord name from the server snippet when the parent is not loaded", () => {
    const reply = makeMessage({
      id: 5,
      replyTo: 4,
      referencedMessage: {
        id: 4,
        user: HIDDEN,
        content: "snippet",
        deleted: false,
        has_attachments: false,
        imported_author: { name: "<b>Ann</b>", color: "bogus" },
      },
    });
    const bar = render(reply).querySelector(".msg-reply-ref");
    expect(bar?.querySelector(".rr-author")?.textContent).toBe("<b>Ann</b>");
    expect(bar?.querySelector(".rr-author b")).toBeNull();
    expect(bar?.querySelector(".imported-tag")).not.toBeNull();
    expect(bar?.querySelector(".rr-text")?.textContent).toBe("snippet");
  });
});

describe("wire to store", () => {
  const response: MessageResponse = {
    id: 9,
    channel_id: 1,
    user: HIDDEN,
    content: "hi",
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: "2024-01-15T12:00:00Z",
    imported_author: { name: "Ann", color: "#112233" },
  };

  it("keeps imported_author on the stored message and omits it otherwise", () => {
    expect(messageResponseToMessage(response).importedAuthor).toEqual({
      name: "Ann",
      color: "#112233",
    });
    const { imported_author: _drop, ...plain } = response;
    expect("importedAuthor" in messageResponseToMessage(plain)).toBe(false);
  });

  it("carries imported_author into a pinned entry", () => {
    expect(mapToPinnedMessage(response).importedAuthor?.name).toBe("Ann");
    expect(mapToPinnedMessage({ ...response, imported_author: undefined }).importedAuthor).toBe(
      undefined,
    );
  });
});
