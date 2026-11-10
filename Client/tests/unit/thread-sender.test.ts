import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/pendingMessages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/pendingMessages")>()),
  supportsMessageDeduplication: () => true,
}));

import { createThreadSender } from "../../src/features/threads/threadSender";
import { Disposable } from "@lib/disposable";
import { WsErrorCode } from "@lib/protocolTypes";
import { messagesStore, resetMessagesStore } from "@stores/messages.store";
import { setConnectionStatus } from "@stores/ui.store";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import { createMockWsClient } from "../helpers/mock-ws";
import { resetGateStores, signInAs } from "../helpers/message-actions-fixtures";

const THREAD = 91;
const FILE = { id: "up-1", url: "/f", filename: "a.png" };

let ws: ReturnType<typeof createMockWsClient>;
let owner: Disposable;
const restoreUnsent = vi.fn();
const showToast = vi.fn();

function makeSender(signal: AbortSignal = new AbortController().signal) {
  return createThreadSender({
    ws: ws as unknown as WsClient,
    api: { getConfig: () => ({ host: "h" }) } as unknown as ApiClient,
    threadId: THREAD,
    signal,
    showToast,
    restoreUnsent,
  });
}

const rows = () => messagesStore.getState().messagesByChannel.get(THREAD) ?? [];
const frames = () =>
  ws.getSentMessages() as unknown as {
    type: string;
    id: string;
    payload: Record<string, unknown>;
  }[];

beforeEach(() => {
  resetGateStores();
  resetMessagesStore();
  signInAs("member");
  ws = createMockWsClient();
  owner = new Disposable();
  restoreUnsent.mockClear();
  showToast.mockClear();
});
afterEach(() => {
  owner.destroy();
  setConnectionStatus("disconnected");
  resetMessagesStore();
  resetGateStores();
});

describe("thread sender", () => {
  it("keeps an offline send as a failed row and sends it again as one frame", () => {
    setConnectionStatus("disconnected");
    const sender = makeSender();
    sender.sendText("later", null, false, [FILE]);
    expect(frames()).toHaveLength(0);
    const failed = rows().find((m) => m.content === "later");
    expect(failed?.status).toBe("failed");

    setConnectionStatus("connected");
    sender.retryDraft(failed!.correlationId!);
    expect(rows().some((m) => m.correlationId === failed!.correlationId)).toBe(false);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.payload).toMatchObject({
      channel_id: THREAD,
      content: "later",
      attachments: ["up-1"],
    });
  });

  it("sends a refused reply again as a plain message", () => {
    setConnectionStatus("connected");
    const sender = makeSender();
    sender.sendText("answer", 7, true, []);
    const sent = frames()[0]!;
    expect(sent.payload).toMatchObject({ reply_to: 7, reply_ping: true });
    messagesStore.setState((prev) => ({
      ...prev,
      messagesByChannel: new Map(prev.messagesByChannel).set(
        THREAD,
        rows().map((m) =>
          m.correlationId === sent.id
            ? { ...m, status: "failed" as const, errorCode: WsErrorCode.BAD_REQUEST }
            : m,
        ),
      ),
    }));
    sender.retryDraft(sent.id);
    const again = frames()[1]!;
    expect(again.payload).toMatchObject({ content: "answer", reply_to: null });
    expect(again.payload).not.toHaveProperty("reply_ping");
  });

  it("ignores a retry for a row it holds no draft for", () => {
    setConnectionStatus("connected");
    makeSender().retryDraft("unknown");
    expect(frames()).toHaveLength(0);
  });

  it("drops a discarded draft's row", () => {
    setConnectionStatus("disconnected");
    const sender = makeSender();
    sender.sendText("never mind", null, false, []);
    const cid = rows()[0]!.correlationId!;
    sender.discardDraft(cid);
    expect(rows()).toHaveLength(0);
    setConnectionStatus("connected");
    sender.retryDraft(cid);
    expect(frames()).toHaveLength(0);
  });

  it("sends nothing once its signal has aborted", () => {
    setConnectionStatus("connected");
    const abort = new AbortController();
    const sender = makeSender(abort.signal);
    abort.abort();
    sender.sendText("late", null, false, []);
    expect(frames()).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it("hands back the files a delivered send skipped, and only those", () => {
    setConnectionStatus("connected");
    const sender = makeSender();
    sender.watchUnsentFiles(owner);
    sender.sendText("hi", null, false, [FILE, { ...FILE, id: "up-2" }]);
    ws.simulate(
      "chat_send_ok",
      { message_id: 5, timestamp: "", skipped_attachment_ids: ["up-2"] },
      frames()[0]!.id,
    );
    expect(restoreUnsent).toHaveBeenCalledWith([{ ...FILE, id: "up-2" }], "skipped");
  });

  it("hands back every file when the server reports them unavailable, once", () => {
    setConnectionStatus("connected");
    const sender = makeSender();
    sender.watchUnsentFiles(owner);
    sender.sendText("hi", null, false, [FILE]);
    const id = frames()[0]!.id;
    ws.simulate("error", { code: WsErrorCode.ATTACHMENTS_UNAVAILABLE, message: "" }, id);
    ws.simulate("error", { code: WsErrorCode.ATTACHMENTS_UNAVAILABLE, message: "" }, id);
    expect(restoreUnsent).toHaveBeenCalledTimes(1);
    expect(restoreUnsent).toHaveBeenCalledWith([FILE], "unavailable");
  });

  it("ignores other errors and frames without a correlation id", () => {
    setConnectionStatus("connected");
    const sender = makeSender();
    sender.watchUnsentFiles(owner);
    sender.sendText("hi", null, false, [FILE]);
    ws.simulate("error", { code: WsErrorCode.BAD_REQUEST, message: "" }, frames()[0]!.id);
    ws.simulate("error", { code: WsErrorCode.ATTACHMENTS_UNAVAILABLE, message: "" });
    expect(restoreUnsent).not.toHaveBeenCalled();
  });

  it("holds no drafts after clear", () => {
    setConnectionStatus("disconnected");
    const sender = makeSender();
    sender.sendText("x", null, false, []);
    const cid = rows()[0]!.correlationId!;
    sender.clear();
    setConnectionStatus("connected");
    sender.retryDraft(cid);
    expect(frames()).toHaveLength(0);
  });
});
