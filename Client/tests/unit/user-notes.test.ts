import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClientError } from "@lib/api";
import { expectConsole } from "../helpers/console";
import {
  NOTE_SAVE_DEBOUNCE_MS,
  createNoteBinding,
  currentNotesContext,
  loadLocalNote,
  loadNote,
  setNotesContextSource,
  type NotesApi,
  type NotesContext,
} from "../../src/features/profiles/userNotes";

const HOST = "a.example.com";
const SCOPED = `owncord:dm-note:${HOST}:5`;

function fakeApi(serverNote = ""): {
  api: NotesApi;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn((userId: number) => Promise.resolve({ user_id: userId, note: serverNote }));
  const put = vi.fn((userId: number, note: string) =>
    Promise.resolve({ user_id: userId, note: note.trim() }),
  );
  return { api: { getUserNote: get, putUserNote: put } as unknown as NotesApi, get, put };
}

const session = (): AbortSignal => new AbortController().signal;

const ctxFor = (api: NotesApi): NotesContext => ({
  api,
  host: HOST,
  sessionSignal: new AbortController().signal,
});

describe("user notes", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("loads from server when capable", async () => {
    const { api, get } = fakeApi("server text");
    const text = await loadNote(api, HOST, 5, new AbortController().signal);
    expect(text).toBe("server text");
    expect(get).toHaveBeenCalledWith(5, expect.any(AbortSignal));
  });

  it("falls back to localStorage without capability", async () => {
    localStorage.setItem(SCOPED, "local text");
    expect(await loadNote(null, HOST, 5, new AbortController().signal)).toBe("local text");

    const ctx: NotesContext = {
      api: null,
      host: HOST,
      sessionSignal: new AbortController().signal,
    };
    const binding = createNoteBinding(ctx, 5);
    expect(binding.remote).toBe(false);
    binding.change("typed");
    expect(localStorage.getItem(SCOPED)).toBe("typed");
    binding.destroy();
  });

  it("uploads a local note when the server is empty and removes the key", async () => {
    localStorage.setItem(SCOPED, "old local");
    const { api, put } = fakeApi("");
    const text = await loadNote(api, HOST, 5, new AbortController().signal);
    expect(put).toHaveBeenCalledWith(5, "old local", expect.any(AbortSignal));
    expect(text).toBe("old local");
    expect(localStorage.getItem(SCOPED)).toBeNull();
  });

  it("does not upload the local note when the user typed during the load", async () => {
    localStorage.setItem(SCOPED, "old local");
    const { api, put } = fakeApi("");
    const binding = createNoteBinding(
      { api, host: HOST, sessionSignal: new AbortController().signal },
      5,
    );
    const loading = binding.load(new AbortController().signal);
    binding.change("new");
    await loading;
    expect(put).not.toHaveBeenCalledWith(5, "old local", expect.any(AbortSignal));
    expect(localStorage.getItem(SCOPED)).toBe("old local");
    binding.destroy();
    await vi.waitFor(() => expect(put).toHaveBeenLastCalledWith(5, "new", expect.any(AbortSignal)));
  });

  it("keeps the local key when the upload fails", async () => {
    localStorage.setItem(SCOPED, "old local");
    const { api, put } = fakeApi("");
    put.mockRejectedValueOnce(new ApiClientError(500, "INTERNAL_ERROR", "boom"));
    const text = await loadNote(api, HOST, 5, new AbortController().signal);
    expect(text).toBe("old local");
    expect(localStorage.getItem(SCOPED)).toBe("old local");
    expectConsole("warn", /note upload failed/);
  });

  it("keeps the local note when the server differs, without uploading it later", async () => {
    localStorage.setItem(SCOPED, "local text");
    const { api, put } = fakeApi("server text");
    const text = await loadNote(api, HOST, 5, new AbortController().signal);
    expect(text).toBe("server text");
    expect(put).not.toHaveBeenCalled();
    expect(localStorage.getItem(SCOPED)).toBeNull();
    expect(localStorage.getItem(`owncord:dm-note-kept:${HOST}:5`)).toBe("local text");

    const cleared = fakeApi("");
    expect(await loadNote(cleared.api, HOST, 5, new AbortController().signal)).toBe("");
    expect(cleared.put).not.toHaveBeenCalled();
  });

  it("debounces and flushes on close", async () => {
    vi.useFakeTimers();
    const { api, put } = fakeApi();
    const ctx: NotesContext = { api, host: HOST, sessionSignal: new AbortController().signal };

    const first = createNoteBinding(ctx, 5);
    first.change("a");
    first.change("ab");
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS - 1);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenLastCalledWith(5, "ab", expect.any(AbortSignal));

    // Closing with an edit still pending sends it without waiting.
    first.change("abc");
    first.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(5, "abc", expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS * 2);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("failed save keeps the text and shows not-saved", async () => {
    vi.useFakeTimers();
    const { api, put } = fakeApi();
    put.mockRejectedValueOnce(new ApiClientError(429, "RATE_LIMITED", "slow down"));
    const ctx: NotesContext = { api, host: HOST, sessionSignal: new AbortController().signal };
    const binding = createNoteBinding(ctx, 5);
    const states: boolean[] = [];
    binding.onFailedChange((f) => states.push(f));

    binding.change("keep me");
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS);
    expect(states).toEqual([true]);
    expectConsole("warn", /note save failed/);

    // The next blur retries the same text and clears the notice.
    binding.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(5, "keep me", expect.any(AbortSignal));
    expect(states).toEqual([true, false]);
    binding.destroy();
  });

  it("drops a flush whose session ended before the card closed", async () => {
    const { api, put } = fakeApi();
    const session = new AbortController();
    const binding = createNoteBinding({ api, host: HOST, sessionSignal: session.signal }, 5);
    const states: boolean[] = [];
    binding.onFailedChange((f) => states.push(f));
    binding.change("typed");
    session.abort();
    binding.destroy();
    await Promise.resolve();
    expect(put).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it("drops a 401 or abort on flush without reporting a failure", async () => {
    const { api, put } = fakeApi();
    const states: boolean[] = [];

    put.mockRejectedValueOnce(new ApiClientError(401, "UNAUTHORIZED", "expired"));
    const a = createNoteBinding(
      { api, host: HOST, sessionSignal: new AbortController().signal },
      5,
    );
    a.onFailedChange((f) => states.push(f));
    a.change("x");
    a.destroy();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    put.mockRejectedValueOnce(new DOMException("cancelled", "AbortError"));
    const b = createNoteBinding(
      { api, host: HOST, sessionSignal: new AbortController().signal },
      5,
    );
    b.onFailedChange((f) => states.push(f));
    b.change("y");
    b.destroy();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(states).toEqual([]);
  });
});

describe("user notes sessions and storage keys", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    setNotesContextSource(null);
    localStorage.clear();
  });

  it("hands a card the context the page registered, until it is withdrawn", () => {
    const ctx: NotesContext = { api: null, host: HOST, sessionSignal: session() };
    expect(currentNotesContext()).toBeNull();
    setNotesContextSource(() => ctx);
    expect(currentNotesContext()).toBe(ctx);
    setNotesContextSource(null);
    expect(currentNotesContext()).toBeNull();
  });

  it("keeps a note with no host under the unscoped key", async () => {
    expect(loadLocalNote("", 5)).toBe("");
    localStorage.setItem("owncord:dm-note:5", "legacy text");
    expect(loadLocalNote("", 5)).toBe("legacy text");
    // Read in place: nothing is moved to a host-scoped key.
    expect(localStorage.getItem("owncord:dm-note:5")).toBe("legacy text");
    expect(localStorage.getItem("owncord:dm-note::5")).toBeNull();
    expect(loadLocalNote("", 6)).toBe("");

    const ctx: NotesContext = { api: null, host: "", sessionSignal: session() };
    const binding = createNoteBinding(ctx, 6);
    binding.change("typed");
    expect(localStorage.getItem("owncord:dm-note:6")).toBe("typed");
    expect(localStorage.getItem("owncord:dm-note::6")).toBeNull();
    binding.destroy();
  });

  it("drops the unscoped local note once the server holds the same text", async () => {
    localStorage.setItem("owncord:dm-note:5", "same");
    const { api, put } = fakeApi("same");
    expect(await loadNote(api, "", 5, session())).toBe("same");
    expect(localStorage.getItem("owncord:dm-note:5")).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("user notes loading", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("shows the local note and says why when the server read fails", async () => {
    localStorage.setItem(SCOPED, "local text");
    const { api, get } = fakeApi();
    get.mockRejectedValueOnce(new Error("boom"));
    expect(await loadNote(api, HOST, 5, session())).toBe("local text");
    expectConsole("warn", /note load failed.*"userId":5.*boom/);
  });

  it("warns for a browser error that is not a cancellation", async () => {
    const { api, get } = fakeApi();
    get.mockRejectedValueOnce(new DOMException("offline", "NetworkError"));
    expect(await loadNote(api, HOST, 5, session())).toBe("");
    expectConsole("warn", /note load failed/);
  });

  it("stays quiet when the read died because the session ended", async () => {
    const { api, get } = fakeApi();
    get.mockRejectedValueOnce(new DOMException("cancelled", "AbortError"));
    expect(await loadNote(api, HOST, 5, session())).toBe("");
    get.mockRejectedValueOnce(new ApiClientError(401, "UNAUTHORIZED", "expired"));
    expect(await loadNote(api, HOST, 5, session())).toBe("");
  });

  it("warns for a read refused for another reason, even a server error that is not a 401", async () => {
    const { api, get } = fakeApi();
    get.mockRejectedValueOnce(new ApiClientError(500, "INTERNAL_ERROR", "down"));
    await loadNote(api, HOST, 5, session());
    expectConsole("warn", /note load failed/);
  });

  it("stays quiet when the upload died because the session ended", async () => {
    localStorage.setItem(SCOPED, "old local");
    const { api, put } = fakeApi("");
    put.mockRejectedValueOnce(new DOMException("cancelled", "AbortError"));
    expect(await loadNote(api, HOST, 5, session())).toBe("old local");
    expect(localStorage.getItem(SCOPED)).toBe("old local");
  });

  it("names the user and the cause when the upload fails", async () => {
    localStorage.setItem(SCOPED, "old local");
    const { api, put } = fakeApi("");
    put.mockRejectedValueOnce(new Error("nope"));
    await loadNote(api, HOST, 5, session());
    expectConsole("warn", /note upload failed.*"userId":5.*nope/);
  });

  it("returns the server's note untouched when the load was cancelled meanwhile", async () => {
    localStorage.setItem(SCOPED, "local text");
    const { api, put } = fakeApi("server text");
    const ctl = new AbortController();
    const loading = loadNote(api, HOST, 5, ctl.signal);
    ctl.abort();
    expect(await loading).toBe("server text");
    expect(localStorage.getItem(SCOPED)).toBe("local text");
    expect(localStorage.getItem(`owncord:dm-note-kept:${HOST}:5`)).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it("shows the server's note with no local note and keeps nothing aside", async () => {
    const { api, put } = fakeApi("server text");
    expect(await loadNote(api, HOST, 5, session())).toBe("server text");
    expect(localStorage.getItem(`owncord:dm-note-kept:${HOST}:5`)).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it("removes a local note the server already holds, without keeping or uploading it", async () => {
    localStorage.setItem(SCOPED, "same text");
    const { api, put } = fakeApi("same text");
    expect(await loadNote(api, HOST, 5, session())).toBe("same text");
    expect(localStorage.getItem(SCOPED)).toBeNull();
    expect(localStorage.getItem(`owncord:dm-note-kept:${HOST}:5`)).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it("shows what the server stored after an upload, or the local text if it echoes none", async () => {
    localStorage.setItem(SCOPED, "  padded  ");
    const trimmed = fakeApi("");
    expect(await loadNote(trimmed.api, HOST, 5, session())).toBe("padded");

    localStorage.setItem(SCOPED, "local only");
    const silent = fakeApi("");
    silent.put.mockResolvedValueOnce({ user_id: 5, note: "" });
    expect(await loadNote(silent.api, HOST, 5, session())).toBe("local only");
  });

  it("uploads a local note when the card has not been typed into", async () => {
    localStorage.setItem(SCOPED, "old local");
    const { api, put } = fakeApi("");
    const binding = createNoteBinding({ api, host: HOST, sessionSignal: session() }, 5);
    expect(await binding.load(session())).toBe("old local");
    expect(put).toHaveBeenCalledExactlyOnceWith(5, "old local", expect.any(AbortSignal));
    binding.destroy();
  });
});

describe("user notes saving", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("reports nothing for saves that never failed, and one failure once", async () => {
    const { api, put } = fakeApi();
    const binding = createNoteBinding(ctxFor(api), 5);
    const states: boolean[] = [];
    binding.onFailedChange((f) => states.push(f));
    binding.change("one");
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS);
    expect(put).toHaveBeenCalledTimes(1);
    expect(states).toEqual([]);

    put.mockRejectedValue(new Error("down"));
    binding.change("two");
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS);
    binding.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(3);
    expect(states).toEqual([true]);
    expectConsole("warn", /note save failed.*"userId":5.*down/);
    expectConsole("warn", /note save failed/);
    binding.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expectConsole("warn", /note save failed/);
  });

  it("does not resend a note that was already saved", async () => {
    const { api, put } = fakeApi();
    const binding = createNoteBinding(ctxFor(api), 5);
    binding.change("once");
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS);
    binding.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(1);
    binding.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(1);
  });

  // Edge case: typing continues while the previous save is still in flight.
  it("still sends text typed while an earlier save was in flight", async () => {
    const { api, put } = fakeApi();
    let finish: () => void = () => {};
    put.mockImplementationOnce(
      (userId: number, note: string) =>
        new Promise((resolve) => {
          finish = () => resolve({ user_id: userId, note });
        }),
    );
    const binding = createNoteBinding(ctxFor(api), 5);
    binding.change("a");
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS);
    expect(put).toHaveBeenLastCalledWith(5, "a", expect.any(AbortSignal));
    binding.change("ab");
    finish();
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(5, "ab", expect.any(AbortSignal));
    binding.destroy();
  });

  it("keeps a device-only note as it was when the card is edited after it closed", () => {
    const binding = createNoteBinding({ api: null, host: HOST, sessionSignal: session() }, 5);
    binding.change("before");
    binding.destroy();
    binding.change("after");
    expect(localStorage.getItem(SCOPED)).toBe("before");
  });

  it("ignores edits after the card closed, and closing twice flushes once", async () => {
    const { api, put } = fakeApi();
    put.mockRejectedValue(new Error("down"));
    const binding = createNoteBinding(ctxFor(api), 5);
    binding.change("keep");
    binding.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(1);
    expectConsole("warn", /note save failed/);

    binding.destroy();
    binding.change("late");
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS * 2);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
