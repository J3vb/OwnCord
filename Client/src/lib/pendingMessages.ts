/** Bounded, account/server-owned text outbox. Recovery always requires a click.
 * Native persistence uses the same verified encrypted store as credentials;
 * browser builds keep drafts in memory and never write message text to Web Storage.
 */
import { isTauri, invoke } from "@tauri-apps/api/core";
import { addOptimisticMessage, markSendFailed } from "@stores/messages.store";
import type { MessageUser } from "./types";
import { createLogger } from "./logger";

const log = createLogger("pending-messages");
export const PENDING_MESSAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PENDING_MESSAGE_MAX_COUNT = 64;
export const PENDING_MESSAGE_MAX_BYTES = 128 * 1024;
const ID_PATTERN = /^\d{13}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PendingMessageOwner {
  readonly host: string;
  readonly userId: number;
}
export interface PendingTextMessage {
  readonly clientMessageId: string;
  readonly channelId: number;
  readonly content: string;
  readonly createdAt: number;
}
export interface PendingMessagePersistence {
  load(owner: PendingMessageOwner): Promise<string | null>;
  save(owner: PendingMessageOwner, value: string): Promise<void>;
  delete(owner: PendingMessageOwner): Promise<void>;
}

const nativePersistence: PendingMessagePersistence = {
  async load(owner) {
    if (!isTauri()) return null;
    return invoke<string | null>("load_pending_messages", { ...owner });
  },
  async save(owner, value) {
    if (!isTauri()) return;
    await invoke("save_pending_messages", { ...owner, value });
  },
  async delete(owner) {
    if (!isTauri()) return;
    await invoke("delete_pending_messages", { ...owner });
  },
};

function sameOwner(a: PendingMessageOwner, b: PendingMessageOwner): boolean {
  return a.host === b.host && a.userId === b.userId;
}

export function newClientMessageId(floor = 0): string {
  return `${Math.max(Date.now(), floor)}:${crypto.randomUUID()}`;
}

export function pendingMessageExpired(
  clientMessageId: string,
  now = Date.now(),
  floor = 0,
): boolean {
  const createdAt = Number(clientMessageId.split(":", 1)[0]);
  return (
    !ID_PATTERN.test(clientMessageId) ||
    now - createdAt >= PENDING_MESSAGE_MAX_AGE_MS ||
    createdAt > Math.max(now + 5 * 60 * 1000, floor)
  );
}

/** Serialization never evicts a newer unsent draft to make room for another. */
function decode(value: string | null, now: number, floor: number): PendingTextMessage[] {
  if (value === null) return [];
  if (new TextEncoder().encode(value).length > PENDING_MESSAGE_MAX_BYTES) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  return parsed.filter((entry: unknown): entry is PendingTextMessage => {
    if (typeof entry !== "object" || entry === null) return false;
    const draft = entry as Partial<PendingTextMessage>;
    if (
      typeof draft.clientMessageId !== "string" ||
      pendingMessageExpired(draft.clientMessageId, now, floor) ||
      seen.has(draft.clientMessageId) ||
      typeof draft.createdAt !== "number" ||
      draft.createdAt !== Number(draft.clientMessageId.split(":", 1)[0]) ||
      !Number.isSafeInteger(draft.channelId) ||
      (draft.channelId ?? 0) <= 0 ||
      typeof draft.content !== "string" ||
      draft.content.length === 0
    )
      return false;
    seen.add(draft.clientMessageId);
    return seen.size <= PENDING_MESSAGE_MAX_COUNT;
  });
}

/** An instance owns one login. Its serialized I/O is shared with its successor
 * so a delayed save cannot resurrect rows after logout/delete or a new load.
 */
export class PendingMessageQueue {
  private drafts = new Map<string, PendingTextMessage>();
  private active = true;
  private loading = true;
  private readonly acknowledged = new Set<string>();
  private readonly loaded: Promise<void>;

  constructor(
    readonly owner: PendingMessageOwner,
    private readonly persistence: PendingMessagePersistence,
    private readonly serialize: (operation: () => Promise<void>) => Promise<void>,
    onRecovered: (draft: PendingTextMessage) => void,
    private retryFloor = 0,
  ) {
    this.loaded = serialize(async () => {
      const value = await persistence.load(owner);
      if (!this.active) {
        this.loading = false;
        this.acknowledged.clear();
        return;
      }
      for (const draft of decode(value, Date.now(), this.retryFloor)) {
        if (this.acknowledged.has(draft.clientMessageId)) continue;
        this.drafts.set(draft.clientMessageId, draft);
        onRecovered(draft);
      }
      this.loading = false;
      this.acknowledged.clear();
      // Prune expired/invalid entries from disk, not only from this session.
      if (value !== null) await this.write();
    }).finally(() => {
      this.loading = false;
      this.acknowledged.clear();
    });
  }

