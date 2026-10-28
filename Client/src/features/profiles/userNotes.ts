/**
 * Private profile notes (WP 6.11c): one note per member you keep about them,
 * shown in the profile popup and the DM side panel.
 *
 * With the server's `user_notes` capability the note lives on the server
 * (`GET`/`PUT /users/me/notes/{userId}`) and follows the account between
 * devices. Without it the note stays in `localStorage` on this device, exactly
 * as the DM panel always kept it.
 *
 * A note typed before the capability existed is moved up once: when the server
 * has no text and this device does, the local note is uploaded and its key
 * removed. When both exist and differ the server wins and the local note is
 * moved to a "kept" key, so nothing is lost and a note later cleared on the
 * server is not uploaded again from this device.
 */

import { ApiClientError, type ApiClient, type UserNote } from "@lib/api";
import { Disposable } from "@lib/disposable";
import { setOwnedTimeout } from "@lib/dom";
import { migrateLegacyValue } from "@lib/legacyKeyMigration";
import { readStored, removeStored, writeStored } from "@lib/preferences";
import { createLogger } from "@lib/logger";
import { userNotesEnabled } from "@lib/serverCapabilities";

const log = createLogger("user-notes");

/** The server's cap on a note, in characters (`maxUserNoteLen`). */
export const NOTE_MAX_LENGTH = 256;

/** Quiet period after the last keystroke before the note is sent. */
export const NOTE_SAVE_DEBOUNCE_MS = 600;

const NOTE_STORAGE_PREFIX = "owncord:dm-note:";
const KEPT_NOTE_PREFIX = "owncord:dm-note-kept:";

/** The two calls a note needs from the API client. */
export type NotesApi = Pick<ApiClient, "getUserNote" | "putUserNote">;

/**
 * Where notes go for one session. `api` is null when the server lacks the
 * capability (notes stay local). `sessionSignal` aborts when the session that
 * opened the card ends: the shared API client is re-pointed at the next
 * server then, so a late flush must check it before sending and never reach
 * the new session.
 */
export interface NotesContext {
  readonly api: NotesApi | null;
  readonly host: string;
  readonly sessionSignal: AbortSignal;
}

/** Capture the session now: its capability, host and ownership signal. */
export function createNotesContext(api: ApiClient, host: string): NotesContext {
  return {
    api: userNotesEnabled() ? api : null,
    host,
    sessionSignal: api.getSession().signal,
  };
}

let contextSource: (() => NotesContext | null) | null = null;

/**
 * The live page registers how a card opened from anywhere finds the current
 * session's notes; null on teardown. Read at open time, never later, so a card
 * keeps the session that opened it.
 */
export function setNotesContextSource(source: (() => NotesContext | null) | null): void {
  contextSource = source;
}

/** The current session's notes context, or null when no page has registered one. */
export function currentNotesContext(): NotesContext | null {
  return contextSource === null ? null : contextSource();
}

// ---------------------------------------------------------------------------
// localStorage (no capability)
// ---------------------------------------------------------------------------

/** The legacy unscoped key, from before per-server notes (or when the caller
 *  has not been updated to pass a host). */
function legacyNoteKey(userId: number): string {
  return NOTE_STORAGE_PREFIX + String(userId);
}

function scopedNoteKey(userId: number, host: string): string {
  return `${NOTE_STORAGE_PREFIX}${host}:${userId}`;
}

/** The note kept on this device, "" when none or storage is unusable. */
export function loadLocalNote(host: string, userId: number): string {
  if (host === "") return readStored(legacyNoteKey(userId)) ?? "";

  const scoped = readStored(scopedNoteKey(userId, host));
  if (scoped !== null) return scoped;

  // Miss at the scoped key: migrate the pre-scoping legacy note through
  // `migrateLegacyValue`, which moves it under the key of the FIRST host
  // opened post-upgrade and no other. User ids are per-server autoincrement
  // integers, so a legacy note left readable would show server A's private
  // note about user N for the unrelated user N on every other server
  // (OC-0329) — the same shape channel-mutes.ts fixed for OC-0288.
  return migrateLegacyValue(legacyNoteKey(userId), scopedNoteKey(userId, host)) ?? "";
}

/** Keep `text` on this device. */
export function saveLocalNote(host: string, userId: number, text: string): void {
  // Storage unavailable or full: the note is simply not kept.
  writeStored(host !== "" ? scopedNoteKey(userId, host) : legacyNoteKey(userId), text);
}

/** Move a local note the server overrides out of the upload path, keeping its text. */
function keepLocalNote(host: string, userId: number, text: string): void {
  if (!writeStored(`${KEPT_NOTE_PREFIX}${host}:${userId}`, text)) return;
  removeLocalNote(host, userId);
}

