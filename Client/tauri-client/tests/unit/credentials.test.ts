/**
 * Tests for src/lib/credentials.ts.
 *
 * This module was excluded from coverage in vitest.config.ts and only ever
 * `vi.mock`ed by other suites, so none of it had ever been executed under test.
 * It is the JS half of the OS keychain integration ("stay signed in"), and every
 * function is written to fail soft — returning false/null rather than throwing —
 * which is precisely why silent breakage here goes unnoticed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args) as unknown,
}));

const { saveCredential, loadCredential, deleteCredential } = await import("@lib/credentials");

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
});

// ── saveCredential ─────────────────────────────────────────────────────────

describe("saveCredential", () => {
  it("forwards host, username and token to the Rust command", async () => {
    await expect(saveCredential("h.example", "alice", "tok")).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith("save_credential", {
      host: "h.example",
      username: "alice",
      token: "tok",
      password: null,
    });
  });

  it("passes an explicit password through", async () => {
    await saveCredential("h.example", "alice", "tok", "s3cret");

    expect(invoke).toHaveBeenCalledWith("save_credential", {
      host: "h.example",
      username: "alice",
      token: "tok",
      password: "s3cret",
    });
  });

  it("normalises a missing password to null rather than undefined", async () => {
    await saveCredential("h.example", "alice", "tok");

    // undefined would be dropped from the IPC payload and the Rust side would
    // see a missing argument instead of an explicit "no password".
    const args = invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.password).toBeNull();
    expect("password" in args).toBe(true);
  });

  it("returns false when the command rejects", async () => {
    invoke.mockRejectedValue(new Error("keychain locked"));

    await expect(saveCredential("h.example", "alice", "tok")).resolves.toBe(false);
  });
});

// ── loadCredential ─────────────────────────────────────────────────────────

describe("loadCredential", () => {
  it("returns the stored username and token", async () => {
    invoke.mockResolvedValue({ username: "alice", token: "tok" });

    await expect(loadCredential("h.example")).resolves.toEqual({
      username: "alice",
      token: "tok",
    });
    expect(invoke).toHaveBeenCalledWith("load_credential", { host: "h.example" });
  });

  it("drops any extra fields the backend returns", async () => {
    // The Rust side deliberately stopped returning the password over IPC; if it
    // ever regresses, the password must not make it into the JS heap.
    invoke.mockResolvedValue({ username: "alice", token: "tok", password: "leaked" });

    const got = await loadCredential("h.example");

    expect(got).toEqual({ username: "alice", token: "tok" });
    expect(got).not.toHaveProperty("password");
  });

  it("returns null when nothing is stored", async () => {
    invoke.mockResolvedValue(null);

    await expect(loadCredential("h.example")).resolves.toBeNull();
  });

  it.each([
    ["a string", "not-an-object"],
    ["a number", 42],
    ["an object with no username", { token: "tok" }],
    ["an object with no token", { username: "alice" }],
    ["a non-string username", { username: 1, token: "tok" }],
    ["a non-string token", { username: "alice", token: 1 }],
  ])("returns null for a malformed result (%s)", async (_label, result) => {
    invoke.mockResolvedValue(result);

    await expect(loadCredential("h.example")).resolves.toBeNull();
  });

  it("returns null when the command rejects", async () => {
    invoke.mockRejectedValue(new Error("keychain locked"));

    await expect(loadCredential("h.example")).resolves.toBeNull();
  });
});

// ── deleteCredential ───────────────────────────────────────────────────────

describe("deleteCredential", () => {
  it("forwards the host and reports success", async () => {
    await expect(deleteCredential("h.example")).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith("delete_credential", { host: "h.example" });
  });

  it("returns false when the command rejects", async () => {
    invoke.mockRejectedValue(new Error("no such entry"));

    await expect(deleteCredential("h.example")).resolves.toBe(false);
  });
});

// ── non-Tauri fallback ─────────────────────────────────────────────────────

describe("outside Tauri", () => {
  /**
   * Re-imports credentials.ts with the Tauri core module supplying no `invoke`
   * export, so getInvoke() resolves to a falsy value and every function takes
   * its "Tauri not available" early return. That is the same branch a genuine
   * import failure lands on (a plain browser, or a test that never stubs the
   * module), reached deterministically.
   *
   * The branch matters because the connect screen calls loadCredential
   * unconditionally on mount: it must return null, not reject.
   */
  async function importWithoutInvoke(): Promise<typeof import("@lib/credentials")> {
    vi.resetModules();
    vi.doMock("@tauri-apps/api/core", () => ({}));
    return import("@lib/credentials");
  }

  afterEach(() => {
    // credentials.ts imports the Tauri core module lazily, inside getInvoke —
    // so the mock has to stay in place until after the call under test, not
    // just until the module import.
    vi.doUnmock("@tauri-apps/api/core");
    vi.resetModules();
  });

  it("saveCredential reports failure instead of throwing", async () => {
    const { saveCredential: save } = await importWithoutInvoke();

    await expect(save("h.example", "alice", "tok")).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("loadCredential returns null instead of throwing", async () => {
    const { loadCredential: load } = await importWithoutInvoke();

    await expect(load("h.example")).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("deleteCredential reports failure instead of throwing", async () => {
    const { deleteCredential: del } = await importWithoutInvoke();

    await expect(del("h.example")).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
