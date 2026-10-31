/**
 * WP 3A-2 chat parity: `#channel` autocomplete, typed `:joy:` shortcodes,
 * `<url>` with no embed, `<t:…>` timestamps and `-#` subtext.
 */

import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () => voiceSession.defaults());

import {
  filterChannelSuggestions,
  MAX_CHANNEL_SUGGESTIONS,
} from "../../src/components/ChannelAutocomplete";
import { useMountedComposer } from "../helpers/composerFixture";
import type { MessageInputOptions } from "../../src/components/MessageInput";
import {
  relabelInlineTimestamps,
  renderMessageContent,
} from "../../src/features/messaging/content/contentParser";
import { extractUrls } from "../../src/features/messaging/content/media";
import { markdownToPlainText, parseBlocks, parseInline } from "../../src/lib/text/markdown";
import { formatDiscordTimestamp } from "../../src/features/messaging/discordTimestamp";
import { refreshTimeFormat, saveTimeFormat } from "../../src/lib/text/timeFormat";
import { replaceEmojiShortcodes } from "../../src/features/messaging/shortcodes";
import { loadEmojiCatalog } from "../../src/features/messaging/emojiCatalog";
import { clearCustomEmoji, emojiStore, setCustomEmoji } from "../../src/stores/emoji.store";
import { setChannels } from "../../src/stores/channels.store";
import type { ReadyChannel } from "../../src/lib/types";
import { resetMembersState } from "../helpers/storeResets";
import { resetChannelsState } from "../helpers/storeSeeds";

const CHANNELS: ReadyChannel[] = [
  { id: 1, name: "general", type: "text", category: "Text", position: 0 },
  { id: 2, name: "game-night", type: "text", category: "Text", position: 1 },
  { id: 3, name: "Lounge", type: "voice", category: null, position: 2 },
  { id: 4, name: "has space", type: "text", category: null, position: 3 },
  { id: 5, name: "dm", type: "dm", category: null, position: 4 },
  { id: 6, name: "angels", type: "announcement", category: "News", position: 5 },
];

beforeAll(async () => {
  await loadEmojiCatalog();
});

beforeEach(() => {
  localStorage.clear();
  resetChannelsState();
  setChannels(CHANNELS);
  resetMembersState();
  clearCustomEmoji();
  setCustomEmoji([]);
  emojiStore.flush();
});

describe("filterChannelSuggestions", () => {
  it("lists server channels in sidebar order, never DMs or names # cannot link", () => {
    expect(filterChannelSuggestions("").map((s) => s.name)).toEqual([
      "general",
      "game-night",
      "Lounge",
      "angels",
    ]);
  });

  it("ranks prefix matches above substring matches, case-insensitively", () => {
    expect(filterChannelSuggestions("GA").map((s) => s.name)).toEqual(["game-night"]);
    expect(filterChannelSuggestions("l").map((s) => s.name)).toEqual([
      "Lounge",
      "general",
      "angels",
    ]);
  });

  it("offers a shared name once, as the channel its link opens", () => {
    setChannels([
      { id: 1, name: "general", type: "text", category: "Text", position: 0 },
      { id: 2, name: "General", type: "voice", category: "Voice", position: 1 },
    ]);
    expect(filterChannelSuggestions("gen").map((s) => s.id)).toEqual([1]);
  });

  it("orders channels that share a position by id, as the sidebar does", () => {
    setChannels([
      { id: 9, name: "chat-a", type: "text", category: null, position: 0 },
      { id: 7, name: "chat-b", type: "text", category: null, position: 0 },
    ]);
    expect(filterChannelSuggestions("chat").map((s) => s.name)).toEqual(["chat-b", "chat-a"]);
  });

  it("shows the category, or Voice channel for an uncategorised voice channel", () => {
    const byName = new Map(filterChannelSuggestions("").map((s) => [s.name, s.detail]));
    expect(byName.get("general")).toBe("Text");
    expect(byName.get("Lounge")).toBe("Voice channel");
  });

  it("caps the list", () => {
    setChannels(
      Array.from({ length: 15 }, (_, i) => ({
        id: 100 + i,
        name: `c${i}`,
        type: "text" as const,
        category: null,
        position: i,
      })),
    );
    expect(filterChannelSuggestions("c")).toHaveLength(MAX_CHANNEL_SUGGESTIONS);
  });
});

