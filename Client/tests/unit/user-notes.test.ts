import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClientError } from "@lib/api";
import { expectConsole } from "../helpers/console";
import {
  NOTE_SAVE_DEBOUNCE_MS,
  createNoteBinding,
  loadNote,
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
