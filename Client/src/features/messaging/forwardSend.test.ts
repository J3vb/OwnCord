import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockWsClient, type MockWsClient } from "../../../tests/helpers/mock-ws";
import { isForwardRequest } from "./forwardRequests";
import {
  FORWARD_REPLY_TIMEOUT_MS,
  createForwardSession,
  type ForwardResult,
  type ForwardSession,
} from "./forwardSend";

interface Sent {
  readonly type: string;
  readonly id: string;
  readonly payload: Record<string, unknown>;
}

let ws: MockWsClient;
let abort: AbortController;
let changes: (readonly ForwardResult[])[];

const sent = (): Sent[] => ws.getSentMessages() as unknown as Sent[];
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function make(channelIds: number[], comment = ""): ForwardSession {
  return createForwardSession({
    ws,
    sourceMessageId: 900,
    channelIds,
    comment,
    onChange: (r) => changes.push(r),
    signal: abort.signal,
  });
}

function ackForward(frame: Sent, over: Record<string, unknown> = {}): void {
  ws.simulateMessage(
    "chat_forward_ok",
    {
      message_id: 1,
      channel_id: frame.payload["channel_id"] as number,
      client_message_id: frame.payload["client_message_id"] as string,
      deduplicated: false,
      ...over,
    },
    frame.id,
  );
}

const refuse = (frame: Sent, code: string): void =>
  ws.simulateMessage("error", { code, message: "no" } as never, frame.id);

beforeEach(() => {
  ws = createMockWsClient();
  ws.connect();
  abort = new AbortController();
  changes = [];
});
afterEach(() => abort.abort());

