import { describe, it, expect } from "vitest";
import { parseInviteLink } from "@lib/deep-link";

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
});
