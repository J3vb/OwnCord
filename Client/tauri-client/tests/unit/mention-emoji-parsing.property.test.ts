/**
 * Property tests for custom-emoji token handling (custom-emoji.ts) and the
 * @mention / #channel chip rendering in content-parser.ts.
 *
 * Invariants under fuzzing:
 *  - none of these ever throw on arbitrary input
 *  - a `:shortcode:` / `@token` / `#channel` chip renders only when it
 *    resolves to something real (a known custom emoji / member / channel);
 *    everything else stays literal text, byte for byte
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";

// The emoji image is behind the session token; stub the authenticated fetch
// so buildCustomEmojiNode's async image swap does not hit the network.
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
  buildCustomEmojiNode,
  isEmojiOnlyMessage,
} from "../../src/components/message-list/custom-emoji";
import {
  renderMessageContent,
  renderMentionSegment,
} from "../../src/components/message-list/content-parser";
import { emojiStore, setCustomEmoji, clearCustomEmoji } from "../../src/stores/emoji.store";
import { membersStore } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
import type { ReadyChannel } from "../../src/lib/types";

const CHANNELS: ReadyChannel[] = [
  { id: 1, name: "general", type: "text", category: null, position: 0 },
];

const KNOWN_MEMBER_ID = 10;
const SELF_ID = 12;
const KNOWN_SHORTCODE = "wave";
const KNOWN_CHANNEL_ID = 1;

function seedStores(): void {
  membersStore.setState(() => ({
    members: new Map([
      [
        KNOWN_MEMBER_ID,
        {
          id: KNOWN_MEMBER_ID,
          username: "alice",
          avatar: null,
          role: "member",
          status: "online" as const,
        },
      ],
    ]),
    typingUsers: new Map(),
  }));
  authStore.setState(() => ({
    token: "t",
    user: { id: SELF_ID, username: "me", avatar: null, role: "member" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
  setChannels(CHANNELS);
  clearCustomEmoji();
  emojiStore.flush();
  setCustomEmoji([{ id: 1, shortcode: KNOWN_SHORTCODE, url: "/api/v1/emoji/1/image" }]);
  emojiStore.flush();
}

beforeEach(() => {
  seedStores();
});

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
});

const anyString = fc.string({ maxLength: 300 });

/** Alphabet weighted toward the token-shaped characters (@, #, :, word chars,
 *  punctuation) so fuzzing actually exercises the tokenizers' branch points. */
const TOKEN_CHARS = [
  "@",
  "#",
  ":",
  "_",
  "-",
  ".",
  " ",
  "\n",
  "a",
  "l",
  "i",
  "c",
  "e",
  "w",
  "v",
  "1",
  "9",
  "everyone",
  "here",
  "wave",
  "general",
];
const tokenFragment = fc.string({ unit: fc.constantFrom(...TOKEN_CHARS), maxLength: 200 });

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

describe("custom-emoji — never throws", () => {
  it("buildCustomEmojiNode never throws on arbitrary tokens", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        expect(() => buildCustomEmojiNode(s)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("isEmojiOnlyMessage never throws on arbitrary content", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        expect(() => isEmojiOnlyMessage(s)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("EMOJI_TOKEN_REGEX never throws when matched against arbitrary content", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        expect(() => [...s.matchAll(EMOJI_TOKEN_REGEX)]).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});

describe("mention / channel rendering — never throws", () => {
  it("renderMentionSegment never throws on arbitrary content", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        expect(() => renderMentionSegment(s)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("renderMentionSegment never throws on token-shaped fragments", () => {
    fc.assert(
      fc.property(tokenFragment, (s) => {
        expect(() => renderMentionSegment(s)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it("renderMessageContent never throws on token-shaped fragments (with mentionsEveryone)", () => {
    fc.assert(
      fc.property(tokenFragment, fc.boolean(), (s, mentionsEveryone) => {
        expect(() => renderMessageContent(s, { mentionsEveryone })).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Chips only render for resolvable ids
// ---------------------------------------------------------------------------

describe("chips only render for what actually resolves", () => {
  it("every rendered @mention chip points at the known member or self, never a made-up id", () => {
    fc.assert(
      fc.property(tokenFragment, (s) => {
        const host = document.createElement("div");
        host.appendChild(renderMentionSegment(s));
        for (const span of Array.from(host.querySelectorAll(".mention[data-user-id]"))) {
          const id = Number(span.getAttribute("data-user-id"));
          expect([KNOWN_MEMBER_ID, SELF_ID]).toContain(id);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("every rendered #channel chip points at a known channel id", () => {
    fc.assert(
      fc.property(tokenFragment, (s) => {
        const host = document.createElement("div");
        host.appendChild(renderMentionSegment(s));
        for (const span of Array.from(host.querySelectorAll(".channel-mention[data-channel-id]"))) {
          const id = Number(span.getAttribute("data-channel-id"));
          expect(id).toBe(KNOWN_CHANNEL_ID);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("every rendered custom-emoji image points at the known shortcode", () => {
    fc.assert(
      fc.property(tokenFragment, (s) => {
        const host = document.createElement("div");
        host.appendChild(renderMentionSegment(s));
        for (const img of Array.from(host.querySelectorAll("img.custom-emoji"))) {
          expect(img.getAttribute("data-shortcode")).toBe(KNOWN_SHORTCODE);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("@everyone/@here never highlights as mention-everyone without server-confirmed mentionsEveryone", () => {
    fc.assert(
      fc.property(tokenFragment, (s) => {
        const host = document.createElement("div");
        // No MentionInfo passed at all -> mentionsEveryone is undefined, never true.
        host.appendChild(renderMentionSegment(s));
        expect(host.querySelectorAll(".mention-everyone").length).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it("@everyone highlights only when mentionsEveryone is explicitly true", () => {
    const host1 = document.createElement("div");
    host1.appendChild(renderMentionSegment("hey @everyone", { mentionsEveryone: false }));
    expect(host1.querySelectorAll(".mention-everyone").length).toBe(0);

    const host2 = document.createElement("div");
    host2.appendChild(renderMentionSegment("hey @everyone", { mentionsEveryone: true }));
    expect(host2.querySelectorAll(".mention-everyone").length).toBe(1);
  });

  it("resolvable shortcode still renders as an image; arbitrary unresolvable ones stay literal", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 2, maxLength: 32 }).filter((s) => /^[A-Za-z0-9_]+$/.test(s)),
        (code) => {
          const host = document.createElement("div");
          host.appendChild(renderMentionSegment(`:${code}:`));
          const imgs = host.querySelectorAll("img.custom-emoji");
          if (code.toLowerCase() === KNOWN_SHORTCODE) {
            expect(imgs.length).toBe(1);
          } else {
            expect(imgs.length).toBe(0);
            expect(host.textContent).toBe(`:${code}:`);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("arbitrary text with no @/#/: tokens renders as untouched literal text", () => {
    const plain = fc.string({
      unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz ".split("")),
      maxLength: 100,
    });
    fc.assert(
      fc.property(plain, (s) => {
        const host = document.createElement("div");
        host.appendChild(renderMentionSegment(s));
        expect(host.textContent).toBe(s);
        expect(host.querySelectorAll(".mention, .channel-mention, img.custom-emoji").length).toBe(
          0,
        );
      }),
      { numRuns: 200 },
    );
  });
});
