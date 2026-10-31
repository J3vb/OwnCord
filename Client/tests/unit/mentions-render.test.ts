/**
 * Mention + #channel-link rendering: which tokens highlight, which stay plain
 * text, and how a mention of the signed-in user marks the row.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () => voiceSession.defaults());

import {
  renderMentionSegment,
  renderMessageContent,
  resyncMentions,
} from "../../src/components/message-list/contentParser";
import { setChannelMutesHost } from "../../src/lib/prefs/channelMutes";
import { setInviteJoinHandler } from "../../src/lib/nav/inviteNavigation";
import { renderMessage } from "../../src/components/message-list/renderers";
import {
  highlightsCurrentUser,
  mentionsCurrentUser,
  resolveMentionUserId,
} from "../../src/lib/text/mentions";
import { membersStore } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore, setChannels, setRoles } from "../../src/stores/channels.store";
import type { Message } from "../../src/stores/messages.store";
import type { MessageListOptions } from "../../src/components/MessageList";
import type { ReadyChannel } from "../../src/lib/types";

const CHANNELS: ReadyChannel[] = [
  { id: 1, name: "general", type: "text", category: null, position: 0 },
  { id: 2, name: "off-topic", type: "text", category: null, position: 1 },
  { id: 3, name: "dm-3", type: "dm", category: null, position: 0 },
];

function seedStores(): void {
  membersStore.setState(() => ({
    members: new Map([
      [10, { id: 10, username: "alice", avatar: null, role: "member", status: "online" as const }],
      [11, { id: 11, username: "Bob", avatar: null, role: "admin", status: "online" as const }],
      [12, { id: 12, username: "me", avatar: null, role: "member", status: "online" as const }],
    ]),
    typingUsers: new Map(),
  }));
  authStore.setState(() => ({
    token: "t",
    user: { id: 12, username: "me", avatar: null, role: "member" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
    categories: [],
  }));
  setChannels(CHANNELS);
}

let container: HTMLDivElement;

beforeEach(() => {
  seedStores();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

function render(text: string, info?: Parameters<typeof renderMentionSegment>[1]): HTMLDivElement {
  container.appendChild(renderMentionSegment(text, info));
  return container;
}

describe("@mention rendering", () => {
  it("highlights a username that resolves against the member list", () => {
    const el = render("hey @alice");
    const mention = el.querySelector(".mention");
    expect(mention?.textContent).toBe("@alice");
    expect(mention?.getAttribute("data-user-id")).toBe("10");
  });

  it("resolves case-insensitively", () => {
    const el = render("hey @BOB");
    expect(el.querySelector(".mention")?.textContent).toBe("@BOB");
    expect(el.querySelector(".mention")?.getAttribute("data-user-id")).toBe("11");
  });

  it("leaves an unknown username as plain text", () => {
    const el = render("hey @nobody");
    expect(el.querySelector(".mention")).toBeNull();
    expect(el.textContent).toBe("hey @nobody");
  });

  it("does not treat an email local part as a mention", () => {
    const el = render("write to mail@example");
    expect(el.querySelector(".mention")).toBeNull();
  });

  it("does not match an address-shaped token", () => {
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        ...prev.members,
        [13, { id: 13, username: "bob", avatar: null, role: "member", status: "online" as const }],
      ]),
    }));
    const el = render("ping @bob@example.com");
    expect(el.querySelector(".mention")).toBeNull();
  });

  it("does not match a doubled @@name", () => {
    const el = render("@@alice");
    expect(el.querySelector(".mention")).toBeNull();
  });

  it("falls back to the trailing-punctuation spelling", () => {
    const el = render("thanks @alice.");
    expect(el.querySelector(".mention")?.textContent).toBe("@alice.");
  });

  it("marks a mention of the signed-in user with mention-self", () => {
    const el = render("hey @me and @alice");
    const spans = el.querySelectorAll(".mention");
    expect(spans.length).toBe(2);
    expect(spans[0]?.classList.contains("mention-self")).toBe(true);
    expect(spans[1]?.classList.contains("mention-self")).toBe(false);
  });

  it("prefers the server-resolved id for the spelling it matched", () => {
    // Two users could plausibly answer to "alice"; the server's list decides.
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        ...prev.members,
        [
          20,
          { id: 20, username: "Alice", avatar: null, role: "member", status: "online" as const },
        ],
      ]),
    }));
    const el = render("hi @alice", { mentions: [20] });
    expect(el.querySelector(".mention")?.getAttribute("data-user-id")).toBe("20");
  });

  it("does not fall back to the member list when the server sent a mentions list that omits the token", () => {
    // The server resolved this message's mentions to [10] (alice) only, not
    // the signed-in user (id 12, username "me"). The inline pill must agree
    // with the row-level gate and stay unresolved for "@me" here — a token
    // the server did not list must not render as a live mention, let alone a
    // self one.
    const el = render("hey @me", { mentions: [10] });
    expect(el.querySelector(".mention")).toBeNull();
    expect(el.textContent).toBe("hey @me");
  });
});

describe("@everyone / @here", () => {
  it("highlights when the server honoured the token", () => {
    const el = render("heads up @everyone", { mentionsEveryone: true });
    const span = el.querySelector(".mention");
    expect(span?.classList.contains("mention-everyone")).toBe(true);
    expect(span?.textContent).toBe("@everyone");
  });

  it("highlights @here the same way", () => {
    const el = render("@here now", { mentionsEveryone: true });
    expect(el.querySelector(".mention-everyone")?.textContent).toBe("@here");
  });

  it("stays plain text when the sender lacked MENTION_EVERYONE", () => {
    const el = render("heads up @everyone", { mentionsEveryone: false });
    expect(el.querySelector(".mention")).toBeNull();
    expect(el.textContent).toBe("heads up @everyone");
  });

  it("stays plain text when the server said nothing", () => {
    const el = render("heads up @here");
    expect(el.querySelector(".mention")).toBeNull();
  });

  it("never resolves @everyone as a username", () => {
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        ...prev.members,
        [
          30,
          { id: 30, username: "everyone", avatar: null, role: "member", status: "online" as const },
        ],
      ]),
    }));
    expect(resolveMentionUserId("everyone")).toBeNull();
  });
});

describe("#channel links", () => {
  it("renders a chip for a channel that exists", () => {
    const el = render("see #off-topic");
    const chip = el.querySelector(".channel-mention");
    expect(chip?.textContent).toBe("#off-topic");
    expect(chip?.getAttribute("data-channel-id")).toBe("2");
    expect(chip?.getAttribute("role")).toBe("link");
  });

  it("uses the channel's canonical casing", () => {
    const el = render("see #GENERAL");
    expect(el.querySelector(".channel-mention")?.textContent).toBe("#general");
  });

  it("leaves an unknown channel name as plain text", () => {
    const el = render("see #nowhere");
    expect(el.querySelector(".channel-mention")).toBeNull();
    expect(el.textContent).toBe("see #nowhere");
  });

  it("does not link DM channels", () => {
    const el = render("see #dm-3");
    expect(el.querySelector(".channel-mention")).toBeNull();
  });

  it("activates the channel on click", () => {
    const el = render("go to #off-topic");
    (el.querySelector(".channel-mention") as HTMLElement).click();
    channelsStore.flush();
    expect(channelsStore.getState().activeChannelId).toBe(2);
  });

  it("activates the channel on Enter", () => {
    const el = render("go to #off-topic");
    const chip = el.querySelector(".channel-mention") as HTMLElement;
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    channelsStore.flush();
    expect(channelsStore.getState().activeChannelId).toBe(2);
  });

  it("interleaves mentions and channel links in source order", () => {
    const el = render("@alice see #general then @Bob");
    const nodes = Array.from(el.querySelectorAll(".mention, .channel-mention"));
    expect(nodes.map((n) => n.textContent)).toEqual(["@alice", "#general", "@Bob"]);
  });
});

describe("code segments", () => {
  it("does not linkify tokens inside a code block", () => {
    container.appendChild(renderMessageContent("```@alice #general```"));
    expect(container.querySelector(".mention")).toBeNull();
    expect(container.querySelector(".channel-mention")).toBeNull();
  });

  it("does not linkify tokens inside inline code", () => {
    container.appendChild(renderMessageContent("run `@alice` now"));
    expect(container.querySelector(".mention")).toBeNull();
  });
});

describe("row highlight", () => {
  function makeMessage(overrides: Partial<Message> = {}): Message {
    return {
      id: 1,
      channelId: 1,
      user: { id: 10, username: "alice", avatar: null },
      content: "hello",
      replyTo: null,
      attachments: [],
      reactions: [],
      pinned: false,
      editedAt: null,
      deleted: false,
      timestamp: "2026-01-15T12:30:00Z",
      status: "sent",
      correlationId: null,
      errorCode: null,
      ...overrides,
    };
  }

  const opts = {
    channelId: 1,
    channelName: "general",
    currentUserId: 12,
    onScrollTop: vi.fn(),
    onReplyClick: vi.fn(),
    onEditClick: vi.fn(),
    onEditSave: vi.fn(() => true),
    onEmptyEdit: vi.fn(),
    onDeleteClick: vi.fn(),
    onReactionClick: vi.fn(),
    onPinClick: vi.fn(),
  } as unknown as MessageListOptions;

  function rowClasses(msg: Message): DOMTokenList {
    const ac = new AbortController();
    const el = renderMessage(msg, false, [msg], opts, ac.signal);
    ac.abort();
    return el.classList;
  }

  it("adds .mentioned when the server names the current user", () => {
    expect(
      rowClasses(makeMessage({ content: "hey @me", mentions: [12] })).contains("mentioned"),
    ).toBe(true);
  });

  it("adds .mentioned for an honoured @everyone", () => {
    expect(
      rowClasses(makeMessage({ content: "@everyone", mentionsEveryone: true })).contains(
        "mentioned",
      ),
    ).toBe(true);
  });

  it("does not add .mentioned for someone else's mention", () => {
    expect(
      rowClasses(makeMessage({ content: "hey @alice", mentions: [10] })).contains("mentioned"),
    ).toBe(false);
  });

  it("trusts the server list over the local name parse", () => {
    // The text names the current user, but the server resolved someone else
    // (e.g. the username changed since) — the server wins.
    expect(
      rowClasses(makeMessage({ content: "hey @me", mentions: [10] })).contains("mentioned"),
    ).toBe(false);
  });

  it("falls back to name resolution when the server sent no list", () => {
    expect(rowClasses(makeMessage({ content: "hey @me" })).contains("mentioned")).toBe(true);
  });

  it("does not highlight a deleted row", () => {
    expect(
      rowClasses(makeMessage({ content: "hey @me", mentions: [12], deleted: true })).contains(
        "mentioned",
      ),
    ).toBe(false);
  });
});

describe("mention predicates", () => {
  it("mentionsCurrentUser ignores @everyone", () => {
    expect(mentionsCurrentUser("@everyone", { mentionsEveryone: true })).toBe(false);
  });

  it("highlightsCurrentUser counts @everyone", () => {
    expect(highlightsCurrentUser("@everyone", { mentionsEveryone: true })).toBe(true);
  });

  it("is false when nobody is signed in", () => {
    authStore.setState((prev) => ({ ...prev, user: null }));
    expect(mentionsCurrentUser("hey @me")).toBe(false);
  });
});

describe("display names in mentions (P20)", () => {
  function nameAlice(displayName: string): void {
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        ...prev.members,
        [
          10,
          {
            id: 10,
            username: "alice",
            displayName,
            avatar: null,
            role: "member",
            status: "online" as const,
          },
        ],
      ]),
    }));
  }

  it("shows the display name with the typed @username as the title", () => {
    nameAlice("Alice W");
    const mention = render("hey @alice").querySelector<HTMLElement>(".mention");
    expect(mention?.textContent).toBe("@Alice W");
    expect(mention?.title).toBe("@alice");
    expect(mention?.dataset["mention"]).toBe("@alice");
  });

  it("keeps trailing punctuation after the display name", () => {
    nameAlice("Alice W");
    expect(render("hi @alice, ok").textContent).toBe("hi @Alice W, ok");
    expect(render("bye @alice.").textContent).toContain("@Alice W.");
  });

  it("drops the title on resync when the display name is cleared", () => {
    nameAlice("Alice W");
    const wrap = document.createElement("div");
    wrap.className = "msg-text";
    wrap.appendChild(renderMentionSegment("hey @alice"));
    const root = document.createElement("div");
    root.appendChild(wrap);
    nameAlice("alice");
    resyncMentions(root);
    const mention = wrap.querySelector(".mention");
    expect(mention?.textContent).toBe("@alice");
    expect(mention?.hasAttribute("title")).toBe(false);
  });

  it("keeps an unknown user as typed", () => {
    nameAlice("Alice W");
    expect(render("hey @nobody").textContent).toBe("hey @nobody");
  });

  it("updates the text on resync when the display name changes, keeping the pill", () => {
    nameAlice("Alice W");
    const el = render("hey @alice");
    nameAlice("Ally");
    const wrap = document.createElement("div");
    wrap.className = "msg-text";
    wrap.append(...Array.from(el.childNodes));
    const root = document.createElement("div");
    root.appendChild(wrap);
    resyncMentions(root);
    const mention = wrap.querySelector(".mention");
    expect(mention?.textContent).toBe("@Ally");
    expect(wrap.textContent).toBe("hey @Ally");
  });
});

describe("invite link chip (P29)", () => {
  const joined: Array<[string, string | undefined]> = [];
  let unregister: () => void;

  beforeEach(() => {
    joined.length = 0;
    unregister = setInviteJoinHandler((code, host) => joined.push([code, host]));
    setChannelMutesHost("here.example:8443");
    authStore.setState((prev) => ({ ...prev, serverName: "Here" }));
  });

  afterEach(() => {
    unregister();
    setChannelMutesHost(null);
    // Close through the dialog so its "one at a time" latch resets.
    document.querySelector<HTMLElement>("[data-testid='invite-join-cancel']")?.click();
  });

  it("renders a chip with the host and a Join action", () => {
    const chip = render("see owncord://invite/abc123?host=there.example").querySelector(
      ".message-link-chip",
    );
    expect(chip?.querySelector(".mlc-channel")?.textContent).toBe("there.example");
    expect(chip?.querySelector(".mlc-action")?.textContent).toBe("Join");
  });

  it("says this server when the link names no host", () => {
    const chip = render("owncord://invite/abc123").querySelector(".message-link-chip");
    expect(chip?.querySelector(".mlc-channel")?.textContent).toBe("this server");
  });

  it("has no click action for the server already open", () => {
    const chip = render("owncord://invite/abc?host=HERE.example:8443").querySelector<HTMLElement>(
      ".message-link-chip",
    );
    expect(chip?.querySelector(".mlc-action")?.textContent).toBe("You're already in this server");
    expect(chip?.getAttribute("role")).toBeNull();
    chip?.click();
    expect(document.querySelector("[data-testid='invite-join-dialog']")).toBeNull();
    expect(joined).toEqual([]);
  });

  it("treats a default :443 as the same server", () => {
    const chip = render("owncord://invite/abc?host=here.example:8443");
    expect(chip.querySelector(".invite-chip-here")).not.toBeNull();
    setChannelMutesHost("x.example");
    const el2 = render("owncord://invite/abc?host=x.example:443");
    expect(el2.querySelectorAll(".invite-chip-here").length).toBe(2);
  });

  it("opens the confirm on Enter", async () => {
    const chip = render("owncord://invite/abc?host=there.example").querySelector<HTMLElement>(
      ".message-link-chip",
    );
    chip?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid='invite-join-dialog']")).not.toBeNull(),
    );
  });

  it("does not make an interactive chip inside a masked link", () => {
    const el = document.createElement("div");
    el.appendChild(
      renderMessageContent("[owncord://invite/abc?host=there.example](https://e.example)"),
    );
    expect(el.querySelector(".message-link-chip")).toBeNull();
    expect(el.querySelector("a.masked")?.textContent).toContain("owncord://invite/abc");
  });

  it("asks before leaving, then runs the invite flow with (code, host)", async () => {
    const chip = render("owncord://invite/abc123?host=there.example").querySelector<HTMLElement>(
      ".message-link-chip",
    );
    chip?.click();
    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid='invite-join-dialog']")).not.toBeNull(),
    );
    const dialog = document.querySelector("[data-testid='invite-join-dialog']");
    expect(dialog?.textContent).toContain("Leave Here to join there.example?");
    expect(joined).toEqual([]);
    document.querySelector<HTMLElement>("[data-testid='invite-join-confirm']")?.click();
    expect(joined).toEqual([["abc123", "there.example"]]);
  });

  it("does not join when the prompt is cancelled", async () => {
    render("owncord://invite/abc123?host=there.example")
      .querySelector<HTMLElement>(".message-link-chip")
      ?.click();
    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid='invite-join-cancel']")).not.toBeNull(),
    );
    document.querySelector<HTMLElement>("[data-testid='invite-join-cancel']")?.click();
    expect(joined).toEqual([]);
  });

  it("leaves a malformed invite link as plain text", () => {
    const el = render("owncord://invite/");
    expect(el.querySelector(".message-link-chip")).toBeNull();
    expect(el.textContent).toBe("owncord://invite/");
  });
});

describe("id mention rendering", () => {
  function seedRoles(): void {
    setRoles([
      { id: 5, name: "Mods", color: "#ff8800", permissions: 0 },
      { id: 6, name: "Plain", color: null, permissions: 0 },
      { id: 7, name: "Odd", color: "red; background:url(x)", permissions: 0 },
    ]);
    channelsStore.flush();
  }

  it("renders <@id> with current display name", () => {
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        ...prev.members,
        [
          10,
          {
            id: 10,
            username: "alice",
            displayName: "Alice Liddell",
            avatar: null,
            role: "member",
            status: "online" as const,
          },
        ],
      ]),
    }));
    const el = render("hi <@10>!");
    const pill = el.querySelector(".mention");
    expect(pill?.textContent).toBe("@Alice Liddell");
    expect(pill?.getAttribute("data-user-id")).toBe("10");
    expect(pill?.classList.contains("mention-self")).toBe(false);
    expect(el.textContent).toBe("hi @Alice Liddell!");
  });

  it("falls back to the username and marks the signed-in user", () => {
    const el = render("<@12> and <@11>");
    const pills = el.querySelectorAll(".mention");
    expect(Array.from(pills).map((p) => p.textContent)).toEqual(["@me", "@Bob"]);
    expect(pills[0]?.classList.contains("mention-self")).toBe(true);
    expect(pills[1]?.classList.contains("mention-self")).toBe(false);
  });

  /** A rendered run inside the region resync scans. */
  function renderInRow(text: string): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "msg-text";
    row.appendChild(renderMentionSegment(text));
    container.appendChild(row);
    return row;
  }

  it("follows a rename on resync", () => {
    const el = renderInRow("hi <@10>");
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        ...prev.members,
        [
          10,
          { id: 10, username: "alicia", avatar: null, role: "member", status: "online" as const },
        ],
      ]),
    }));
    resyncMentions(container);
    expect(el.querySelector(".mention")?.textContent).toBe("@alicia");
  });

  it("<@&id> with role colour", () => {
    seedRoles();
    const el = render("ping <@&5>");
    const pill = el.querySelector<HTMLElement>(".mention.mention-role");
    expect(pill?.textContent).toBe("@Mods");
    expect(pill?.getAttribute("data-role-id")).toBe("5");
    expect(pill?.getAttribute("data-role-color")).toBe("#ff8800");
    expect(pill?.style.getPropertyValue("--role-pill")).toBe("#ff8800");
    // A role pill opens no profile.
    expect(pill?.hasAttribute("data-user-id")).toBe(false);
    expect(pill?.hasAttribute("role")).toBe(false);
  });

  it("never applies a colour that is not a hex literal", () => {
    seedRoles();
    const odd = render("<@&7>").querySelector<HTMLElement>(".mention-role");
    expect(odd?.textContent).toBe("@Odd");
    expect(odd?.hasAttribute("data-role-color")).toBe(false);
    expect(odd?.getAttribute("style") ?? "").toBe("");
    const none = render("<@&6>").querySelectorAll<HTMLElement>(".mention-role");
    expect(none[none.length - 1]?.hasAttribute("data-role-color")).toBe(false);
  });

  it("marks a role pill for a held role with mention-self", () => {
    seedRoles();
    authStore.setState((prev) => ({
      ...prev,
      user: prev.user === null ? null : { ...prev.user, role_ids: [5] },
    }));
    const el = render("<@&5> <@&6>", { mentionRoles: [5, 6] });
    const pills = el.querySelectorAll(".mention-role");
    expect(pills[0]?.classList.contains("mention-self")).toBe(true);
    expect(pills[1]?.classList.contains("mention-self")).toBe(false);
  });

  it("a held role the server did not list is no mention-self pill", () => {
    seedRoles();
    authStore.setState((prev) => ({
      ...prev,
      user: prev.user === null ? null : { ...prev.user, role_ids: [5] },
    }));
    const pill = render("<@&5>").querySelector(".mention-role");
    expect(pill?.textContent).toBe("@Mods");
    expect(pill?.classList.contains("mention-self")).toBe(false);
  });

  it("a self pill the server did not list is not mention-self", () => {
    expect(render("<@12>", { mentions: [10] }).querySelector(".mention")?.className).toBe(
      "mention",
    );
    expect(render("<@12>", { mentions: [12] }).querySelector(".mention-self")).not.toBeNull();
  });

  it("unknown ids stay plain", () => {
    seedRoles();
    const el = render("<@999> and <@&888>");
    expect(el.querySelector(".mention")).toBeNull();
    expect(el.querySelector("[data-user-id]")).toBeNull();
    expect(el.textContent).toBe("@unknown-user and @deleted-role");
  });

  it("a role the server did not honour reads as plain text", () => {
    seedRoles();
    const el = render("<@&5>", { mentionRoles: [] });
    expect(el.querySelector(".mention")).toBeNull();
    expect(el.textContent).toBe("@Mods");
    const honoured = render("<@&5>", { mentionRoles: [5] });
    expect(honoured.querySelector(".mention-role")).not.toBeNull();
  });

  it("a member who left becomes @unknown-user on resync and a pill again on return", () => {
    const el = renderInRow("hi <@10>");
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([...prev.members].filter(([id]) => id !== 10)),
    }));
    resyncMentions(container);
    expect(el.querySelector(".mention")).toBeNull();
    expect(el.textContent).toBe("hi @unknown-user");
    seedStores();
    resyncMentions(container);
    expect(el.querySelector(".mention")?.textContent).toBe("@alice");
  });

  it("leaves a token in code alone and keeps the row accent in step", () => {
    const code = renderMessageContent("`<@10>`");
    expect(code.textContent).toBe("<@10>");
    expect(code.querySelector(".mention")).toBeNull();
  });

  it("is a legacy-compatible no-op for @name text", () => {
    const el = render("hey @alice");
    expect(el.querySelector(".mention")?.textContent).toBe("@alice");
  });
});