describe("forwardSend", () => {
  it("sends one chat_forward per target, in order, each with its own client_message_id", async () => {
    const session = make([5, 6, 7]);
    const done = session.start();
    await flush();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.type).toBe("chat_forward");
    expect(sent()[0]!.payload).toMatchObject({ channel_id: 5, message_id: 900 });
    ackForward(sent()[0]!);
    await flush();
    expect(sent()).toHaveLength(2);
    ackForward(sent()[1]!);
    await flush();
    ackForward(sent()[2]!);
    await done;
    const cmids = sent().map((s) => s.payload["client_message_id"]);
    expect(new Set(cmids).size).toBe(3);
    expect(session.results().map((r) => r.status)).toEqual(["sent", "sent", "sent"]);
  });

  it("records a refusal per target and still sends the rest", async () => {
    const session = make([5, 6]);
    const done = session.start();
    await flush();
    refuse(sent()[0]!, "FORBIDDEN");
    await flush();
    ackForward(sent()[1]!);
    await done;
    expect(session.results()).toEqual([
      { channelId: 5, status: "failed", reason: "FORBIDDEN", forwarded: false },
      { channelId: 6, status: "sent", reason: null, forwarded: true },
    ]);
  });

  it("keeps an in-flight frame claimed until its reply is handled, then releases it", async () => {
    const session = make([5]);
    const done = session.start();
    await flush();
    const frame = sent()[0]!;
    expect(isForwardRequest(frame.id)).toBe(true);
    ackForward(frame);
    await done;
    await flush();
    expect(isForwardRequest(frame.id)).toBe(false);
  });

  it("retry resends only the failed target with the same client_message_id", async () => {
    const session = make([5, 6]);
    const done = session.start();
    await flush();
    ackForward(sent()[0]!);
    await flush();
    refuse(sent()[1]!, "RATE_LIMITED");
    await done;
    const failedCmid = sent()[1]!.payload["client_message_id"];

    const retry = session.retryFailed();
    await flush();
    expect(sent()).toHaveLength(3);
    expect(sent()[2]!.payload).toMatchObject({ channel_id: 6, client_message_id: failedCmid });
    expect(sent()[2]!.id).not.toBe(sent()[1]!.id);
    ackForward(sent()[2]!, { deduplicated: true });
    await retry;
    expect(session.results().map((r) => r.status)).toEqual(["sent", "sent"]);
  });

  it("ignores an ack that arrives after a reconnect for the frame the drop already failed", async () => {
    const session = make([5]);
    const done = session.start();
    await flush();
    const old = sent()[0]!;
    ws.simulateStateChange("reconnecting");
    await done;
    expect(session.results()[0]).toMatchObject({ status: "failed", reason: "OFFLINE" });

    ws.simulateStateChange("connected");
    ackForward(old); // the stale ack of the dropped connection's frame
    expect(session.results()[0]).toMatchObject({ status: "failed", reason: "OFFLINE" });

    const retry = session.retryFailed();
    await flush();
    const again = sent()[1]!;
    expect(again.payload["client_message_id"]).toBe(old.payload["client_message_id"]);
    ackForward(old); // still the stale id: no effect on the live attempt
    expect(session.results()[0]!.status).toBe("sending");
    ackForward(again, { deduplicated: true });
    await retry;
    expect(session.results()[0]!.status).toBe("sent");
  });

  it("does not take an ack that names another client_message_id", async () => {
    const session = make([5]);
    void session.start();
    await flush();
    ackForward(sent()[0]!, { client_message_id: "someone-else" });
    expect(session.results()[0]!.status).toBe("sending");
  });

  it("fails every target at once while the socket is down, without sending", async () => {
    ws.simulateStateChange("reconnecting");
    const session = make([5, 6]);
    await session.start();
    expect(sent()).toHaveLength(0);
    expect(session.results().map((r) => r.reason)).toEqual(["OFFLINE", "OFFLINE"]);
  });

  it("fails a frame the transport could not send", async () => {
    const session = make([5]);
    const done = session.start();
    await flush();
    ws.simulateSendFailure(sent()[0]!.id, "NETWORK");
    await done;
    expect(session.results()[0]).toMatchObject({ status: "failed", reason: "NETWORK" });
  });

  it("calls a forward UNCONFIRMED when no reply comes in time", async () => {
    vi.useFakeTimers();
    try {
      const session = make([5]);
      const done = session.start();
      await vi.advanceTimersByTimeAsync(FORWARD_REPLY_TIMEOUT_MS);
      await done;
      expect(session.results()[0]).toMatchObject({ status: "failed", reason: "UNCONFIRMED" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an UNCONFIRMED frame claimed until the session ends, so a late error is not toasted", async () => {
    vi.useFakeTimers();
    try {
      const session = make([5]);
      const done = session.start();
      await vi.advanceTimersByTimeAsync(FORWARD_REPLY_TIMEOUT_MS);
      await done;
      const id = sent()[0]!.id;
      await vi.advanceTimersByTimeAsync(0);
      expect(isForwardRequest(id)).toBe(true);
      refuse(sent()[0]!, "FORBIDDEN");
      await vi.advanceTimersByTimeAsync(0);
      expect(isForwardRequest(id)).toBe(true);
      expect(session.results()[0]).toMatchObject({ status: "failed", reason: "UNCONFIRMED" });
      abort.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(isForwardRequest(id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("with a comment", () => {
    it("sends it as a chat_send after each accepted forward", async () => {
      const session = make([5], "look");
      const done = session.start();
      await flush();
      expect(sent().map((s) => s.type)).toEqual(["chat_forward"]);
      ackForward(sent()[0]!);
      await flush();
      expect(sent().map((s) => s.type)).toEqual(["chat_forward", "chat_send"]);
      expect(sent()[1]!.payload).toMatchObject({
        channel_id: 5,
        content: "look",
        reply_to: null,
        attachments: [],
      });
      ws.simulateMessage(
        "chat_send_ok",
        {
          message_id: 2,
          timestamp: "t",
          client_message_id: sent()[1]!.payload["client_message_id"] as string,
        },
        sent()[1]!.id,
      );
      await done;
      expect(session.results()[0]).toMatchObject({ status: "sent", forwarded: true });
    });

    it("sends no comment for a refused forward", async () => {
      const session = make([5], "look");
      const done = session.start();
      await flush();
      refuse(sent()[0]!, "NOT_FOUND");
      await done;
      expect(sent().map((s) => s.type)).toEqual(["chat_forward"]);
    });

    it("on a failed comment, retry resends only the comment", async () => {
      const session = make([5], "look");
      const done = session.start();
      await flush();
      ackForward(sent()[0]!);
      await flush();
      const commentCmid = sent()[1]!.payload["client_message_id"];
      refuse(sent()[1]!, "SLOW_MODE");
      await done;
      expect(session.results()[0]).toMatchObject({ status: "failed", forwarded: true });

      const retry = session.retryFailed();
      await flush();
      expect(sent().map((s) => s.type)).toEqual(["chat_forward", "chat_send", "chat_send"]);
      expect(sent()[2]!.payload["client_message_id"]).toBe(commentCmid);
      ws.simulateMessage(
        "chat_send_ok",
        { message_id: 2, timestamp: "t", client_message_id: commentCmid as string },
        sent()[2]!.id,
      );
      await retry;
      expect(session.results()[0]!.status).toBe("sent");
    });
  });

  it("stops listening and fails the wait when the owner aborts", async () => {
    const session = make([5, 6]);
    const done = session.start();
    await flush();
    abort.abort();
    await done;
    expect(sent()).toHaveLength(1);
    ackForward(sent()[0]!);
    expect(session.results()[0]!.reason).toBe("CANCELLED");
  });

  it("reports each change to the observer", async () => {
    const session = make([5]);
    const done = session.start();
    await flush();
    ackForward(sent()[0]!);
    await done;
    expect(changes.map((c) => c[0]!.status)).toEqual(["sending", "sent"]);
  });
});
