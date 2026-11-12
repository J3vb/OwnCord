import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activatePendingMessages,
  deactivatePendingMessages,
  newClientMessageId,
  savePendingText,
  type PendingMessageOwner,
} from "@lib/pendingMessages";
import { runSessionResets } from "@lib/net/sessionRegistry";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import { authStore } from "@stores/auth.store";
import { messagesStore, resetMessagesStore } from "@stores/messages.store";
import { setConnectionStatus } from "@stores/ui.store";
import { createThreadSender } from "../../src/features/threads/threadSender";
import { createMockWsClient } from "../helpers/mock-ws";
import { resetAuthState } from "../helpers/storeSeeds";

// The encrypted native store is the only thing that outlives the process.
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/platform/desktop/pendingMessages", () => {
  const key = (owner: PendingMessageOwner) => `${owner.host}|${owner.userId}`;
  return {
    pendingMessages: {
      load: async (owner: PendingMessageOwner) => disk.get(key(owner)) ?? null,
      save: async (owner: PendingMessageOwner, value: string) => {
        disk.set(key(owner), value);
      },
      delete: async (owner: PendingMessageOwner) => {
        disk.delete(key(owner));
      },
    },
  };
});

const HOST = "chat.example:55000";
const THREAD = 91;
const CHANNEL = 9;
const ME = { id: 10, username: "me", avatar: null };
const OWNER = { host: HOST, userId: ME.id };

type Ws = ReturnType<typeof createMockWsClient>;
type Frame = { type: string; id: string; payload: Record<string, unknown> };

/**
 * An app launch over the same disk. A restart drops every in-memory record
 * (message rows, per-thread drafts, the loaded queue) the way a process exit
 * does, then signs in and loads pending recovery again.
 */
async function launch(): Promise<void> {
  deactivatePendingMessages();
  runSessionResets("user");
  resetMessagesStore();
  authStore.setState(() => ({
    token: "tok",
    user: { ...ME, role: "member" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
  activatePendingMessages(OWNER, ME, true);
  await settle();
}

const rows = (channelId: number) => messagesStore.getState().messagesByChannel.get(channelId) ?? [];

/** What a thread panel builds when it opens. */
const openThread = (ws: Ws) =>
  createThreadSender({
    ws: ws as unknown as WsClient,
    api: { getConfig: () => ({ host: HOST }) } as unknown as ApiClient,
    threadId: THREAD,
    signal: new AbortController().signal,
    showToast: vi.fn(),
    restoreUnsent: vi.fn(),
  });

/** Lets the serialized encrypted-store I/O finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const frames = (ws: Ws) => ws.getSentMessages() as unknown as Frame[];

beforeEach(() => disk.clear());
afterEach(async () => {
  vi.useRealTimers();
  deactivatePendingMessages({ discard: true });
  await settle();
  runSessionResets("user");
  resetMessagesStore();
  resetAuthState();
  setConnectionStatus("disconnected");
});

describe("a failed thread reply across an app restart", () => {
  it("control: a failed main-channel text written to the pending store comes back after a restart", async () => {
    await launch();
    const id = newClientMessageId();
    await savePendingText(OWNER, {
      clientMessageId: id,
      channelId: CHANNEL,
      content: "main text",
      createdAt: Number(id.split(":", 1)[0]),
    });

    await launch();
    const row = rows(CHANNEL).find((m) => m.clientMessageId === id);
    expect(row).toMatchObject({ content: "main text", status: "failed", errorCode: "RECOVERED" });
  });

  it("an offline thread reply comes back as a failed row after a restart", async () => {
    await launch();
    setConnectionStatus("disconnected");
    openThread(createMockWsClient()).sendText("thread reply", null, false, []);
    expect(rows(THREAD).find((m) => m.content === "thread reply")?.status).toBe("failed");
    await settle();

    await launch();
    const row = rows(THREAD).find((m) => m.content === "thread reply");
    expect(row).toMatchObject({ status: "failed", errorCode: "RECOVERED" });
  });

  it("Retry on the recovered thread reply sends it once, under its original id", async () => {
    await launch();
    setConnectionStatus("disconnected");
    openThread(createMockWsClient()).sendText("thread reply", null, false, []);
    const originalId = rows(THREAD).find((m) => m.content === "thread reply")?.clientMessageId;
    expect(originalId).toBeDefined();
    await settle();

    await launch();
    setConnectionStatus("connected");
    const ws = createMockWsClient();
    const sender = openThread(ws);
    const row = rows(THREAD).find((m) => m.content === "thread reply");
    expect(row?.correlationId).toBeDefined();
    sender.retryDraft(row!.correlationId!);

    expect(frames(ws)).toHaveLength(1);
    expect(frames(ws)[0]!.payload).toMatchObject({
      channel_id: THREAD,
      content: "thread reply",
      client_message_id: originalId,
    });
  });

  it("a thread reply whose acknowledgement never arrives stops spinning and offers Retry", async () => {
    vi.useFakeTimers();
    await launch();
    setConnectionStatus("connected");
    const ws = createMockWsClient();
    openThread(ws).sendText("lost ack", null, false, []);
    expect(frames(ws)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const row = rows(THREAD).find((m) => m.content === "lost ack");
    expect(row?.status).toBe("failed");
  });
});