  ready(): Promise<void> {
    return this.loaded;
  }
  owns(owner: PendingMessageOwner): boolean {
    return this.active && sameOwner(owner, this.owner);
  }
  get(id: string): PendingTextMessage | undefined {
    return this.drafts.get(id);
  }
  setRetryFloor(floor: number): void {
    this.retryFloor = floor;
  }

  async put(draft: PendingTextMessage): Promise<void> {
    await this.loaded;
    if (!this.active) throw new Error("Session ended before saving the pending message");
    if (pendingMessageExpired(draft.clientMessageId, Date.now(), this.retryFloor))
      throw new Error("Message retry window expired");
    const next = new Map(this.drafts);
    for (const [id] of next)
      if (pendingMessageExpired(id, Date.now(), this.retryFloor)) next.delete(id);
    next.set(draft.clientMessageId, draft);
    if (
      next.size > PENDING_MESSAGE_MAX_COUNT ||
      new TextEncoder().encode(JSON.stringify([...next.values()])).length >
        PENDING_MESSAGE_MAX_BYTES
    ) {
      throw new Error("Pending message recovery storage is full");
    }
    this.drafts = next;
    await this.serialize(async () => {
      if (this.active) await this.write();
    });
    if (!this.active) throw new Error("Session ended before saving the pending message");
  }

  remove(id: string): Promise<void> {
    if (this.loading) this.acknowledged.add(id);
    // Also handles an ACK racing the initial encrypted-store load.
    return this.serialize(async () => {
      if (!this.active || !this.drafts.delete(id)) return;
      await this.write();
    });
  }

  deactivate(discard: boolean): Promise<void> {
    this.active = false;
    this.drafts.clear();
    return discard ? this.serialize(() => this.persistence.delete(this.owner)) : Promise.resolve();
  }

  private async write(): Promise<void> {
    if (this.drafts.size === 0) await this.persistence.delete(this.owner);
    else await this.persistence.save(this.owner, JSON.stringify([...this.drafts.values()]));
  }
}

let operations = Promise.resolve();
function serializePendingWrites(operation: () => Promise<void>): Promise<void> {
  const result = operations.then(operation);
  operations = result.catch(() => undefined);
  return result;
}

let activeQueue: PendingMessageQueue | null = null;
let deduplication = false;
let retryFloor = 0;

export function activatePendingMessages(
  owner: PendingMessageOwner,
  user: MessageUser,
  supportsDeduplication: boolean,
  floor = 0,
): void {
  deduplication = supportsDeduplication;
  retryFloor = Number.isSafeInteger(floor) && floor > 0 ? floor : 0;
  if (activeQueue?.owns(owner)) {
    activeQueue.setRetryFloor(retryFloor);
    return;
  }
  void activeQueue?.deactivate(false);
  activeQueue = new PendingMessageQueue(
    owner,
    nativePersistence,
    serializePendingWrites,
    (draft) => {
      addOptimisticMessage({
        correlationId: `recovered:${draft.clientMessageId}`,
        clientMessageId: draft.clientMessageId,
        channelId: draft.channelId,
        user,
        content: draft.content,
        replyTo: null,
        timestamp: new Date(draft.createdAt).toISOString(),
      });
      markSendFailed(`recovered:${draft.clientMessageId}`, "RECOVERED");
    },
    retryFloor,
  );
  void activeQueue.ready().catch(() => log.warn("Pending message recovery is unavailable"));
}

export function deactivatePendingMessages(options: { discard?: boolean } = {}): void {
  const previous = activeQueue;
  activeQueue = null;
  deduplication = false;
  retryFloor = 0;
  void previous
    ?.deactivate(options.discard === true)
    .catch(() => log.warn("Pending message cleanup failed"));
}

export function supportsMessageDeduplication(owner: PendingMessageOwner): boolean {
  return deduplication && activeQueue?.owns(owner) === true;
}

export function pendingMessageRetryFloor(owner: PendingMessageOwner): number {
  return activeQueue?.owns(owner) ? retryFloor : 0;
}

export async function savePendingText(
  owner: PendingMessageOwner,
  draft: PendingTextMessage,
): Promise<void> {
  const queue = activeQueue;
  if (!queue?.owns(owner)) throw new Error("The message belongs to another session");
  await queue.put(draft);
}

export function recoveredPendingText(
  owner: PendingMessageOwner,
  correlationId: string,
): PendingTextMessage | undefined {
  if (!activeQueue?.owns(owner) || !correlationId.startsWith("recovered:")) return undefined;
  return activeQueue.get(correlationId.slice("recovered:".length));
}

export function acknowledgePendingMessage(clientMessageId: string | undefined): void {
  if (!clientMessageId) return;
  void activeQueue?.remove(clientMessageId).catch(() => log.warn("Pending message cleanup failed"));
}
