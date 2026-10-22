// Browser binding for the CredentialStore suite (6.13c): the browser
// platform's token store over Web Storage. "The native store" is the two
// storage areas: they hold a credential, throw, or are missing. The browser
// keeps the token only, so the suite runs with `savedPasswords: false`; the
// full suite runs against the desktop store in `credentials.desktop.test.ts`.
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../../../src/platform/contracts/credentials";
import { credentials } from "../../../src/platform/browser/credentials";
import { FakeWebStorage } from "../../helpers/fakeWebStorage";
import { describeCredentialStoreSuite } from "./credentials.suite";

const browserBinding: CredentialStore = credentials;
const KEY = "owncord:credential:host";
let local = new FakeWebStorage();
let session = new FakeWebStorage();

function install(): void {
  local = new FakeWebStorage();
  session = new FakeWebStorage();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describeCredentialStoreSuite(
  async () => {
    install();
    return {
      subject: browserBinding,
      native: {
        succeedWith(value: unknown) {
          if (value !== null && value !== undefined) local.setItem(KEY, JSON.stringify(value));
        },
        failWith(error: unknown) {
          local.failure = error;
          session.failure = error;
        },
        unavailable() {
          vi.stubGlobal("localStorage", undefined);
          vi.stubGlobal("sessionStorage", undefined);
        },
      },
    };
  },
  { savedPasswords: false },
);

describe("browser credentials", () => {
  it("keeps a token in localStorage, and reads it back", async () => {
    install();
    await expect(browserBinding.save("chat.example", "alice", "tok")).resolves.toBe(true);
    expect(local.keys()).toEqual(["owncord:credential:chat.example"]);
    expect(session.keys()).toEqual([]);
    await expect(browserBinding.load("chat.example")).resolves.toEqual({
      username: "alice",
      token: "tok",
      hasPassword: false,
    });
  });

  it("session-only token not in localStorage", async () => {
    install();
    await expect(
      browserBinding.save("chat.example", "alice", "tok", undefined, false, true),
    ).resolves.toBe(true);
    expect(local.keys()).toEqual([]);
    expect(local.values().join()).not.toContain("tok");
    expect(session.keys()).toEqual(["owncord:credential:chat.example"]);
    await expect(browserBinding.load("chat.example")).resolves.toMatchObject({ token: "tok" });
  });

  it("moves a kept token to session-only, leaving no copy behind", async () => {
    install();
    await browserBinding.save("chat.example", "alice", "kept");
    await browserBinding.save("chat.example", "alice", "tab", undefined, false, true);
    expect(local.keys()).toEqual([]);
    await expect(browserBinding.load("chat.example")).resolves.toMatchObject({ token: "tab" });
  });

  it("moves a session-only token to kept when asked, leaving no copy behind", async () => {
    install();
    await browserBinding.save("chat.example", "alice", "tab", undefined, false, true);
    await browserBinding.save("chat.example", "alice", "kept", undefined, false, false);
    expect(session.keys()).toEqual([]);
    await expect(browserBinding.load("chat.example")).resolves.toMatchObject({ token: "kept" });
  });

  it("keeps a session-only token in sessionStorage on a save that does not say", async () => {
    install();
    await browserBinding.save("chat.example", "alice", "tab", undefined, false, true);
    await browserBinding.save("chat.example", "alice2", "tab2");
    expect(local.keys()).toEqual([]);
    expect(session.keys()).toEqual(["owncord:credential:chat.example"]);
    await expect(browserBinding.load("chat.example")).resolves.toMatchObject({
      username: "alice2",
      token: "tab2",
    });
  });

  it("keeps a kept token in localStorage on a save that does not say", async () => {
    install();
    await browserBinding.save("chat.example", "alice", "kept");
    await browserBinding.save("chat.example", "alice2", "kept2");
    expect(local.keys()).toEqual(["owncord:credential:chat.example"]);
    expect(session.keys()).toEqual([]);
  });

  it("reads a good kept copy past a malformed session-only record", async () => {
    install();
    session.setItem("owncord:credential:chat.example", "{not json");
    local.setItem("owncord:credential:chat.example", '{"username":"alice","token":"tok"}');
    await expect(browserBinding.load("chat.example")).resolves.toEqual({
      username: "alice",
      token: "tok",
      hasPassword: false,
    });
  });

  it("never stores a password it is handed", async () => {
    install();
    await browserBinding.save("chat.example", "alice", "tok", "hunter2-password");
    await browserBinding.save("other.example", "bob", "tok2", "hunter3-password", false, true);
    const everything = [...local.values(), ...session.values()].join("\n");
    expect(everything).toContain("tok");
    expect(everything).not.toContain("hunter2-password");
    expect(everything).not.toContain("hunter3-password");
    await expect(browserBinding.load("chat.example")).resolves.toMatchObject({
      hasPassword: false,
    });
  });

  it("delete removes both copies", async () => {
    install();
    local.setItem("owncord:credential:chat.example", '{"username":"a","token":"x"}');
    session.setItem("owncord:credential:chat.example", '{"username":"a","token":"y"}');
    await expect(browserBinding.delete("chat.example")).resolves.toBe(true);
    expect(local.keys()).toEqual([]);
    expect(session.keys()).toEqual([]);
    await expect(browserBinding.load("chat.example")).resolves.toBeNull();
  });

  it("delete with a token removes only the copies that hold it", async () => {
    install();
    local.setItem("owncord:credential:chat.example", '{"username":"a","token":"other-tab"}');
    session.setItem("owncord:credential:chat.example", '{"username":"a","token":"mine"}');
    await expect(browserBinding.delete("chat.example", "mine")).resolves.toBe(true);
    expect(session.keys()).toEqual([]);
    expect(local.keys()).toEqual(["owncord:credential:chat.example"]);
    await expect(browserBinding.load("chat.example")).resolves.toMatchObject({
      token: "other-tab",
    });
  });

  it("delete with a token leaves a record it cannot read alone", async () => {
    install();
    local.setItem("owncord:credential:chat.example", "{not json");
    await expect(browserBinding.delete("chat.example", "mine")).resolves.toBe(true);
    expect(local.keys()).toEqual(["owncord:credential:chat.example"]);
  });

  it("a save that does not say leaves the other area's different token alone", async () => {
    install();
    // This tab holds one token session-only; another tab kept a different one.
    session.setItem("owncord:credential:chat.example", '{"username":"a","token":"mine"}');
    local.setItem("owncord:credential:chat.example", '{"username":"a","token":"other-tab"}');
    await expect(browserBinding.save("chat.example", "a2", "mine-2")).resolves.toBe(true);
    expect(JSON.parse(session.getItem("owncord:credential:chat.example")!)).toEqual({
      username: "a2",
      token: "mine-2",
    });
    expect(JSON.parse(local.getItem("owncord:credential:chat.example")!).token).toBe("other-tab");

    // And the same from a kept token: the session-only copy is not this tab's.
    install();
    local.setItem("owncord:credential:chat.example", '{"username":"a","token":"kept"}');
    await browserBinding.save("chat.example", "a", "kept-2");
    expect(session.keys()).toEqual([]);
  });

  it("keys credentials by host", async () => {
    install();
    await browserBinding.save("a.example", "alice", "tok-a");
    await browserBinding.save("b.example", "bob", "tok-b");
    await browserBinding.delete("a.example");
    await expect(browserBinding.load("a.example")).resolves.toBeNull();
    await expect(browserBinding.load("b.example")).resolves.toMatchObject({ token: "tok-b" });
  });

  it("resolves null for a stored record that is not a credential", async () => {
    install();
    local.setItem("owncord:credential:chat.example", "{not json");
    await expect(browserBinding.load("chat.example")).resolves.toBeNull();
    local.setItem("owncord:credential:chat.example", '{"username":"alice"}');
    await expect(browserBinding.load("chat.example")).resolves.toBeNull();
  });

  it("has no saved-password login", async () => {
    install();
    await browserBinding.save("chat.example", "alice", "tok", "pw");
    await expect(browserBinding.loginWithSavedPassword("chat.example", "alice")).resolves.toBe(
      null,
    );
  });
});
