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
import { authStore } from "@stores/auth.store";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args) as unknown,
}));

// Captures the module's logger calls directly (message + data), the same way
// identity.test.ts does for its sibling keyring module — this is what pins
// the log strings/payloads instead of leaving them free to mutate unnoticed.
// vi.hoisted (not a plain const) because vi.mock factories are hoisted above
// the static `authStore` import, whose own module graph pulls in logger.ts
// before a plain top-level const would have run.
const { logMock, createLoggerMock } = vi.hoisted(() => {
  const logMock = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logMock, createLoggerMock: vi.fn(() => logMock) };
});

vi.mock("@lib/logger", () => ({ createLogger: createLoggerMock }));

const { saveCredential, loadCredential, deleteCredential, createUserUpdateCredentialSaver } =
  await import("@lib/credentials");

// saveCredential (called from createUserUpdateCredentialSaver's listener) is
// fire-and-forget: `void saveCredential(...)`. Its own body has no `await`
// until the internal dynamic import settles, so a synchronous assertion right
// after invoking the listener can't tell "the guard returned early" apart
// from "the call is merely still in flight". Flushing to a macrotask boundary
// drains every pending microtask first, so by the time this resolves any
// invoke() call that was going to happen already has.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  logMock.debug.mockReset();
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();
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
      clearPassword: false,
    });
  });

  it("passes an explicit password through", async () => {
    await saveCredential("h.example", "alice", "tok", "s3cret");

    expect(invoke).toHaveBeenCalledWith("save_credential", {
      host: "h.example",
      username: "alice",
      token: "tok",
      password: "s3cret",
      clearPassword: false,
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

  it("only asks to clear the stored password when told to", async () => {
    // A null password means "leave the stored one alone"; erasing it is a
    // separate, explicit intent. Conflating the two used to force the
    // plaintext back through IPC on every re-save.
    await saveCredential("h.example", "alice", "tok");
    const preserved = invoke.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(preserved?.clearPassword).toBe(false);

    invoke.mockClear();
    await saveCredential("h.example", "alice", "tok", undefined, true);
    const cleared = invoke.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(cleared?.clearPassword).toBe(true);
  });

  it("returns false when the command rejects", async () => {
    invoke.mockRejectedValue(new Error("keychain locked"));

    await expect(saveCredential("h.example", "alice", "tok")).resolves.toBe(false);
    // The false return is the only signal the caller sees — the host and
    // underlying error have to survive somewhere, and this is it.
    expect(logMock.error).toHaveBeenCalledWith("Failed to save credential", {
      host: "h.example",
      error: "Error: keychain locked",
    });
  });

  it("names its logger 'credentials' so these messages are filterable", () => {
    expect(createLoggerMock).toHaveBeenCalledWith("credentials");
  });
});

// ── createUserUpdateCredentialSaver ──────────────────────────────────────────

describe("createUserUpdateCredentialSaver", () => {
  beforeEach(() => {
    authStore.setState(() => ({
      token: "sess-token",
      user: { id: 1, username: "alice", avatar: null, role: "member" },
      serverName: null,
      motd: null,
      isAuthenticated: true,
    }));
  });

  it("does not save when the session declined to remember the password (BUG-135)", async () => {
    const listener = createUserUpdateCredentialSaver("h.example", false);

    listener({ user_id: 1, username: "alice2" });
    await flushMicrotasks();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("saves the refreshed username without resending the password when opted in", async () => {
    const listener = createUserUpdateCredentialSaver("h.example", true);

    listener({ user_id: 1, username: "alice2" });

    // saveCredential is fire-and-forget and itself awaits a dynamic import
    // before calling invoke — wait for it rather than guessing a microtask
    // count.
    await vi.waitFor(() => {
      // No plaintext password: the Rust side preserves the stored one when
      // none is supplied, so it never has to cross IPC to survive a re-save.
      expect(invoke).toHaveBeenCalledWith("save_credential", {
        host: "h.example",
        username: "alice2",
        token: "sess-token",
        password: null,
        clearPassword: false,
      });
    });
  });

  it("ignores a user_update for someone else", async () => {
    const listener = createUserUpdateCredentialSaver("h.example", true);

    listener({ user_id: 999, username: "bob" });
    await flushMicrotasks();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no current session token", () => {
    authStore.setState((prev) => ({ ...prev, token: null }));
    const listener = createUserUpdateCredentialSaver("h.example", true);

    listener({ user_id: 1, username: "alice2" });

    expect(invoke).not.toHaveBeenCalled();
  });
});

// ── loadCredential ─────────────────────────────────────────────────────────

describe("loadCredential", () => {
  it("returns the stored username and token", async () => {
    invoke.mockResolvedValue({ username: "alice", token: "tok" });

    await expect(loadCredential("h.example")).resolves.toEqual({
      username: "alice",
      token: "tok",
      hasPassword: false,
    });
    expect(invoke).toHaveBeenCalledWith("load_credential", { host: "h.example" });
  });

  it("reports that a password exists without ever exposing it", async () => {
    // The Rust side marks the field #[serde(skip)], so a plaintext password
    // cannot reach here at all. Even if one somehow did, it must not survive
    // reconstruction into the JS heap.
    invoke.mockResolvedValue({ username: "alice", token: "tok", has_password: true });

    const got = await loadCredential("h.example");

    expect(got).toEqual({ username: "alice", token: "tok", hasPassword: true });
    expect(got).not.toHaveProperty("password");
  });

  it("does not carry a password through even if the backend sends one", async () => {
    invoke.mockResolvedValue({
      username: "alice",
      token: "tok",
      has_password: true,
      password: "pass123",
    });

    const got = await loadCredential("h.example");

    expect(got).not.toHaveProperty("password");
    expect(JSON.stringify(got)).not.toContain("pass123");
  });

  it("drops any extra fields the backend returns", async () => {
    // Only the known fields should survive reconstruction — an unrecognised
    // field must not make it into the JS heap.
    invoke.mockResolvedValue({ username: "alice", token: "tok", bogus: "x" });

    const got = await loadCredential("h.example");

    // toEqual ignores the explicit `password: undefined`, so this still pins
    // the exact shape and catches any unknown field, not just `bogus`.
    expect(got).toEqual({ username: "alice", token: "tok", hasPassword: false });
    expect(got).not.toHaveProperty("bogus");
  });

  it("returns null when nothing is stored, without logging it as an error", async () => {
    invoke.mockResolvedValue(null);

    await expect(loadCredential("h.example")).resolves.toBeNull();
    // "No credential stored" is the ordinary first-run/logged-out case, not a
    // failure: it must be filtered out by `result && typeof result ===
    // "object"` before anything tries to read a field off it, not fall
    // through into the try/catch's error path.
    expect(logMock.error).not.toHaveBeenCalled();
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
    expect(logMock.error).toHaveBeenCalledWith("Failed to load credential", {
      host: "h.example",
      error: "Error: keychain locked",
    });
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
    expect(logMock.error).toHaveBeenCalledWith("Failed to delete credential", {
      host: "h.example",
      error: "Error: no such entry",
    });
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
    expect(logMock.warn).toHaveBeenCalledWith("Tauri not available — credential not saved");
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
