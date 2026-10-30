// 3A-10a: the pure slash-command parser.
import { describe, it, expect } from "vitest";
import {
  applySlashCommand,
  filterSlashCommands,
  SLASH_COMMANDS,
} from "../../src/features/messaging/slashCommands";
import { renderMessageContent } from "../../src/components/message-list/contentParser";
import { messagingText } from "../../src/i18n/messaging";

const SHRUG = "¯\\\\\\_(ツ)\\_/¯";
const TABLEFLIP = "(╯°□°)╯︵ ┻━┻";
const UNFLIP = "┬─┬ノ( º \\_ ºノ)";

describe("applySlashCommand", () => {
  it.each([
    ["/shrug", SHRUG],
    ["/shrug hi", `hi ${SHRUG}`],
    ["/tableflip", TABLEFLIP],
    ["/tableflip ugh", `ugh ${TABLEFLIP}`],
    ["/unflip", UNFLIP],
    ["/unflip ok", `ok ${UNFLIP}`],
    ["/spoiler secret", "||secret||"],
    ["/me waves", "_waves_"],
  ])("%s", (input, text) => {
    expect(applySlashCommand(input)).toEqual({ text });
  });

  it("sends nothing for a bare /spoiler or /me", () => {
    for (const input of ["/spoiler", "/spoiler   ", "/me", "/ME"]) {
      expect(applySlashCommand(input)).toMatchObject({
        empty: true,
        name: input.trim().slice(1).toLowerCase(),
      });
    }
  });

  it("matches names case-insensitively", () => {
    expect(applySlashCommand("/SHRUG x")).toEqual({ text: `x ${SHRUG}` });
    expect(applySlashCommand("/TableFlip")).toEqual({ text: TABLEFLIP });
    expect(applySlashCommand("/Spoiler Hi")).toEqual({ text: "||Hi||" });
  });

  it("returns null for unknown commands and near misses", () => {
    for (const input of ["/foo", "/foo bar", "/shrugs", "/shrug!", "/", "/ shrug", "//shrug"]) {
      expect(applySlashCommand(input)).toBeNull();
    }
  });

  it("returns null when the message does not start with a slash", () => {
    for (const input of ["", "hello", "hi /shrug", "shrug", "\\/shrug"]) {
      expect(applySlashCommand(input)).toBeNull();
    }
  });

  it("needs the command at position 0 and trims the text after it", () => {
    expect(applySlashCommand("/me  waves  ")).toEqual({ text: "_waves_" });
    for (const input of [" /shrug", "   /me waves", "\n/spoiler x"]) {
      expect(applySlashCommand(input)).toBeNull();
    }
  });

  it("keeps multiline text after /spoiler", () => {
    expect(applySlashCommand("/spoiler line one\nline two")).toEqual({
      text: "||line one\nline two||",
    });
    expect(applySlashCommand("/spoiler\nbody")).toEqual({ text: "||body||" });
  });

  it("renders the emoticons literally through the message renderer", () => {
    const shown = (cmd: string): string => {
      const out = applySlashCommand(cmd) as { text: string };
      const host = document.createElement("div");
      host.appendChild(renderMessageContent(out.text));
      expect(host.querySelector("em")).toBeNull();
      return host.textContent ?? "";
    };
    expect(shown("/shrug hi")).toBe("hi ¯\\_(ツ)_/¯");
    expect(shown("/unflip _x")).toBe("_x ┬─┬ノ( º _ ºノ)");
    expect(shown("/tableflip")).toBe("(╯°□°)╯︵ ┻━┻");
  });
});

function render(cmd: string): HTMLDivElement {
  const out = applySlashCommand(cmd) as { text: string };
  const host = document.createElement("div");
  host.appendChild(renderMessageContent(out.text));
  return host;
}

