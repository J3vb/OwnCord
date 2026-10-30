import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listSessionResets,
  registerSessionReset,
  runSessionResets,
} from "../../src/lib/net/sessionRegistry";
import { authStore, clearAuth, setAuth } from "../../src/stores/auth.store";
import type { UserWithRole } from "../../src/lib/types";
import { expectConsole } from "../helpers/console";

const disposers: (() => void)[] = [];
function reg(...args: Parameters<typeof registerSessionReset>): () => void {
  const dispose = registerSessionReset(...args);
  disposers.push(dispose);
  return dispose;
}

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  vi.restoreAllMocks();
});

describe("sessionRegistry", () => {
  it("a throwing reset does not stop later resets", () => {
    const later = vi.fn();
    reg("test:throws", () => {
      throw new Error("boom");
    });
    reg("test:later", later);

    const failed = runSessionResets("user");

    expectConsole("warn", /Session reset failed.*test:throws/);
    expect(failed).toContain("test:throws");
    expect(failed).not.toContain("test:later");
    expect(later).toHaveBeenCalledWith("user");
  });

  it("a disposer removes only its own registration", () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = reg("test:name", first);
    reg("test:name", second);

    // The first registration was replaced; its disposer must not remove the second.
    disposeFirst();
    runSessionResets("user");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a disposer removes its entry", () => {
    const fn = vi.fn();
    const dispose = reg("test:gone", fn);
    dispose();
    runSessionResets("user");
    expect(fn).not.toHaveBeenCalled();
    expect(listSessionResets()).not.toContain("test:gone");
  });

  it("re-registering a name replaces it", () => {
    const old = vi.fn();
    const fresh = vi.fn();
    reg("test:replace", old);
    reg("test:replace", fresh);

    runSessionResets("server_switch");

    expect(old).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledWith("server_switch");
    expect(listSessionResets().filter((n) => n === "test:replace")).toHaveLength(1);
  });

  it("runs session, voice, domain, cache in that order whatever the registration order", () => {
    const calls: string[] = [];
    reg("test:cache", () => calls.push("cache"), { phase: "cache" });
    reg("test:domain", () => calls.push("domain"));
    reg("test:voice", () => calls.push("voice"), { phase: "voice" });
    reg("test:session", () => calls.push("session"), { phase: "session" });

    runSessionResets("user");

    expect(calls).toEqual(["session", "voice", "domain", "cache"]);
  });

  it("clearAuth clears authStore even when every reset throws", () => {
    const user = { id: 1, username: "u", role: "member" } as unknown as UserWithRole;
    setAuth("tok", user, "Server", "motd");
    expect(authStore.getState().isAuthenticated).toBe(true);
    // One throwing entry in every phase.
    for (const phase of ["session", "voice", "domain", "cache"] as const) {
      reg(
        `test:throws-${phase}`,
        () => {
          throw new Error("boom");
        },
        { phase },
      );
    }

    clearAuth("user");

    for (const phase of ["session", "voice", "domain", "cache"]) {
      expectConsole("warn", new RegExp(`Session reset failed.*test:throws-${phase}`));
    }
    expect(authStore.getState().isAuthenticated).toBe(false);
    expect(authStore.getState().token).toBeNull();
    expect(authStore.getState().logoutReason).toBe("user");
  });
});
