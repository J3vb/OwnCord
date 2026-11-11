import { describe, expect, it } from "vitest";
import { applySlashCommand } from "../../src/features/messaging/slashCommands";

const spoiler = (text: string): string | null => {
  const r = applySlashCommand(`/spoiler ${text}`);
  return r !== null && "text" in r ? r.text : null;
};
const me = (text: string): string | null => {
  const r = applySlashCommand(`/me ${text}`);
  return r !== null && "text" in r ? r.text : null;
};

describe("slash escaping keeps code spans, URLs and mentions as typed", () => {
  it("escapes backslash and pipe in /spoiler prose but not inside a code span", () => {
    expect(spoiler("a|b `c|d\\e` f\\g")).toBe("||a\\|b `c|d\\e` f\\\\g||");
  });

  it("matches a code span by its backtick run length", () => {
    expect(spoiler("x ``a`|b`` y|z")).toBe("||x ``a`|b`` y\\|z||");
  });

  it("treats an unclosed backtick run as prose and steps over all of it", () => {
    expect(spoiler("a ``b|c")).toBe("||a \\`\\`b\\|c||".replaceAll("\\`", "`"));
  });

  it("treats a code span that crosses a line as prose", () => {
    expect(spoiler("a `b|\nc` d")).toBe("||a `b\\|\nc` d||");
  });

  it("keeps a bare URL whole, even with a pipe or backslash in it", () => {
    expect(spoiler("see https://x.test/a|b\\c now|")).toBe("||see https://x.test/a|b\\c now\\|||");
    expect(spoiler("SEE HTTPS://X.TEST/a|b")).toBe("||SEE HTTPS://X.TEST/a|b||");
  });

  it("reads an h inside a word as prose, not a URL start", () => {
    expect(spoiler("ahttps://x.test|y")).toBe("||ahttps://x.test\\|y||");
  });

  it("escapes underscores in /me prose unless both neighbours are word characters", () => {
    expect(me("snake_case and _lead trail_")).toBe("_snake_case and \\_lead trail\\__");
  });

  it("keeps a mention with underscores whole in /me", () => {
    expect(me("hi @bob_smith ok_")).toBe("_hi @bob_smith ok\\___".replace("ok\\___", "ok\\__"));
  });

  it("does not read an @ after a word character or another @ as a mention", () => {
    expect(me("a@b_c @@d_e")).toBe("_a@b_c @@d_e_");
    expect(me("x@bob_ y")).toBe("_x@bob\\_ y_");
  });

  it("does not treat mentions as units in /spoiler", () => {
    expect(spoiler("@a|b")).toBe("||@a\\|b||");
  });
});