describe("/spoiler hides everything it was given", () => {
  const hidden = (cmd: string, expected: string): void => {
    const host = render(cmd);
    const spoilers = host.querySelectorAll(".msg-spoiler");
    expect(spoilers).toHaveLength(1);
    // Nothing renders outside the spoiler element, and no marker shows raw.
    expect(host.textContent).toBe(spoilers[0]!.textContent);
    expect(host.textContent).toBe(expected);
  };

  it("keeps a pipe pair inside the spoiler", () => {
    hidden("/spoiler a||b", "a||b");
    hidden("/spoiler a|b|c", "a|b|c");
  });

  it("keeps a typed backslash-pipe from closing the spoiler", () => {
    hidden("/spoiler a\\|b", "a\\|b");
  });

  it("leaves a pipe inside a URL or a single or double code span alone", () => {
    expect(applySlashCommand("/spoiler https://x.com/?a|b")).toEqual({
      text: "||https://x.com/?a|b||",
    });
    expect(applySlashCommand("/spoiler ``a|b`` and `c|d` e|f")).toEqual({
      text: "||``a|b`` and `c|d` e\\|f||",
    });
    const host = render("/spoiler ``a|b`` x");
    expect(host.querySelectorAll(".msg-spoiler")).toHaveLength(1);
    expect(host.textContent).toBe(host.querySelector(".msg-spoiler")!.textContent);
  });

  it("keeps a trailing backslash from escaping the closer", () => {
    hidden("/spoiler end\\", "end\\");
  });

  it("keeps multiline text with block openers in one spoiler", () => {
    hidden(
      "/spoiler one\n- two\n> three\n# four\n1. five\n2) six",
      "one\n- two\n> three\n# four\n1. five\n2) six",
    );
    hidden("/spoiler one\n\ntwo", "one\n\ntwo");
  });

  it("keeps a code fence inside the spoiler", () => {
    const host = render("/spoiler look\n```\nsecret\n```");
    expect(host.querySelector("pre")).toBeNull();
    expect(host.querySelectorAll(".msg-spoiler")).toHaveLength(1);
    expect(host.textContent).toBe(host.querySelector(".msg-spoiler")!.textContent);
  });
});

describe("/me renders as one italic run", () => {
  it.each(["does _this_", "x_", "_x", "__init__ ran", "snake_case here", "a_b_c"])("%s", (text) => {
    const host = render(`/me ${text}`);
    const ems = host.querySelectorAll("em");
    expect(ems).toHaveLength(1);
    expect(ems[0]!.textContent).toBe(text);
    expect(host.textContent).toBe(text);
  });
});

describe("/me leaves code spans, URLs and mentions as typed", () => {
  it("shows a code span's underscores without backslashes", () => {
    const host = render("/me runs `__init__` now");
    expect(host.querySelectorAll("em")).toHaveLength(1);
    expect(host.querySelector("em code")!.textContent).toBe("__init__");
    expect(host.textContent).toBe("runs __init__ now");
  });

  it("keeps a URL with an underscore intact", () => {
    const host = render("/me see https://x.com/_priv ok");
    expect(host.querySelectorAll("em")).toHaveLength(1);
    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://x.com/_priv");
    expect(link.textContent).toBe("https://x.com/_priv");
  });

  it("does not touch the @mention token the server matches", () => {
    expect(applySlashCommand("/me pings @_bob here")).toEqual({ text: "_pings @_bob here_" });
    expect(applySlashCommand("/me pings @bob_ here")).toEqual({ text: "_pings @bob_ here_" });
    expect(applySlashCommand("/me a_b @x.y-z_1")).toEqual({ text: "_a_b @x.y-z_1_" });
  });

  it("keeps italics after a trailing backslash", () => {
    const host = render("/me a\\");
    expect(host.querySelectorAll("em")).toHaveLength(1);
    expect(host.textContent).toBe("a\\");
  });

  it("keeps italics across a line that starts with a block marker", () => {
    for (const marker of ["- ", "> ", "# ", "1. "]) {
      const host = render(`/me a\n${marker}b`);
      expect(host.querySelectorAll("em")).toHaveLength(1);
      expect(host.textContent).toBe(`a\n${marker}b`);
    }
  });

  it("shows a typed backslash-underscore literally inside the italics", () => {
    const host = render("/me a\\_b");
    expect(host.querySelectorAll("em")).toHaveLength(1);
    expect(host.textContent).toBe("a\\_b");
  });
});

describe("slash command list", () => {
  it("names five commands, each with a catalog description", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual([
      "shrug",
      "tableflip",
      "unflip",
      "spoiler",
      "me",
    ]);
    for (const c of SLASH_COMMANDS) {
      expect(messagingText(c.descriptionKey).length).toBeGreaterThan(0);
    }
    expect(messagingText("slash.spoiler")).toBe("Marks your message as a spoiler");
  });

  it("filters by case-insensitive prefix", () => {
    expect(filterSlashCommands("").map((c) => c.name)).toHaveLength(5);
    expect(filterSlashCommands("s").map((c) => c.name)).toEqual(["shrug", "spoiler"]);
    expect(filterSlashCommands("TA").map((c) => c.name)).toEqual(["tableflip"]);
    expect(filterSlashCommands("x")).toEqual([]);
  });
});
