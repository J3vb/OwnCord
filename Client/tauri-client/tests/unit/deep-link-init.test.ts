/**
 * Tests for initDeepLinks in src/lib/deep-link.ts.
 *
 * deep-link.ts sat at 44% statements: the existing deep-link.test.ts covers the
 * pure parser, but initDeepLinks — the part that actually runs at startup and
 * decides whether an owncord:// invite reaches the register form — had no
 * coverage at all. Its failure modes are all silent by design (every step is
 * wrapped in try/catch so a missing plugin cannot break boot), which is exactly
 * why the branches need pinning: a regression here does not throw, it just
 * quietly stops honouring invite links.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const register = vi.fn();
const getCurrent = vi.fn();
const onOpenUrl = vi.fn();

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  register: (...args: unknown[]) => register(...args) as unknown,
  getCurrent: (...args: unknown[]) => getCurrent(...args) as unknown,
  onOpenUrl: (...args: unknown[]) => onOpenUrl(...args) as unknown,
}));

const { initDeepLinks, parseInviteLink } = await import("@lib/deep-link");

beforeEach(() => {
  register.mockReset().mockResolvedValue(undefined);
  getCurrent.mockReset().mockResolvedValue(null);
  onOpenUrl.mockReset().mockResolvedValue(undefined);
});

describe("initDeepLinks", () => {
  it("registers the owncord scheme", async () => {
    await initDeepLinks(vi.fn());

    expect(register).toHaveBeenCalledWith("owncord");
  });

  it("continues when scheme registration is rejected", async () => {
    // Registration fails when the scheme is already claimed, or on platforms
    // that do not permit runtime registration. Neither must stop the listener
    // from being wired.
    register.mockRejectedValue(new Error("already registered"));

    await initDeepLinks(vi.fn());

    expect(onOpenUrl).toHaveBeenCalled();
  });

  it("dispatches a cold-start invite from getCurrent", async () => {
    getCurrent.mockResolvedValue(["owncord://invite/COLD1"]);
    const onInvite = vi.fn();

    await initDeepLinks(onInvite);

    expect(onInvite).toHaveBeenCalledWith("COLD1", undefined);
  });

  it("passes the host through when the link carries one", async () => {
    getCurrent.mockResolvedValue(["owncord://invite/COLD2?host=chat.example.com:8443"]);
    const onInvite = vi.fn();

    await initDeepLinks(onInvite);

    expect(onInvite).toHaveBeenCalledWith("COLD2", "chat.example.com:8443");
  });

  it("tolerates a null cold-start result", async () => {
    getCurrent.mockResolvedValue(null);
    const onInvite = vi.fn();

    await initDeepLinks(onInvite);

    expect(onInvite).not.toHaveBeenCalled();
    expect(onOpenUrl).toHaveBeenCalled();
  });

  it("dispatches every link in a batch", async () => {
    getCurrent.mockResolvedValue(["owncord://invite/A", "owncord://invite/B"]);
    const onInvite = vi.fn();

    await initDeepLinks(onInvite);

    expect(onInvite).toHaveBeenCalledTimes(2);
    expect(onInvite).toHaveBeenNthCalledWith(1, "A", undefined);
    expect(onInvite).toHaveBeenNthCalledWith(2, "B", undefined);
  });

  it("ignores unrecognized links but still handles valid ones in the batch", async () => {
    getCurrent.mockResolvedValue([
      "https://example.com/invite/NOPE",
      "owncord://",
      "owncord://invite/GOOD",
    ]);
    const onInvite = vi.fn();

    await initDeepLinks(onInvite);

    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onInvite).toHaveBeenCalledWith("GOOD", undefined);
  });

  it("dispatches warm-launch invites through the onOpenUrl callback", async () => {
    const onInvite = vi.fn();
    await initDeepLinks(onInvite);

    // The plugin hands the app a batch of URLs while it is already running.
    const handler = onOpenUrl.mock.calls[0]?.[0] as (urls: readonly string[]) => void;
    expect(handler).toBeTypeOf("function");
    handler(["owncord://invite/WARM?host=h.example"]);

    expect(onInvite).toHaveBeenCalledWith("WARM", "h.example");
  });

  it("routes a message permalink to onMessage, not onInvite", async () => {
    getCurrent.mockResolvedValue(["owncord://message/5/42"]);
    const onInvite = vi.fn();
    const onMessage = vi.fn();

    await initDeepLinks(onInvite, onMessage);

    expect(onMessage).toHaveBeenCalledWith(5, 42);
    expect(onInvite).not.toHaveBeenCalled();
  });

  it("dispatches a warm-launch message permalink", async () => {
    const onMessage = vi.fn();
    await initDeepLinks(vi.fn(), onMessage);

    const handler = onOpenUrl.mock.calls[0]?.[0] as (urls: readonly string[]) => void;
    handler(["owncord://message/9/7"]);

    expect(onMessage).toHaveBeenCalledWith(9, 7);
  });

  it("ignores a message permalink when no onMessage handler was supplied", async () => {
    // The old two-argument-free call site must not start feeding permalinks
    // into the invite flow, and must not throw.
    getCurrent.mockResolvedValue(["owncord://message/5/42"]);
    const onInvite = vi.fn();

    await expect(initDeepLinks(onInvite)).resolves.toBeUndefined();

    expect(onInvite).not.toHaveBeenCalled();
  });

  it("mixes invites and permalinks in one batch", async () => {
    getCurrent.mockResolvedValue([
      "owncord://message/1/2",
      "owncord://invite/CODE",
      "owncord://message/3/4",
    ]);
    const onInvite = vi.fn();
    const onMessage = vi.fn();

    await initDeepLinks(onInvite, onMessage);

    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onInvite).toHaveBeenCalledWith("CODE", undefined);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(1, 1, 2);
    expect(onMessage).toHaveBeenNthCalledWith(2, 3, 4);
  });

  it("swallows a getCurrent rejection without wiring a listener", async () => {
    getCurrent.mockRejectedValue(new Error("ipc down"));
    const onInvite = vi.fn();

    await expect(initDeepLinks(onInvite)).resolves.toBeUndefined();

    expect(onInvite).not.toHaveBeenCalled();
    expect(onOpenUrl).not.toHaveBeenCalled();
  });

  it("swallows an onOpenUrl rejection", async () => {
    onOpenUrl.mockRejectedValue(new Error("no listener slot"));

    await expect(initDeepLinks(vi.fn())).resolves.toBeUndefined();
  });
});

describe("parseInviteLink malformed percent-encoding", () => {
  it("falls back to the raw segment when decoding throws", () => {
    // A lone "%" is not valid percent-encoding; decodeURIComponent throws a
    // URIError and the raw segment is used instead of losing the invite.
    expect(parseInviteLink("owncord://invite/100%")).toEqual({ code: "100%" });
  });

  it("drops a code that decodes to whitespace only", () => {
    expect(parseInviteLink("owncord://invite/%20%20")).toBeNull();
  });

  it("ignores an empty host parameter", () => {
    expect(parseInviteLink("owncord://invite/ABC?host=")).toEqual({ code: "ABC" });
  });

  it("trims a padded host parameter", () => {
    expect(parseInviteLink("owncord://invite/ABC?host=%20h.example%20")).toEqual({
      code: "ABC",
      host: "h.example",
    });
  });

  it("ignores unrelated query parameters", () => {
    expect(parseInviteLink("owncord://invite/ABC?ref=twitter")).toEqual({ code: "ABC" });
  });

  it("tolerates multiple trailing slashes", () => {
    expect(parseInviteLink("owncord://invite/ABC///")).toEqual({ code: "ABC" });
  });

  it("ignores extra path segments after the code", () => {
    expect(parseInviteLink("owncord://invite/ABC/extra")).toEqual({ code: "ABC" });
  });
});
