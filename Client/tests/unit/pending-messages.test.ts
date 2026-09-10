import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PendingMessageQueue,
  PENDING_MESSAGE_MAX_AGE_MS,
  PENDING_MESSAGE_MAX_BYTES,
  PENDING_MESSAGE_MAX_COUNT,
  newClientMessageId,
  pendingMessageExpired,
  type PendingMessageOwner,
  type PendingMessagePersistence,
  type PendingTextMessage,
} from "@lib/pendingMessages";

const owner = { host: "chat.example:55000", userId: 7 };
const key = (scope: PendingMessageOwner) => JSON.stringify(scope);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function textDraft(content = "private pending text"): PendingTextMessage {
  const clientMessageId = newClientMessageId();
  return {
    clientMessageId,
    channelId: 9,
    content,
    createdAt: Number(clientMessageId.split(":", 1)[0]),
  };
}

describe("encrypted pending message queue lifecycle", () => {
  let files: Map<string, string>;
  let persistence: PendingMessagePersistence;
  let serialize: (operation: () => Promise<void>) => Promise<void>;

  beforeEach(() => {
    files = new Map();
    persistence = {
      load: vi.fn(async (scope) => files.get(key(scope)) ?? null),
      save: vi.fn(async (scope, value) => {
        files.set(key(scope), value);
      }),
      delete: vi.fn(async (scope) => {
        files.delete(key(scope));
      }),
    };
    let operations = Promise.resolve();
    serialize = (operation) => {
      const result = operations.then(operation);
      operations = result.catch(() => undefined);
      return result;
    };
  });

  it("restores the exact logical identity after restart without transmitting anything", async () => {
    const first = new PendingMessageQueue(owner, persistence, serialize, vi.fn());
    const draft = textDraft();
    await first.put(draft);
    await first.deactivate(false);
    const recovered = vi.fn();
    const second = new PendingMessageQueue(owner, persistence, serialize, recovered);
    await second.ready();
    expect(recovered).toHaveBeenCalledExactlyOnceWith(draft);
    expect(second.get(draft.clientMessageId)).toEqual(draft);
  });

  it("cannot expose another host, port or account's drafts", async () => {
    const first = new PendingMessageQueue(owner, persistence, serialize, vi.fn());
    await first.put(textDraft());
    await first.deactivate(false);
    for (const scope of [
      { ...owner, host: "other.example:55000" },
      { ...owner, host: "chat.example:55001" },
      { ...owner, userId: 8 },
    ]) {
      const recovered = vi.fn();
      const other = new PendingMessageQueue(scope, persistence, serialize, recovered);
      await other.ready();
      expect(recovered).not.toHaveBeenCalled();
      expect(other.owns(owner)).toBe(false);
      await other.deactivate(false);
    }
  });

  it("suppresses a delayed read after the account was switched", async () => {
    const draft = textDraft();
    const read = deferred<string | null>();
    persistence.load = vi.fn(() => read.promise);
    const recovered = vi.fn();
    const old = new PendingMessageQueue(owner, persistence, serialize, recovered);
    await Promise.resolve();
    await old.deactivate(false);
    read.resolve(JSON.stringify([draft]));
    await old.ready();
    expect(recovered).not.toHaveBeenCalled();
    expect(old.get(draft.clientMessageId)).toBeUndefined();
    await expect(old.put(draft)).rejects.toThrow("Session ended");
  });

  it("clears a late committed draft on logout before the next login reads", async () => {
    const writing = deferred<void>();
    const started = deferred<void>();
    persistence.save = vi.fn(async (scope, value) => {
      started.resolve();
      await writing.promise;
      files.set(key(scope), value);
    });
    const first = new PendingMessageQueue(owner, persistence, serialize, vi.fn());
    const saved = first.put(textDraft());
    // Attach before releasing the write, since the old put must reject.
    const savedResult = expect(saved).rejects.toThrow("Session ended");
    await started.promise;
    const deleted = first.deactivate(true);
    const recovered = vi.fn();
    const next = new PendingMessageQueue(owner, persistence, serialize, recovered);
    writing.resolve();
    await savedResult;
    await deleted;
    await next.ready();
    expect(files.has(key(owner))).toBe(false);
    expect(recovered).not.toHaveBeenCalled();
  });

  it("a receipt arriving before slow recovery does not resurrect its optimistic row", async () => {
    const draft = textDraft();
    const read = deferred<string | null>();
    persistence.load = vi.fn(() => read.promise);
    const recovered = vi.fn();
    const queue = new PendingMessageQueue(owner, persistence, serialize, recovered);
    const acknowledged = queue.remove(draft.clientMessageId);
    read.resolve(JSON.stringify([draft]));
    await queue.ready();
    await acknowledged;
    expect(recovered).not.toHaveBeenCalled();
    expect(files.has(key(owner))).toBe(false);
  });

  it("does not recover acknowledged or explicitly discarded text again", async () => {
    const queue = new PendingMessageQueue(owner, persistence, serialize, vi.fn());
    const draft = textDraft();
    await queue.put(draft);
    await queue.remove(draft.clientMessageId);
    await queue.deactivate(false);
    const recovered = vi.fn();
    await new PendingMessageQueue(owner, persistence, serialize, recovered).ready();
    expect(recovered).not.toHaveBeenCalled();
    expect(files.has(key(owner))).toBe(false);
  });

  it("enforces count and byte caps without evicting existing drafts", async () => {
    const queue = new PendingMessageQueue(owner, persistence, serialize, vi.fn());
    for (let i = 0; i < PENDING_MESSAGE_MAX_COUNT; i++) await queue.put(textDraft(`draft ${i}`));
    const saved = files.get(key(owner));
    await expect(queue.put(textDraft())).rejects.toThrow("full");
    expect(files.get(key(owner))).toBe(saved);
    const other = new PendingMessageQueue({ ...owner, userId: 8 }, persistence, serialize, vi.fn());
    await expect(other.put(textDraft("🙂".repeat(PENDING_MESSAGE_MAX_BYTES / 4)))).rejects.toThrow(
      "full",
    );
    expect(files.has(key({ ...owner, userId: 8 }))).toBe(false);
  });

  it("prunes expired and malformed entries instead of retrying outside the receipt window", async () => {
    const draft = textDraft();
    const createdAt = draft.createdAt - PENDING_MESSAGE_MAX_AGE_MS;
    const expired = { ...draft, createdAt, clientMessageId: `${createdAt}:${crypto.randomUUID()}` };
    files.set(key(owner), JSON.stringify([expired, { ...draft, channelId: -1 }, draft, draft]));
    const recovered = vi.fn();
    const queue = new PendingMessageQueue(owner, persistence, serialize, recovered);
    await queue.ready();
    expect(recovered).toHaveBeenCalledExactlyOnceWith(draft);
    expect(JSON.parse(files.get(key(owner))!)).toEqual([draft]);
    await expect(queue.put(expired)).rejects.toThrow("expired");
  });

  it("reports persistence failures instead of claiming a durable save", async () => {
    persistence.save = vi.fn().mockRejectedValue(new Error("encrypted storage unavailable"));
    const queue = new PendingMessageQueue(owner, persistence, serialize, vi.fn());
    await expect(queue.put(textDraft())).rejects.toThrow("encrypted storage unavailable");
    expect(files.size).toBe(0);
  });

  it("uses the restored server's retry floor for new sends without changing old identities", async () => {
    const floor = Date.now() + 5 * 60 * 1000 + 500;
    const id = newClientMessageId(floor);
    expect(Number(id.split(":", 1)[0])).toBe(floor);
    expect(pendingMessageExpired(id, Date.now())).toBe(true);
    expect(pendingMessageExpired(id, Date.now(), floor)).toBe(false);
    const restored = { ...textDraft(), clientMessageId: id, createdAt: floor };
    const queue = new PendingMessageQueue(owner, persistence, serialize, vi.fn(), floor);
    await queue.put(restored);
    await queue.deactivate(false);
    const recovered = vi.fn();
    const next = new PendingMessageQueue(owner, persistence, serialize, recovered, floor);
    await next.ready();
    expect(recovered).toHaveBeenCalledExactlyOnceWith(restored);
  });

  it("does not retain an acknowledgement ledger throughout a long session", async () => {
    const queue = new PendingMessageQueue(owner, persistence, serialize, vi.fn());
    await queue.ready();
    for (let i = 0; i < 1000; i++) await queue.remove(newClientMessageId());
    // Only a read in flight needs tombstones; confirmed traffic is not an outbox.
    expect((queue as unknown as { acknowledged: Set<string> }).acknowledged.size).toBe(0);
    expect(persistence.save).not.toHaveBeenCalled();
  });
});
