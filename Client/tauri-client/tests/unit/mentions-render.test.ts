/**
 * Mention + #channel-link rendering: which tokens highlight, which stay plain
 * text, and how a mention of the signed-in user marks the row.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

import {
  renderMentionSegment,
  renderMessageContent,
} from "../../src/components/message-list/content-parser";
import { renderMessage } from "../../src/components/message-list/renderers";
import {
  highlightsCurrentUser,
  mentionsCurrentUser,
  resolveMentionUserId,
} from "../../src/lib/mentions";
import { membersStore } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
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
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
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
