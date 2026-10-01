import { describe, it, expect } from "vitest";
import {
  parseInviteLink,
  parseMessageLink,
  parseChannelLink,
  formatMessageLink,
  normaliseInviteCode,
} from "@lib/deep-link";

describe("normaliseInviteCode", () => {
  it("trims and lower-cases a typed code", () => {
    // Server codes are 16-char lower-case hex, and redemption is an exact,
    // case-sensitive match, so a pasted-capitals code would 400.
    expect(normaliseInviteCode("  ABCD1234  ")).toBe("abcd1234");
  });

  it("accepts a pasted owncord://invite/<code> link", () => {
    expect(normaliseInviteCode("owncord://invite/ABCD1234")).toBe("abcd1234");
  });

  it("accepts a bare owncord://<code> link", () => {
    expect(normaliseInviteCode("owncord://AbCd1234")).toBe("abcd1234");
  });

  it("ignores the link's host query and still lower-cases the code", () => {
    expect(normaliseInviteCode("owncord://invite/AbCd1234?host=chat.example.com")).toBe("abcd1234");
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    expect(normaliseInviteCode("")).toBe("");
    expect(normaliseInviteCode("   ")).toBe("");
  });

  it("passes a non-link through trimmed and lower-cased", () => {
    expect(normaliseInviteCode("  NOT-A-LINK ")).toBe("not-a-link");
  });
});

describe("parseInviteLink", () => {
  it("parses owncord://invite/<code>", () => {
    expect(parseInviteLink("owncord://invite/ABC123")).toEqual({ code: "ABC123" });
  });

  it("parses a bare owncord://<code>", () => {
    expect(parseInviteLink("owncord://XYZ")).toEqual({ code: "XYZ" });
  });

  it("extracts the host from the query string", () => {
    expect(parseInviteLink("owncord://invite/ABC?host=chat.example.com:8443")).toEqual({
      code: "ABC",
      host: "chat.example.com:8443",
    });
  });

  it("URL-decodes the code", () => {
    expect(parseInviteLink("owncord://invite/a%20b")).toEqual({ code: "a b" });
  });

  it("tolerates a trailing slash", () => {
    expect(parseInviteLink("owncord://invite/ABC/")).toEqual({ code: "ABC" });
  });

  it("rejects a non-owncord scheme", () => {
    expect(parseInviteLink("https://example.com/invite/ABC")).toBeNull();
  });

  it("rejects a link with no code", () => {
    expect(parseInviteLink("owncord://invite/")).toBeNull();
    expect(parseInviteLink("owncord://")).toBeNull();
  });

  it("rejects a message permalink — 'message' is a route, not an invite code", () => {
    // The bare-code form (owncord://<code>) would otherwise swallow the
    // message route and try to register an account with the code "message".
    expect(parseInviteLink("owncord://message/5/42")).toBeNull();
    expect(parseInviteLink("owncord://message")).toBeNull();
  });
});

// A call notification's Windows launch URI (src-tauri/src/message_notification.rs)
// names the DM, not a message. It is an external input like a message link, so
// it is validated the same way: positive safe-integer id, optional trimmed host.
describe("parseChannelLink", () => {
  it("parses a call notification's launch URI, host included", () => {
    expect(parseChannelLink("owncord://channel/5?host=chat.example%3A8443")).toEqual({
      channelId: 5,
      host: "chat.example:8443",
    });
    expect(parseChannelLink("owncord://channel/5/")).toEqual({ channelId: 5 });
  });

  it("reads back a host that was percent-encoded to stop it forging a parameter", () => {
    expect(parseChannelLink("owncord://channel/1?host=evil.example%26x%3D1%23y")).toEqual({
      channelId: 1,
      host: "evil.example&x=1#y",
    });
  });

  it("treats an empty or blank host as absent", () => {
    expect(parseChannelLink("owncord://channel/5?host=")).toEqual({ channelId: 5 });
    expect(parseChannelLink("owncord://channel/5?host=%20")).toEqual({ channelId: 5 });
  });

  it("rejects missing, non-numeric, zero, negative and unsafe ids", () => {
    for (const url of [
      "owncord://channel",
      "owncord://channel/abc",
      "owncord://channel/5.5",
      "owncord://channel/0",
      "owncord://channel/-5",
      "owncord://channel/99999999999999999999",
    ]) {
      expect(parseChannelLink(url), url).toBeNull();
    }
  });

  it("rejects another scheme and the other routes", () => {
    expect(parseChannelLink("https://example.com/channel/5")).toBeNull();
    expect(parseChannelLink("owncord://message/5/42")).toBeNull();
    expect(parseChannelLink("owncord://invite/5")).toBeNull();
  });

  it("is not an invite code, and not a message permalink", () => {
    expect(parseInviteLink("owncord://channel/5")).toBeNull();
    expect(parseInviteLink("owncord://channel")).toBeNull();
    expect(parseMessageLink("owncord://channel/5")).toBeNull();
  });
});

