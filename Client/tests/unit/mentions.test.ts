/**
 * lib/text/mentions.ts — id tokens (`<@id>`, `<@&id>`) and role mentions (WP 6.3e):
 * which messages highlight or notify the signed-in user, and the composer's
 * picked-span conversion.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  CHANNEL_TOKEN_REGEX,
  ID_MENTION_REGEX,
  MENTION_TOKEN_REGEX,
  ROLE_MENTION_REGEX,
  isEveryoneToken,
  currentUserHeldRoleIds,
  highlightsCurrentUser,
  mentionSpellings,
  mentionsCurrentUser,
  resolveMentionsFromContent,
} from "../../src/lib/text/mentions";
import { applyPickedMentions, tokensToPickedText } from "../../src/lib/text/pickedMentions";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore, setRoles } from "../../src/stores/channels.store";
import { membersStore } from "../../src/stores/members.store";
import { resetMembersState } from "../helpers/storeResets";

function member(id: number, username: string, displayName?: string) {
  return {
    id,
    username,
    ...(displayName === undefined ? {} : { displayName }),
    avatar: null,
    role: "member",
    status: "online" as const,
  };
}

function signIn(role: string, roleIds?: readonly number[]): void {
  authStore.setState(() => ({
    token: "t",
    user: {
      id: 12,
      username: "me",
      avatar: null,
      role,
      ...(roleIds === undefined ? {} : { role_ids: roleIds }),
    },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
}

beforeEach(() => {
  membersStore.setState(() => ({
    members: new Map([
      [10, member(10, "alice")],
      [12, member(12, "me")],
    ]),
    typingUsers: new Map(),
  }));
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
    categories: [],
  }));
  setRoles([
    { id: 5, name: "Mods", color: "#ff0000", permissions: 0 },
    { id: 6, name: "Devs", color: null, permissions: 0 },
  ]);
  channelsStore.flush();
  signIn("member", [5]);
});

describe("token regexes", () => {
  it("match only the exact id forms", () => {
    expect([..."a <@12> b <@&5>".matchAll(ID_MENTION_REGEX)].map((m) => m[1])).toEqual(["12"]);
    expect([..."a <@12> b <@&5>".matchAll(ROLE_MENTION_REGEX)].map((m) => m[1])).toEqual(["5"]);
    expect("<@ 12> <@x> <@>".match(ID_MENTION_REGEX)).toBeNull();
  });
});

describe("role mentions", () => {
  it("role mention highlights a holder", () => {
    expect(mentionsCurrentUser("ping <@&5>", { mentionRoles: [5] })).toBe(true);
    expect(highlightsCurrentUser("ping <@&5>", { mentionRoles: [5] })).toBe(true);
  });

  it("a typed token the server did not list never counts", () => {
    expect(mentionsCurrentUser("ping <@&5>")).toBe(false);
    expect(highlightsCurrentUser("ping <@&5>", { mentions: [] })).toBe(false);
  });

  it("role mention does not highlight a non-holder", () => {
    expect(mentionsCurrentUser("ping <@&6>", { mentionRoles: [6] })).toBe(false);
    expect(highlightsCurrentUser("ping <@&6>", { mentionRoles: [6] })).toBe(false);
    expect(mentionsCurrentUser("no tokens here")).toBe(false);
  });

  it("counts any one of several held roles", () => {
    signIn("member", [6, 5]);
    expect(mentionsCurrentUser("x", { mentionRoles: [6] })).toBe(true);
    expect(mentionsCurrentUser("x", { mentionRoles: [5] })).toBe(true);
  });

  it("falls back to the role name's id when role_ids is absent", () => {
    signIn("mods");
    expect(mentionsCurrentUser("x", { mentionRoles: [5] })).toBe(true);
    expect(mentionsCurrentUser("x", { mentionRoles: [6] })).toBe(false);
  });

  it("trusts mention_roles over the content once the server sends it", () => {
    // The server declined the token (gate failed): listed none.
    expect(mentionsCurrentUser("<@&5>", { mentionRoles: [] })).toBe(false);
    // The server honoured a role the content does not spell.
    expect(mentionsCurrentUser("plain text", { mentionRoles: [5] })).toBe(true);
    expect(mentionsCurrentUser("<@&5>", { mentionRoles: [6] })).toBe(false);
  });

  it("is not a user mention when nobody is signed in", () => {
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
    expect(mentionsCurrentUser("<@&5> <@12>", { mentionRoles: [5] })).toBe(false);
  });
});

describe("currentUserHeldRoleIds", () => {
  it("is the server's role_ids as sent, known to the roster or not", () => {
    signIn("member", [3, 99]);
    expect(currentUserHeldRoleIds()).toEqual([3, 99]);
    signIn("member", []);
    expect(currentUserHeldRoleIds()).toEqual([]);
  });

  it("is the id of the role name without role_ids, case-insensitively", () => {
    signIn("DEVS");
    expect(currentUserHeldRoleIds()).toEqual([6]);
  });

  it("is empty for an unknown role name, a null role or nobody signed in", () => {
    signIn("ghost");
    expect(currentUserHeldRoleIds()).toEqual([]);
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 12, username: "me", avatar: null, role: null as unknown as string },
    }));
    expect(currentUserHeldRoleIds()).toEqual([]);
    authStore.setState((prev) => ({ ...prev, user: null }));
    expect(currentUserHeldRoleIds()).toEqual([]);
  });
});

describe("id mentions", () => {
  it("id token survives rename", () => {
    membersStore.setState(() => ({
      members: new Map([[12, member(12, "renamed-me")]]),
      typingUsers: new Map(),
    }));
    expect(mentionsCurrentUser("hi <@12>")).toBe(true);
    expect(mentionsCurrentUser("hi <@10>")).toBe(false);
    expect(resolveMentionsFromContent("hi <@10> and <@12> and <@10>")).toEqual([10, 12]);
  });

  it("highlights by id even when the member list does not hold the user", () => {
    resetMembersState();
    expect(mentionsCurrentUser("<@12>")).toBe(true);
  });

  it("does not read <@5> as the user named 5", () => {
    membersStore.setState(() => ({
      members: new Map([[7, member(7, "5")]]),
      typingUsers: new Map(),
    }));
    expect(resolveMentionsFromContent("<@5>")).toEqual([5]);
    expect(resolveMentionsFromContent("@5")).toEqual([7]);
  });

  it("stays authoritative for the server's list when it sent one", () => {
    expect(mentionsCurrentUser("<@12>", { mentions: [10] })).toBe(false);
    expect(mentionsCurrentUser("<@12>", { mentions: [12] })).toBe(true);
  });
});

describe("applyPickedMentions", () => {
  const picks = [
    { text: "@alice", token: "<@10>" },
    { text: "@Mods", token: "<@&5>" },
  ];

  it("rewrites each picked span that is still intact", () => {
    expect(applyPickedMentions("hey @alice and @Mods!", picks)).toBe("hey <@10> and <@&5>!");
  });

  it("an edited span no longer matches and goes as plain text", () => {
    expect(applyPickedMentions("hey @alicia and @Mod", picks)).toBe("hey @alicia and @Mod");
    expect(applyPickedMentions("hey @alice.smith", picks)).toBe("hey @alice.smith");
    expect(applyPickedMentions("mail@alice", picks)).toBe("mail@alice");
  });

  it("keeps trailing sentence punctuation", () => {
    expect(applyPickedMentions("hi @alice.", picks)).toBe("hi <@10>.");
    expect(applyPickedMentions("@alice, @alice", picks)).toBe("<@10>, <@10>");
  });

  it("converts a role name with spaces", () => {
    expect(
      applyPickedMentions("yo @Night Owls now", [{ text: "@Night Owls", token: "<@&9>" }]),
    ).toBe("yo <@&9> now");
  });

  it("leaves an ambiguous span (two ids, one spelling) as text", () => {
    const both = [
      { text: "@Ali", token: "<@1>" },
      { text: "@Ali", token: "<@&2>" },
    ];
    expect(applyPickedMentions("@Ali", both)).toBe("@Ali");
  });

  it("is the identity with no picks", () => {
    expect(applyPickedMentions("hey @alice", [])).toBe("hey @alice");
  });
});

describe("tokensToPickedText", () => {
  const NAMES = {
    user: (id: number) => (id === 10 ? "Alice A" : undefined),
    role: (id: number) => (id === 5 ? "Mods" : undefined),
  };

  it("shows ids as names and returns the picks that convert them back", () => {
    const { text, picks } = tokensToPickedText("hi <@10> and <@&5>, bye", NAMES);
    expect(text).toBe("hi @Alice A and @Mods, bye");
    expect(applyPickedMentions(text, picks)).toBe("hi <@10> and <@&5>, bye");
  });

  it("leaves tokens for ids it cannot name", () => {
    const { text, picks } = tokensToPickedText("hi <@99> <@&77>", NAMES);
    expect(text).toBe("hi <@99> <@&77>");
    expect(picks).toEqual([]);
  });

  it("falls back to the raw text when the names would not round-trip", () => {
    const { text, picks } = tokensToPickedText("x<@10>y", NAMES);
    expect(text).toBe("x<@10>y");
    expect(picks).toEqual([]);
  });

  it("is the identity on content without tokens", () => {
    expect(tokensToPickedText("just @alice text", NAMES)).toEqual({
      text: "just @alice text",
      picks: [],
    });
  });
});

describe("channel tokens", () => {
  const tokens = (text: string): string[] =>
    [...text.matchAll(CHANNEL_TOKEN_REGEX)].map((m) => m[2] ?? "");

  it("take the whole name, up to 64 characters, and stop at punctuation", () => {
    expect(tokens("#a-b_c9 ok")).toEqual(["a-b_c9"]);
    expect(tokens("#émile.")).toEqual(["émile"]);
    expect(tokens(`#${"x".repeat(70)}`)).toEqual(["x".repeat(64)]);
  });

  it("report the character before the token, empty at the start", () => {
    expect([..."#a (#b".matchAll(CHANNEL_TOKEN_REGEX)].map((m) => m[1])).toEqual(["", "("]);
  });

  it("match at the start of the text and after a non-word character", () => {
    expect(tokens("#general")).toEqual(["general"]);
    expect(tokens("see #general, #random-2")).toEqual(["general", "random-2"]);
  });

  it("do not match when glued to a word or another #", () => {
    expect(tokens("issue#12 ##x abc#def")).toEqual([]);
  });
});

describe("mentionSpellings", () => {
  it("is just the lower-cased token when nothing trails it", () => {
    expect(mentionSpellings("Bob")).toEqual(["bob"]);
    expect(mentionSpellings("a.b")).toEqual(["a.b"]);
  });

  it("adds the spelling without every trailing dot and dash", () => {
    expect(mentionSpellings("Bob.")).toEqual(["bob.", "bob"]);
    expect(mentionSpellings("Bob.-.")).toEqual(["bob.-.", "bob"]);
    expect(mentionSpellings("a.b.")).toEqual(["a.b.", "a.b"]);
  });

  it("does not offer an empty spelling for a token of only dots and dashes", () => {
    expect(mentionSpellings("..")).toEqual([".."]);
    expect(mentionSpellings("-")).toEqual(["-"]);
  });
});

describe("mentions in address-shaped text", () => {
  it("does not count a name that is part of an address", () => {
    expect(resolveMentionsFromContent("write to @alice@example.com")).toEqual([]);
    expect(resolveMentionsFromContent("write to @alice")).toEqual([10]);
  });
});

describe("role mentions with several roles", () => {
  it("highlights when the user holds only some of the mentioned roles", () => {
    signIn("member", [5]);
    expect(mentionsCurrentUser("hi", { mentions: [], mentionRoles: [5, 6] })).toBe(true);
    expect(mentionsCurrentUser("hi", { mentions: [], mentionRoles: [6] })).toBe(false);
    expect(mentionsCurrentUser("hi", { mentions: [], mentionRoles: [] })).toBe(false);
  });
});

describe("applyPickedMentions edges", () => {
  const alice = { text: "@alice", token: "<@10>" };

  it("does not rewrite a span glued to a character just before it", () => {
    expect(applyPickedMentions("x@alice hi", [alice])).toBe("x@alice hi");
    expect(applyPickedMentions(" @alice hi", [alice])).toBe(" <@10> hi");
  });

  it("does not rewrite a span followed by a longer name after dots or dashes", () => {
    expect(applyPickedMentions("hi @alice..bob", [alice])).toBe("hi @alice..bob");
    expect(applyPickedMentions("hi @alice-.-bob", [alice])).toBe("hi @alice-.-bob");
    expect(applyPickedMentions("hi @alice.bob", [alice])).toBe("hi @alice.bob");
  });

  it("rewrites spans in the order they appear, whichever pick came first", () => {
    const picks = [
      { text: "@zed", token: "<@3>" },
      { text: "@amy", token: "<@1>" },
      { text: "@kim", token: "<@2>" },
    ];
    expect(applyPickedMentions("@amy then @kim then @zed", picks)).toBe("<@1> then <@2> then <@3>");
  });

  it("uses the longer pick when two picks cover the same start", () => {
    const picks = [
      { text: "@Night Owls", token: "<@&5>" },
      { text: "@Night", token: "<@&6>" },
    ];
    expect(applyPickedMentions("hi @Night Owls rock", picks)).toBe("hi <@&5> rock");
  });
});

describe("tokensToPickedText names", () => {
  const sameName = { user: () => "sam", role: () => undefined };

  it("leaves a second token as raw text when two ids share one name", () => {
    const out = tokensToPickedText("<@1> and <@2>", sameName);
    expect(out.text).toBe("@sam and <@2>");
    expect(out.picks).toEqual([{ text: "@sam", token: "<@1>" }]);
  });

  it("shows the same token twice under its name", () => {
    const out = tokensToPickedText("<@1> and <@1>", sameName);
    expect(out.text).toBe("@sam and @sam");
    expect(out.picks).toHaveLength(2);
  });
});

describe("@ token grammar", () => {
  const parts = (text: string): string[][] =>
    [...text.matchAll(MENTION_TOKEN_REGEX)].map((m) => [m[1] ?? "", m[2] ?? "", m[3] ?? ""]);

  it("matches at the start of the text and after a space or punctuation", () => {
    expect(parts("@alice")).toEqual([["", "alice", ""]]);
    expect(parts("hi @alice, (@bob) and\n@kim!")).toEqual([
      [" ", "alice", ""],
      ["(", "bob", ""],
      ["\n", "kim", ""],
    ]);
  });

  it("takes the whole name, with dots, dashes and digits, up to 64 characters", () => {
    expect(parts("@a.b-c_9 ok")).toEqual([["", "a.b-c_9", ""]]);
    expect(parts(`@${"x".repeat(70)}`)[0]?.[1]).toBe("x".repeat(64));
    expect(parts("@émile ok")).toEqual([["", "émile", ""]]);
  });

  it("reports a trailing @ so address-shaped text can be refused", () => {
    expect(parts("@bob@example.com")).toEqual([["", "bob", "@"]]);
  });

  it("does not match when glued to a word, a digit, an underscore or another @", () => {
    expect(parts("mail@example a1@b _@c @@d é@f")).toEqual([]);
  });
});

describe("id token grammar", () => {
  it("takes one to fifteen digits, never letters", () => {
    expect([..."<@7> <@123456789012345>".matchAll(ID_MENTION_REGEX)].map((m) => m[1])).toEqual([
      "7",
      "123456789012345",
    ]);
    expect("<@1234567890123456>".match(ID_MENTION_REGEX)).toBeNull();
    expect("<@abc>".match(ID_MENTION_REGEX)).toBeNull();
    expect("<@&abc> <@&1234567890123456>".match(ROLE_MENTION_REGEX)).toBeNull();
    expect([..."<@&42>".matchAll(ROLE_MENTION_REGEX)].map((m) => m[1])).toEqual(["42"]);
  });
});

describe("@everyone and @here", () => {
  it("are recognised in any case and never resolve to a user", () => {
    expect(isEveryoneToken("everyone")).toBe(true);
    expect(isEveryoneToken("HERE")).toBe(true);
    expect(isEveryoneToken("hereby")).toBe(false);
    expect(isEveryoneToken("")).toBe(false);

    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([...prev.members, [20, member(20, "everyone")], [21, member(21, "here")]]),
    }));
    expect(resolveMentionsFromContent("@everyone @here")).toEqual([]);
  });
});