describe("composer: #channel autocomplete", () => {
  let container: HTMLDivElement;
  let onSend: Mock<MessageInputOptions["onSend"]>;

  useMountedComposer((mounted, _composer, send) => {
    container = mounted;
    onSend = send;
  });

  function textarea(): HTMLTextAreaElement {
    return container.querySelector("textarea")!;
  }

  function type(value: string): void {
    const ta = textarea();
    ta.value = value;
    ta.selectionStart = value.length;
    ta.selectionEnd = value.length;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function popup(): HTMLElement | null {
    return container.querySelector(".channel-autocomplete");
  }

  function press(k: string): void {
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  }

  it("opens on # after a space and inserts the picked channel", () => {
    type("see #gam");
    expect(popup()).not.toBeNull();
    press("Enter");
    expect(textarea().value).toBe("see #game-night ");
    expect(onSend).not.toHaveBeenCalled();
    expect(popup()).toBeNull();
  });

  it("opens on a bare # at the start", () => {
    type("#");
    expect(popup()?.querySelectorAll(".ma-name")).toHaveLength(4);
  });

  it("stays closed for a # inside a word and for a heading", () => {
    type("C#");
    expect(popup()).toBeNull();
    type("# Title");
    expect(popup()).toBeNull();
  });

  it("closes on Escape and lets Enter send", () => {
    type("#gen");
    press("Escape");
    expect(popup()).toBeNull();
    press("Enter");
    expect(onSend).toHaveBeenCalledWith("#gen", null, [], [], false);
  });

  it("turns a typed :joy: into the emoji when sending", () => {
    type("hi :joy:");
    press("Enter");
    expect(onSend).toHaveBeenCalledWith("hi 😂", null, [], [], false);
  });
});

describe("replaceEmojiShortcodes", () => {
  it("swaps a known name, and a name without its underscores", () => {
    expect(replaceEmojiShortcodes("hi :joy: and :thumbsup:")).toBe("hi 😂 and 👍");
  });

  it("leaves unknown names, code, and escaped shortcodes as typed", () => {
    expect(replaceEmojiShortcodes(":notanemoji:")).toBe(":notanemoji:");
    expect(replaceEmojiShortcodes("`:joy:` and\n```\n:joy:\n```")).toBe(
      "`:joy:` and\n```\n:joy:\n```",
    );
    expect(replaceEmojiShortcodes("\\:joy:")).toBe("\\:joy:");
    expect(replaceEmojiShortcodes("\\\\:joy:")).toBe("\\\\😂");
  });

  it("swaps shortcodes that touch each other or punctuation", () => {
    expect(replaceEmojiShortcodes(":joy::joy:!")).toBe("😂😂!");
    expect(replaceEmojiShortcodes("(:joy:)")).toBe("(😂)");
    expect(replaceEmojiShortcodes(":notanemoji::joy:")).toBe(":notanemoji:😂");
  });

  it("leaves a masked link whole when its target holds parentheses", () => {
    const text = "[docs](https://ex.com/a_(b):joy:) :joy:";
    expect(replaceEmojiShortcodes(text)).toBe("[docs](https://ex.com/a_(b):joy:) 😂");
    const escaped = "[docs](https://ex.com/a\\):joy:)";
    expect(replaceEmojiShortcodes(escaped)).toBe(escaped);
    expect(replaceEmojiShortcodes("[a :joy:](https://ex.com/a b)")).toBe(
      "[a 😂](https://ex.com/a b)",
    );
    expect(replaceEmojiShortcodes("\\[a :joy:](https://ex.com)")).toBe("\\[a 😂](https://ex.com)");
  });

  it("leaves colon pairs inside words, numbers, addresses and links alone", () => {
    for (const text of [
      "https://ex.com/a:joy:b",
      "<https://ex.com/w:cool:x>",
      "<HTTPS://ex.com/:joy:>",
      "\\https://ex.com/:joy:",
      "[docs](https://ex.com/a:joy:b)",
      "MAC 00:1A:2B:AB:CD:EF",
      "fe80::ab:cd",
      "status:OK:done",
      "ratio 1:100:1",
      "score 3:+1:2",
      "a:joy:b",
      "10:30:45",
      ":JOY:",
      "`a\n:joy:`",
      "``a`:joy:``",
      "\\```\na``:joy:\n```",
    ]) {
      expect(replaceEmojiShortcodes(text)).toBe(text);
    }
  });

  it("sends shortcodes as typed until the server's custom set is known", () => {
    clearCustomEmoji();
    expect(replaceEmojiShortcodes(":joy:")).toBe(":joy:");
  });

  it("keeps a server's custom emoji as its shortcode", () => {
    setCustomEmoji([{ id: 1, shortcode: "joy", url: "/api/v1/emoji/1/image" }]);
    emojiStore.flush();
    expect(replaceEmojiShortcodes(":joy:")).toBe(":joy:");
    expect(replaceEmojiShortcodes(":joy::thumbsup:")).toBe(":joy:👍");
  });
});

describe("<url> posts a link with no embed", () => {
  it("renders the link without its brackets", () => {
    const el = renderMessageContent("see <https://example.com/a_b>");
    const link = el.querySelector("a.msg-link");
    expect(link?.getAttribute("href")).toBe("https://example.com/a_b");
    expect(el.textContent).toBe("see https://example.com/a_b");
  });

  it("is left out of the embeds, while a bare link is not", () => {
    expect(extractUrls("<https://a.example/x>")).toEqual([]);
    expect(extractUrls("<https://a.example/x> https://b.example/y")).toEqual([
      "https://b.example/y",
    ]);
  });
  it("keeps the embed when the opening bracket is escaped", () => {
    expect(extractUrls("\\<https://a.example/x>")).toEqual(["https://a.example/x"]);
    expect(extractUrls("\\\\<https://a.example/x>")).toEqual([]);
  });

  it("stays whole inside emphasis that uses a character from the address", () => {
    const el = renderMessageContent("**<https://example.com/a**>**");
    expect(el.querySelector("strong a")?.getAttribute("href")).toBe("https://example.com/a**");
  });

  it("holds an address as long as a message allows", () => {
    const url = `https://a.example/${"x".repeat(3000)}`;
    expect(parseInline(`<${url}>`)).toEqual([{ type: "url", url, raw: `<${url}>` }]);
  });

  it("needs an address with no spaces between the brackets", () => {
    expect(parseInline("<https://a b>")).toEqual([{ type: "text", value: "<https://a b>" }]);
  });
});

describe("<t:…> timestamps", () => {
  it("parses the unix time and style, defaulting to f", () => {
    expect(parseInline("at <t:1700000000:R> or <t:1700000000>")).toEqual([
      { type: "text", value: "at " },
      { type: "timestamp", unix: 1700000000, style: "R" },
      { type: "text", value: " or " },
      { type: "timestamp", unix: 1700000000, style: "f" },
    ]);
  });

  it("leaves an unknown style or an impossible date as text", () => {
    expect(parseInline("<t:1700000000:X>")[0]).toEqual({
      type: "text",
      value: "<t:1700000000:X>",
    });
    expect(parseInline("<t:9999999999999>")[0]?.type).toBe("text");
  });

  it("renders a time element with the full date as its tooltip", () => {
    const el = renderMessageContent("<t:1700000000:D>");
    const time = el.querySelector("time.md-timestamp");
    expect(time?.getAttribute("datetime")).toBe("2023-11-14T22:13:20.000Z");
    expect(time?.textContent).toMatch(/November 1[45], 2023/);
    expect(time?.getAttribute("title")).toMatch(/day, November 1[45], 2023/);
  });

  it("writes the relative style in words", () => {
    const now = (1000 + 3 * 86400) * 1000;
    expect(formatDiscordTimestamp(1000, "R", now).text).toBe("3 days ago");
    expect(formatDiscordTimestamp(1000 + 3 * 86400 + 7200, "R", now).text).toBe("in 2 hours");
    expect(formatDiscordTimestamp(1000 + 3 * 86400 - 7140, "R", now).text).toBe("2 hours ago");
    expect(formatDiscordTimestamp(1000 + 3 * 86400, "R", now).text).toBe("now");
  });

  it("follows a 12h/24h switch when relabelled", () => {
    saveTimeFormat("12h");
    const el = renderMessageContent("<t:1700000000:t>");
    const time = el.querySelector("time.md-timestamp")!;
    expect(time.textContent).toMatch(/AM|PM/i);
    saveTimeFormat("24h");
    relabelInlineTimestamps(el);
    expect(time.textContent).not.toMatch(/AM|PM/i);
    expect(time.getAttribute("datetime")).toBe("2023-11-14T22:13:20.000Z");
    localStorage.clear();
    refreshTimeFormat();
  });

  it("stays text after a backslash", () => {
    const el = renderMessageContent("\\<t:1700000000>");
    expect(el.querySelector("time")).toBeNull();
    expect(el.textContent).toBe("<t:1700000000>");
  });

  it("stays text inside code", () => {
    expect(renderMessageContent("`<t:1700000000>`").querySelector("time")).toBeNull();
  });
});

describe("-# subtext", () => {
  it("renders a line in small text", () => {
    const el = renderMessageContent("big\n-# small **bold**");
    expect(el.querySelector(".md-subtext")?.textContent).toBe("small bold");
    expect(el.querySelector(".md-subtext strong")?.textContent).toBe("bold");
  });

  it("needs a space and the start of a line", () => {
    expect(parseBlocks("-#nospace")).toEqual([{ type: "paragraph", text: "-#nospace" }]);
    expect(parseBlocks("a -# b")).toEqual([{ type: "paragraph", text: "a -# b" }]);
  });

  it("keeps its words in the plain-text form", () => {
    expect(markdownToPlainText("-# fine print", "Spoiler")).toBe("fine print");
  });
});