describe("parseMessageLink", () => {
  it("parses owncord://message/<channelId>/<messageId>", () => {
    expect(parseMessageLink("owncord://message/5/42")).toEqual({ channelId: 5, messageId: 42 });
  });

  it("tolerates a trailing slash", () => {
    expect(parseMessageLink("owncord://message/5/42/")).toEqual({ channelId: 5, messageId: 42 });
  });

  it("rejects a non-owncord scheme", () => {
    expect(parseMessageLink("https://example.com/message/5/42")).toBeNull();
  });

  it("rejects the invite route", () => {
    expect(parseMessageLink("owncord://invite/ABC")).toBeNull();
    expect(parseMessageLink("owncord://ABC")).toBeNull();
  });

  it("rejects missing or non-numeric ids", () => {
    expect(parseMessageLink("owncord://message/5")).toBeNull();
    expect(parseMessageLink("owncord://message")).toBeNull();
    expect(parseMessageLink("owncord://message/abc/42")).toBeNull();
    expect(parseMessageLink("owncord://message/5/abc")).toBeNull();
    expect(parseMessageLink("owncord://message/5.5/42")).toBeNull();
  });

  it("rejects zero and negative ids", () => {
    expect(parseMessageLink("owncord://message/0/42")).toBeNull();
    expect(parseMessageLink("owncord://message/5/0")).toBeNull();
    expect(parseMessageLink("owncord://message/-5/42")).toBeNull();
  });

  it("rejects ids beyond safe-integer precision", () => {
    // Past 2^53 the parsed number is not the number in the link, so a jump
    // would silently target a different message.
    expect(parseMessageLink("owncord://message/5/99999999999999999999")).toBeNull();
  });

  it("ignores extra path segments after the message id", () => {
    expect(parseMessageLink("owncord://message/5/42/extra")).toEqual({
      channelId: 5,
      messageId: 42,
    });
  });

  it("round-trips with formatMessageLink", () => {
    const url = formatMessageLink(7, 1234);
    expect(url).toBe("owncord://message/7/1234");
    expect(parseMessageLink(url)).toEqual({ channelId: 7, messageId: 1234 });
  });

  it("parses the optional host a notification's launch URI carries", () => {
    // The Windows toast sets its launch URI to this shape (see
    // src-tauri/src/message_notification.rs) so a click from Action Center
    // still names the server it came from.
    expect(parseMessageLink("owncord://message/5/42?host=chat.example:8443")).toEqual({
      channelId: 5,
      messageId: 42,
      host: "chat.example:8443",
    });
  });

  it("URL-decodes and trims the launch URI's host", () => {
    expect(parseMessageLink("owncord://message/5/42?host=%20a.example%20")).toEqual({
      channelId: 5,
      messageId: 42,
      host: "a.example",
    });
  });

  it("treats an empty host as absent", () => {
    expect(parseMessageLink("owncord://message/5/42?host=")).toEqual({
      channelId: 5,
      messageId: 42,
    });
  });
});