function removeLocalNote(host: string, userId: number): void {
  // Storage unusable: nothing to do, the note is already on the server.
  removeStored(host !== "" ? scopedNoteKey(userId, host) : legacyNoteKey(userId));
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** A failure that says the request's session is gone, not that the save failed. */
function isSessionGone(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return err instanceof ApiClientError && err.status === 401;
}

/**
 * The note to show. With `api` (the capability) it is the server's; if the
 * server has none and this device does, the local note is uploaded and its key
 * removed on success. A differing local note is moved to the kept key. With a null
 * `api` it is the local note. A failed GET shows the local note (or "").
 */
export async function loadNote(
  api: NotesApi | null,
  host: string,
  userId: number,
  signal: AbortSignal,
  canUpload: () => boolean = () => true,
): Promise<string> {
  if (api === null) return loadLocalNote(host, userId);

  let server: UserNote;
  try {
    server = await api.getUserNote(userId, signal);
  } catch (err) {
    if (!isSessionGone(err)) log.warn("note load failed", { userId, error: String(err) });
    return loadLocalNote(host, userId);
  }
  if (signal.aborted) return server.note;

  const local = loadLocalNote(host, userId);
  if (local === "") return server.note;
  if (server.note === local) {
    removeLocalNote(host, userId);
    return server.note;
  }
  if (server.note !== "") {
    keepLocalNote(host, userId, local);
    return server.note;
  }

  // The user typed while the GET was in flight: their edit is on its way and
  // must not be overwritten by the old local note.
  if (!canUpload()) return local;

  try {
    const stored = await api.putUserNote(userId, local, signal);
    removeLocalNote(host, userId);
    return stored.note === "" ? local : stored.note;
  } catch (err) {
    if (!isSessionGone(err)) log.warn("note upload failed", { userId, error: String(err) });
    return local;
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export interface NoteSaverOptions {
  readonly api: NotesApi | null;
  readonly host: string;
  readonly userId: number;
  /** Ends with the session that opened the card; a flush after it is dropped. */
  readonly sessionSignal: AbortSignal;
  /** Owns the debounce timer; aborting it cancels a pending (unflushed) timer. */
  readonly ownerSignal: AbortSignal;
  /** Called with true when a save failed and false when it later succeeds. */
  readonly onFailedChange?: (failed: boolean) => void;
}

export interface NoteSaver {
  /** The text changed: saved at once locally, after the debounce on the server. */
  change(text: string): void;
  /** Send any unsent text now (blur, close). Retries a failed save. */
  flush(): Promise<void>;
}

/**
 * Debounced writer for one note. A failed `PUT` keeps the text pending and
 * reports it; the next `flush` (blur) retries. A request that dies because its
 * session ended, or answers 401, is dropped without a report and without
 * touching whichever session is live now.
 */
export function createNoteSaver(options: NoteSaverOptions): NoteSaver {
  const { api, host, userId, sessionSignal, ownerSignal, onFailedChange } = options;
  let pending: string | null = null;
  let failed = false;
  let cancelTimer: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve();

  const setFailed = (next: boolean): void => {
    if (failed === next) return;
    failed = next;
    onFailedChange?.(next);
  };

  async function send(): Promise<void> {
    const text = pending;
    if (text === null || api === null) return;
    if (sessionSignal.aborted) {
      pending = null;
      return;
    }
    try {
      await api.putUserNote(userId, text, sessionSignal);
      if (pending === text) pending = null;
      setFailed(false);
    } catch (err) {
      if (isSessionGone(err) || sessionSignal.aborted) {
        pending = null;
        return;
      }
      log.warn("note save failed", { userId, error: String(err) });
      setFailed(true);
    }
  }

  function flush(): Promise<void> {
    cancelTimer?.();
    cancelTimer = null;
    chain = chain.then(send);
    return chain;
  }

  function change(text: string): void {
    if (api === null) {
      saveLocalNote(host, userId, text);
      return;
    }
    pending = text;
    cancelTimer?.();
    cancelTimer = setOwnedTimeout(
      ownerSignal,
      () => {
        cancelTimer = null;
        void flush();
      },
      NOTE_SAVE_DEBOUNCE_MS,
    );
  }

  return { change, flush };
}

// ---------------------------------------------------------------------------
// Binding (what a card holds)
// ---------------------------------------------------------------------------

/** One card's view of one note: what the popup and the DM panel talk to. */
export interface NoteBinding {
  /** True when the note is on the server (it loads asynchronously). */
  readonly remote: boolean;
  /** The note on this device, read now. The first paint when not `remote`. */
  readLocal(): string;
  load(signal: AbortSignal): Promise<string>;
  change(text: string): void;
  flush(): void;
  /** Subscribe to "not saved" (true) and "saved again" (false). */
  onFailedChange(listener: (failed: boolean) => void): void;
  /** Flush what is pending, then stop the debounce. Safe to call twice. */
  destroy(): void;
}

/**
 * Bind note `userId` for one card, capturing `context` (the session that opened
 * it). `destroy` flushes with that session's client, so a card closed with an
 * edit pending still saves, and a closed session's flush is dropped.
 */
export function createNoteBinding(context: NotesContext, userId: number): NoteBinding {
  const owner = new Disposable();
  let listener: ((failed: boolean) => void) | null = null;
  const saver = createNoteSaver({
    api: context.api,
    host: context.host,
    userId,
    sessionSignal: context.sessionSignal,
    ownerSignal: owner.signal,
    onFailedChange: (failed) => listener?.(failed),
  });
  let destroyed = false;
  let touched = false;

  return {
    remote: context.api !== null,
    readLocal: () => loadLocalNote(context.host, userId),
    load: (signal) => loadNote(context.api, context.host, userId, signal, () => !touched),
    change: (text) => {
      if (destroyed) return;
      touched = true;
      saver.change(text);
    },
    flush: () => {
      void saver.flush();
    },
    onFailedChange: (next) => {
      listener = next;
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      // Flush first (it cancels the timer), then stop the owner so a late
      // retry cannot arm another one.
      void saver.flush();
      owner.destroy();
    },
  };
}
