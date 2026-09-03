/**
 * Custom-emoji end-to-end on the client: the store, `:shortcode:` rendering in
 * message content (including where it must NOT apply), the jumbo rule, and
 * reaction-pill resolution.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

// The emoji image is behind the session token, so buildCustomEmojiImage goes
// through the same authenticated fetch attachments use. Stub just that call —
// everything else in the module (isSafeUrl, resolveServerUrl) is real.
const { fetchImageAsDataUrlMock } = vi.hoisted(() => ({
  fetchImageAsDataUrlMock: vi.fn(() => Promise.resolve("data:image/png;base64,AAAA")),
}));
vi.mock("../../src/components/message-list/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/components/message-list/attachments")>();
  return { ...actual, fetchImageAsDataUrl: fetchImageAsDataUrlMock };
});

import {
  EMOJI_TOKEN_REGEX,
  MAX_JUMBO_EMOJI,
  buildCustomEmojiNode,
  isEmojiOnlyMessage,
} from "../../src/components/message-list/custom-emoji";
import { renderMessageContent } from "../../src/components/message-list/content-parser";
import { renderReactions } from "../../src/components/message-list/reactions";
import {
  emojiStore,
  setCustomEmoji,
  clearCustomEmoji,
  resolveEmoji,
  listCustomEmoji,
} from "../../src/stores/emoji.store";
import type { Message } from "../../src/stores/messages.store";
import type { MessageListOptions } from "../../src/components/MessageList";

const EMOJI = [
  { id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" },
  { id: 2, shortcode: "party_blob", url: "/api/v1/emoji/2/image" },
];

beforeEach(() => {
  clearCustomEmoji();
  emojiStore.flush();
  setCustomEmoji(EMOJI);
  emojiStore.flush();
  fetchImageAsDataUrlMock.mockClear();
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe("emoji store", () => {
  it("indexes by shortcode and keeps server order", () => {
    expect(listCustomEmoji().map((e) => e.shortcode)).toEqual(["wave", "party_blob"]);
    expect(resolveEmoji("wave")?.id).toBe(1);
    expect(resolveEmoji("party_blob")?.url).toBe("/api/v1/emoji/2/image");
  });

  it("resolves case-insensitively and with or without colons", () => {
    expect(resolveEmoji("WAVE")?.id).toBe(1);
    expect(resolveEmoji(":wave:")?.id).toBe(1);
    expect(resolveEmoji(":WaVe:")?.id).toBe(1);
  });

  it("returns null for unknown or malformed tokens", () => {
    expect(resolveEmoji("nosuch")).toBeNull();
    expect(resolveEmoji("")).toBeNull();
    expect(resolveEmoji("::")).toBeNull();
  });

  it("replaces the set wholesale so a deleted emoji stops resolving", () => {
    setCustomEmoji([{ id: 2, shortcode: "party_blob", url: "/api/v1/emoji/2/image" }]);
    emojiStore.flush();
    expect(resolveEmoji("wave")).toBeNull();
    expect(resolveEmoji("party_blob")).not.toBeNull();
  });

  it("drops entries whose shortcode the server could not have stored", () => {
    setCustomEmoji([
      { id: 1, shortcode: "ok_one", url: "/a" },
      { id: 2, shortcode: "has space", url: "/b" },
      { id: 3, shortcode: "x", url: "/c" },
      { id: 4, shortcode: "dash-es", url: "/d" },
    ]);
    emojiStore.flush();
    expect(listCustomEmoji().map((e) => e.shortcode)).toEqual(["ok_one"]);
  });

  it("lowercases shortcodes on the way in", () => {
    setCustomEmoji([{ id: 9, shortcode: "SHOUT", url: "/a" }]);
    emojiStore.flush();
    expect(listCustomEmoji()[0]?.shortcode).toBe("shout");
    expect(resolveEmoji("shout")?.id).toBe(9);
  });

  it("clearCustomEmoji empties the set", () => {
    clearCustomEmoji();
    emojiStore.flush();
    expect(listCustomEmoji()).toEqual([]);
    expect(resolveEmoji("wave")).toBeNull();
  });

  // OC-0362: clearCustomEmoji (MainPage.destroy, on logout/server switch)
  // used to rewind rev to 0 (or, when the set was already empty, leave it
  // untouched at 0), so a previous server's in-flight GET /emoji —
  // snapshotted at rev 0 right after connecting, before the clear — could
  // still match a freshly connected session's own rev-0 snapshot and
  // clobber it. Starts from a genuinely fresh store (rev 0, empty set) to
  // match the real repro: connect to A, GET /emoji is issued but has not
  // replied yet, then switch to B before it lands.
  it("clearCustomEmoji bumps the revision so a pre-clear snapshot can never match again", () => {
    emojiStore.setState(() => ({ emoji: [], byShortcode: new Map(), rev: 0 }));
    const revAtFetchA = emojiStore.getState().rev ?? 0; // snapshotted right after connecting to A

    clearCustomEmoji(); // switch to server B before A's GET /emoji replies
    emojiStore.flush();

    const revAtFetchB = emojiStore.getState().rev ?? 0; // snapshotted right after connecting to B
    expect(revAtFetchB).not.toBe(revAtFetchA);

    // A's late reply, still carrying the revision snapshotted before the
    // clear, must be rejected as stale rather than repopulating B's session.
    setCustomEmoji([{ id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" }], revAtFetchA);
    emojiStore.flush();
    expect(resolveEmoji("wave")).toBeNull();

    // B's own reply, carrying the revision snapshotted after the clear, still applies.
    setCustomEmoji([{ id: 3, shortcode: "b_new", url: "/api/v1/emoji/3/image" }], revAtFetchB);
    emojiStore.flush();
    expect(resolveEmoji("b_new")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Token regex + node builder
// ---------------------------------------------------------------------------

describe("emoji tokens", () => {
  it("matches shortcode-shaped tokens only", () => {
    const found = [...":wave: :party_blob: :a: :has space: plain".matchAll(EMOJI_TOKEN_REGEX)].map(
      (m) => m[1],
    );
    expect(found).toContain("wave");
    expect(found).toContain("party_blob");
    expect(found).not.toContain("a");
  });

  it("builds an image for a known shortcode and null for an unknown one", () => {
    const img = buildCustomEmojiNode("wave");
    expect(img).not.toBeNull();
    expect(img?.tagName).toBe("IMG");
    expect(img?.className).toBe("custom-emoji");
    expect(img?.alt).toBe(":wave:");
    expect(img?.getAttribute("data-shortcode")).toBe("wave");
    expect(buildCustomEmojiNode("nosuch")).toBeNull();
  });

  it("fetches the image through the authenticated path, not img.src", () => {
    buildCustomEmojiNode("wave");
    expect(fetchImageAsDataUrlMock).toHaveBeenCalledTimes(1);
    // resolveServerUrl leaves the path relative when no host has been set.
    const [url] = fetchImageAsDataUrlMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/api/v1/emoji/1/image");
  });
});

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function render(content: string): HTMLDivElement {
  const host = document.createElement("div");
  host.appendChild(renderMessageContent(content));
  return host;
}

describe("custom emoji in message content", () => {
  it("renders a known shortcode as an inline image", () => {
    const host = render("hello :wave: there");
    const imgs = host.querySelectorAll("img.custom-emoji");
    expect(imgs.length).toBe(1);
    expect(imgs[0]?.getAttribute("data-shortcode")).toBe("wave");
    expect(host.textContent).toContain("hello");
    expect(host.textContent).toContain("there");
  });

  it("leaves an unknown shortcode as literal text", () => {
    const host = render("hello :nosuch: there");
    expect(host.querySelectorAll("img.custom-emoji").length).toBe(0);
    expect(host.textContent).toContain(":nosuch:");
  });

  it("renders several emoji in one message", () => {
    const host = render(":wave: and :party_blob:");
    expect(host.querySelectorAll("img.custom-emoji").length).toBe(2);
  });

  it("never renders inside an inline code span", () => {
    const host = render("type `:wave:` to wave");
    expect(host.querySelectorAll("img.custom-emoji").length).toBe(0);
    expect(host.querySelector("code")?.textContent).toBe(":wave:");
  });

  it("never renders inside a fenced code block", () => {
    const host = render("```\n:wave:\n```");
    expect(host.querySelectorAll("img.custom-emoji").length).toBe(0);
    expect(host.querySelector(".msg-codeblock")?.textContent).toContain(":wave:");
  });

  it("never renders inside a tagged fence", () => {
    const host = render("```ts\nconst a = ':wave:';\n```");
    expect(host.querySelectorAll("img.custom-emoji").length).toBe(0);
  });

  it("renders around a fence but not inside it", () => {
    const host = render(":wave: before\n```\n:party_blob:\n```\n:wave: after");
    const imgs = host.querySelectorAll("img.custom-emoji");
    expect(imgs.length).toBe(2);
    expect([...imgs].every((i) => i.getAttribute("data-shortcode") === "wave")).toBe(true);
  });

  it("renders inside markdown emphasis", () => {
    const host = render("**:wave:**");
    expect(host.querySelector("strong img.custom-emoji")).not.toBeNull();
  });

  it("keeps working next to a URL", () => {
    const host = render("see https://example.com :wave:");
    expect(host.querySelectorAll("img.custom-emoji").length).toBe(1);
    expect(host.querySelector("a.msg-link")?.getAttribute("href")).toBe("https://example.com");
  });
});

// ---------------------------------------------------------------------------
// Jumbo
// ---------------------------------------------------------------------------

describe("jumbo emoji", () => {
  it("treats an emoji-only message as jumbo", () => {
    expect(isEmojiOnlyMessage(":wave:")).toBe(true);
    expect(isEmojiOnlyMessage(":wave: :party_blob:")).toBe(true);
    expect(isEmojiOnlyMessage("🔥")).toBe(true);
    expect(isEmojiOnlyMessage("🔥 :wave: 🎉")).toBe(true);
    expect(isEmojiOnlyMessage("👍🏽")).toBe(true);
    expect(isEmojiOnlyMessage("👨‍👩‍👧")).toBe(true);
  });

  it("does not jumbo a message with any other content", () => {
    expect(isEmojiOnlyMessage("hi :wave:")).toBe(false);
    expect(isEmojiOnlyMessage(":wave: !")).toBe(false);
    expect(isEmojiOnlyMessage("")).toBe(false);
    expect(isEmojiOnlyMessage("   ")).toBe(false);
    expect(isEmojiOnlyMessage("```\n🔥\n```")).toBe(false);
  });

  it("does not jumbo an unresolved shortcode — it is plain text", () => {
    expect(isEmojiOnlyMessage(":nosuch:")).toBe(false);
  });

  it("stops jumboing past the cap", () => {
    expect(isEmojiOnlyMessage("🔥".repeat(MAX_JUMBO_EMOJI))).toBe(true);
    expect(isEmojiOnlyMessage("🔥".repeat(MAX_JUMBO_EMOJI + 1))).toBe(false);
  });

  it("marks the rendered text block with the jumbo class", () => {
    expect(render(":wave:").querySelector(".msg-text-jumbo")).not.toBeNull();
    expect(render("🔥🔥").querySelector(".msg-text-jumbo")).not.toBeNull();
    expect(render("hi :wave:").querySelector(".msg-text-jumbo")).toBeNull();
    expect(render("hi :wave:").querySelector(".msg-text")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reaction pills
// ---------------------------------------------------------------------------

function makeMessage(emoji: string): Message {
  return {
    id: 1,
    channelId: 1,
    userId: 10,
    username: "alice",
    avatar: null,
    content: "hi",
    timestamp: "2026-01-01T00:00:00Z",
    editedAt: null,
    replyTo: null,
    attachments: [],
    reactions: [{ emoji, count: 2, me: false }],
    pending: false,
    failed: false,
    pinned: false,
  } as unknown as Message;
}

function reactionOptions(): MessageListOptions {
  return { onReactionClick: vi.fn() } as unknown as MessageListOptions;
}

describe("reaction pills", () => {
  it("renders the image for a custom-emoji reaction", () => {
    const el = renderReactions(
      makeMessage(":wave:"),
      reactionOptions(),
      new AbortController().signal,
    );
    const chip = el.querySelector(".reaction-chip");
    expect(chip?.querySelector("img.custom-emoji")).not.toBeNull();
    expect(chip?.getAttribute("data-emoji")).toBe(":wave:");
    expect(chip?.querySelector(".rc-count")?.textContent).toBe("2");
  });

  it("falls back to the literal text when the emoji is gone", () => {
    const el = renderReactions(
      makeMessage(":deleted_one:"),
      reactionOptions(),
      new AbortController().signal,
    );
    const chip = el.querySelector(".reaction-chip");
    expect(chip?.querySelector("img.custom-emoji")).toBeNull();
    expect(chip?.textContent).toContain(":deleted_one:");
  });

  it("leaves a unicode reaction as text", () => {
    const el = renderReactions(makeMessage("🔥"), reactionOptions(), new AbortController().signal);
    const chip = el.querySelector(".reaction-chip");
    expect(chip?.querySelector("img.custom-emoji")).toBeNull();
    expect(chip?.textContent).toContain("🔥");
  });

  it("still toggles the reaction when it renders as an image", () => {
    const opts = reactionOptions();
    const el = renderReactions(makeMessage(":wave:"), opts, new AbortController().signal);
    (el.querySelector(".reaction-chip") as HTMLElement).click();
    expect(opts.onReactionClick).toHaveBeenCalledWith(1, ":wave:");
  });
});
