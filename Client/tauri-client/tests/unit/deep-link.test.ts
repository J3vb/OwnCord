import { describe, it, expect } from "vitest";
import { parseInviteLink, parseMessageLink, formatMessageLink } from "@lib/deep-link";

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
});
