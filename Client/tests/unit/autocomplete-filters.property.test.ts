/**
 * Property tests for filterMentionSuggestions (MentionAutocomplete.ts) and
 * filterEmojiSuggestions (EmojiAutocomplete.ts).
 *
 * Invariants under fuzzing:
 *  - never throw on arbitrary query strings
 *  - respect their MAX_*_SUGGESTIONS caps
 *  - filterEmojiSuggestions returns [] for any query shorter than
 *    MIN_EMOJI_QUERY
 *  - @everyone/@here appear in filterMentionSuggestions only when the
 *    signed-in role holds MENTION_EVERYONE
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fc from "fast-check";

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
  filterMentionSuggestions,
  MAX_MENTION_SUGGESTIONS,
} from "../../src/components/MentionAutocomplete";
import {
  filterEmojiSuggestions,
  MAX_EMOJI_SUGGESTIONS,
  MIN_EMOJI_QUERY,
} from "../../src/components/EmojiAutocomplete";
import { membersStore } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore, setRoles } from "../../src/stores/channels.store";
import { emojiStore, setCustomEmoji, clearCustomEmoji } from "../../src/stores/emoji.store";
import { Permission } from "../../src/lib/types";

const NAMES = ["alice", "Alan", "Bob", "carol", "dave_99", "eve-ish"];

function seedMembers(names: readonly string[] = NAMES): void {
  membersStore.setState(() => ({
    members: new Map(
      names.map((n, i) => [
        i + 1,
        {
          id: i + 1,
          username: n,
          avatar: null,
          role: "member" as const,
          status: "online" as const,
        },
      ]),
    ),
    typingUsers: new Map(),
  }));
}

/** Sign in as a role, and register that role's permission mask. */
function signInAs(role: string, permissions: number): void {
  authStore.setState(() => ({
    token: "t",
    user: { id: 99, username: "me", avatar: null, role },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
  setRoles([{ id: 1, name: role, color: null, permissions }]);
  channelsStore.flush();
}

beforeEach(() => {
  seedMembers();
  signInAs("member", Permission.SEND_MESSAGES);
  clearCustomEmoji();
  emojiStore.flush();
  setCustomEmoji([
    { id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" },
    { id: 2, shortcode: "waffle", url: "/api/v1/emoji/2/image" },
  ]);
  emojiStore.flush();
});

const anyQuery = fc.string({ maxLength: 100 });
/** Query-shaped fragments: letters, digits, the punctuation a mention/emoji
 *  token can legally contain, and a few control characters thrown in. */
const queryFragment = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_.- \n\t@#:".split("")),
  maxLength: 40,
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

describe("filterMentionSuggestions — never throws", () => {
  it("never throws on arbitrary query strings", () => {
    fc.assert(
      fc.property(anyQuery, (q) => {
        expect(() => filterMentionSuggestions(q)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("never throws on query-shaped fragments, permission on or off", () => {
    fc.assert(
      fc.property(queryFragment, fc.boolean(), (q, everyone) => {
        signInAs("r", everyone ? Permission.MENTION_EVERYONE : 0);
        expect(() => filterMentionSuggestions(q)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});

describe("filterEmojiSuggestions — never throws", () => {
  it("never throws on arbitrary query strings", () => {
    fc.assert(
      fc.property(anyQuery, (q) => {
        expect(() => filterEmojiSuggestions(q)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("never throws on query-shaped fragments", () => {
    fc.assert(
      fc.property(queryFragment, (q) => {
        expect(() => filterEmojiSuggestions(q)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Caps and floors
// ---------------------------------------------------------------------------

describe("filterMentionSuggestions — cap", () => {
  it("never exceeds MAX_MENTION_SUGGESTIONS for any query", () => {
    seedMembers(Array.from({ length: 60 }, (_, i) => `user${String(i).padStart(2, "0")}`));
    fc.assert(
      fc.property(queryFragment, (q) => {
        expect(filterMentionSuggestions(q).length).toBeLessThanOrEqual(MAX_MENTION_SUGGESTIONS);
      }),
      { numRuns: 300 },
    );
  });
});

describe("filterEmojiSuggestions — cap and floor", () => {
  it("never exceeds MAX_EMOJI_SUGGESTIONS for any query", () => {
    fc.assert(
      fc.property(queryFragment, (q) => {
        expect(filterEmojiSuggestions(q).length).toBeLessThanOrEqual(MAX_EMOJI_SUGGESTIONS);
      }),
      { numRuns: 300 },
    );
  });

  it("returns [] for every query shorter than MIN_EMOJI_QUERY", () => {
    const shortQuery = fc.string({ maxLength: MIN_EMOJI_QUERY - 1 });
    fc.assert(
      fc.property(shortQuery, (q) => {
        expect(filterEmojiSuggestions(q)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it("returns [] for the empty string and single characters specifically", () => {
    expect(filterEmojiSuggestions("")).toEqual([]);
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 1 }), (c) => {
        expect(filterEmojiSuggestions(c)).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// MENTION_EVERYONE permission gate
// ---------------------------------------------------------------------------

describe("@everyone/@here only appear with MENTION_EVERYONE", () => {
  it("never appear without the permission, for any query", () => {
    fc.assert(
      fc.property(queryFragment, (q) => {
        signInAs("member", Permission.SEND_MESSAGES); // no MENTION_EVERYONE
        const tokens = filterMentionSuggestions(q).map((s) => s.token);
        expect(tokens).not.toContain("everyone");
        expect(tokens).not.toContain("here");
      }),
      { numRuns: 300 },
    );
  });

  it("only appear when the query is a prefix of the token, even with the permission", () => {
    fc.assert(
      fc.property(queryFragment, (q) => {
        signInAs("mod", Permission.MENTION_EVERYONE);
        const tokens = filterMentionSuggestions(q).map((s) => s.token);
        const lower = q.toLowerCase();
        if (tokens.includes("everyone")) expect("everyone".startsWith(lower)).toBe(true);
        if (tokens.includes("here")) expect("here".startsWith(lower)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("ADMINISTRATOR implies the broadcast entries are offered too", () => {
    signInAs("owner", Permission.ADMINISTRATOR);
    const tokens = filterMentionSuggestions("").map((s) => s.token);
    expect(tokens).toContain("everyone");
    expect(tokens).toContain("here");
  });
});
