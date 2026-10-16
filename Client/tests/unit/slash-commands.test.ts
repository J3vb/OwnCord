// 3A-10a: the pure slash-command parser.
import { describe, it, expect } from "vitest";
import {
  applySlashCommand,
  filterSlashCommands,
  SLASH_COMMANDS,
} from "../../src/features/messaging/slashCommands";
import { renderMessageContent } from "../../src/components/message-list/content-parser";
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
      expect(applySlashCommand(input)).toEqual({ empty: true });
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

  it("tolerates leading spaces and trims the text", () => {
    expect(applySlashCommand("   /me  waves  ")).toEqual({ text: "_waves_" });
    expect(applySlashCommand(" /shrug")).toEqual({ text: SHRUG });
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
    expect(shown("/unflip")).toBe("┬─┬ノ( º _ ºノ)");
    expect(shown("/tableflip")).toBe("(╯°□°)╯︵ ┻━┻");
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
