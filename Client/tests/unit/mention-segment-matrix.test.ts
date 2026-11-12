/**
 * One prose segment with several kinds of token at once, and the resync of a
 * rendered row against changed member and role lists: the source-order merge,
 * the first-token-wins overlap rule and the regions a resync must not touch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";
import { useMountContainer } from "../helpers/mountContainer";

vi.mock("@lib/voice/livekitSession", () => voiceSession.defaults());

import {
  renderMentionSegment,
  renderMessageContent,
  resyncMentions,
} from "../../src/features/messaging/content/contentParser";
import { membersStore } from "../../src/stores/members.store";
import { channelsStore, setRoles } from "../../src/stores/channels.store";
import type { ReadyChannel } from "../../src/lib/types";
import { seedMembersAndChannels } from "../helpers/contentRenderHarness";

const CHANNELS: ReadyChannel[] = [
  { id: 1, name: "general", type: "text", category: null, position: 0 },
];

function seed(): void {
  seedMembersAndChannels(
    [
      [10, { id: 10, username: "alice", avatar: null, role: "member", status: "online" }],
      [12, { id: 12, username: "me", avatar: null, role: "member", status: "online" }],
    ],
    CHANNELS,
  );
  setRoles([{ id: 5, name: "Mods", color: "#ff8800", permissions: 0 }]);
  channelsStore.flush();
}

let container: HTMLDivElement;
useMountContainer((c) => {
  container = c;
});
beforeEach(seed);

function segment(text: string, info?: Parameters<typeof renderMentionSegment>[1]): HTMLElement {
  const row = document.createElement("div");
  row.className = "msg-text";
  row.appendChild(renderMentionSegment(text, info));
  container.appendChild(row);
  return row;
}

const kinds = (el: HTMLElement): string[] =>
  [...el.childNodes].map((n) =>
    n.nodeType === Node.TEXT_NODE ? `t:${n.textContent}` : `${(n as HTMLElement).className}`,
  );

function dropMember(id: number): void {
  membersStore.setState((prev) => ({
    ...prev,
    members: new Map([...prev.members].filter(([k]) => k !== id)),
  }));
}

describe("renderMentionSegment: mixed tokens", () => {
  it("lays every kind of token out in source order between its text runs", () => {
    const el = segment("a <@10> b @alice c <@&5> d #general e owncord://message/1/2 f");
    expect(kinds(el)).toEqual([
      "t:a ",
      "mention",
      "t: b ",
      "mention",
      "t: c ",
      "mention mention-role",
      "t: d ",
      "channel-mention",
      "t: e ",
      "message-link-chip",
      "t: f",
    ]);
  });

  it("plain text with no tokens is a single text node", () => {
    expect(kinds(segment("nothing here"))).toEqual(["t:nothing here"]);
  });

  it("an empty segment renders nothing", () => {
    expect(segment("").childNodes.length).toBe(0);
  });

  it("an id mention for an unknown user renders its plain stand-in in place", () => {
    expect(kinds(segment("x <@999> y"))).toEqual(["t:x ", "mention-plain", "t: y"]);
  });

  it("an unresolved @name, #name and :emoji: all stay text", () => {
    expect(kinds(segment("@nobody #nowhere :nope:"))).toEqual(["t:@nobody #nowhere :nope:"]);
  });

  it("an @token inside a message link does not also become a mention", () => {
    const el = segment("see owncord://message/1/2 now");
    expect(el.querySelectorAll(".mention").length).toBe(0);
    expect(el.querySelectorAll(".message-link-chip").length).toBe(1);
  });

  it("@everyone is a self-marked pill only when the server honoured it", () => {
    expect(
      segment("@everyone", { mentionsEveryone: true }).querySelector(".mention-everyone"),
    ).not.toBeNull();
    expect(segment("@here").querySelector(".mention")).toBeNull();
  });

  it("the signed-in user's id mention carries mention-self", () => {
    expect(segment("<@12>").querySelector(".mention")?.classList.contains("mention-self")).toBe(
      true,
    );
  });

  it("an id mention the server did not list is no self pill", () => {
    const el = segment("<@12>", { mentions: [10] });
    expect(el.querySelector(".mention")?.classList.contains("mention-self")).toBe(false);
  });

  it("a role mention the server dropped is plain text with the role name", () => {
    const el = segment("<@&5>", { mentionRoles: [] });
    expect(el.querySelector(".mention-plain")?.textContent).toBe("@Mods");
  });
});

describe("resyncMentions: regions and directions", () => {
  it("wraps a plain @token that has started to resolve", () => {
    const el = segment("hi @bob");
    expect(el.querySelector(".mention")).toBeNull();
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        ...prev.members,
        [13, { id: 13, username: "bob", avatar: null, role: "member", status: "online" as const }],
      ]),
    }));
    resyncMentions(container);
    expect(el.querySelector(".mention")?.textContent).toBe("@bob");
    expect(el.textContent).toBe("hi @bob");
  });

  it("unwraps a typed @mention whose member left", () => {
    const el = segment("hi @alice!");
    dropMember(10);
    resyncMentions(container);
    expect(el.querySelector(".mention")).toBeNull();
    expect(el.textContent).toBe("hi @alice!");
  });

  it("a role rename and recolour show on the existing pill", () => {
    const el = segment("<@&5>");
    setRoles([{ id: 5, name: "Staff", color: "#00ff00", permissions: 0 }]);
    channelsStore.flush();
    resyncMentions(container);
    const pill = el.querySelector<HTMLElement>(".mention-role");
    expect(pill?.textContent).toBe("@Staff");
    expect(pill?.dataset["roleColor"]).toBe("#00ff00");
  });

  it("a deleted role becomes @deleted-role plain text", () => {
    const el = segment("<@&5>");
    setRoles([]);
    channelsStore.flush();
    resyncMentions(container);
    expect(el.querySelector(".mention-plain")?.textContent).toBe("@deleted-role");
  });

  it("leaves code spans, code blocks and autolinks alone", () => {
    container.appendChild(
      renderMessageContent("`@alice` and https://example.com/@alice\n```\n@alice\n```"),
    );
    const before = container.innerHTML;
    expect(before).toContain("@alice");
    resyncMentions(container);
    expect(container.innerHTML).toBe(before);
    expect(container.querySelector(".mention")).toBeNull();
  });

  it("does not touch text outside .msg-text and .sm-text", () => {
    const outside = document.createElement("div");
    outside.className = "msg-author";
    outside.textContent = "@alice";
    container.appendChild(outside);
    resyncMentions(container);
    expect(outside.querySelector(".mention")).toBeNull();
    expect(outside.textContent).toBe("@alice");
  });

  it("also resyncs a system message's .sm-text", () => {
    const sm = document.createElement("div");
    sm.className = "sm-text";
    sm.textContent = "welcome @alice";
    container.appendChild(sm);
    resyncMentions(container);
    expect(sm.querySelector(".mention")?.textContent).toBe("@alice");
  });

  it("a mention in a masked link's label stays plain link content through a resync", () => {
    container.appendChild(renderMessageContent("[go <@10>](https://example.com)"));
    const link = container.querySelector("a.msg-link.masked");
    expect(link).not.toBeNull();
    expect(link?.querySelector(".mention")?.getAttribute("role")).toBeNull();
    resyncMentions(container);
    const pill = link?.querySelector(".mention");
    expect(pill?.textContent).toBe("@alice");
    expect(pill?.getAttribute("role")).toBeNull();
    expect(pill?.getAttribute("tabindex")).toBeNull();
    expect(pill?.getAttribute("data-user-id")).toBeNull();
  });

  it("a token in a masked link's label that resolves only now is also stripped", () => {
    container.appendChild(renderMessageContent("[go @bob](https://example.com)"));
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        ...prev.members,
        [13, { id: 13, username: "bob", avatar: null, role: "member", status: "online" as const }],
      ]),
    }));
    resyncMentions(container);
    const pill = container.querySelector("a.msg-link.masked .mention");
    expect(pill?.textContent).toBe("@bob");
    expect(pill?.getAttribute("role")).toBeNull();
  });

  it("an unchanged pill is kept as the same element", () => {
    const el = segment("hi @alice");
    const pill = el.querySelector(".mention");
    resyncMentions(container);
    expect(el.querySelector(".mention")).toBe(pill);
  });
});
