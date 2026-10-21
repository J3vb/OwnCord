import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockWsClient, type MockWsClient } from "../../../tests/helpers/mock-ws";
import { handleMessagingError } from "./wsHandlers";
import { isPollRequest } from "./pollRequests";
import {
  POLL_REPLY_TIMEOUT_MS,
  createPoll,
  endPoll,
  votePoll,
  type CreatePollParams,
} from "./pollSend";

interface Sent {
  readonly type: string;
  readonly id: string;
  readonly payload: Record<string, unknown>;
}

let ws: MockWsClient;
const sent = (): Sent[] => ws.getSentMessages() as unknown as Sent[];
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const params = (over: Partial<CreatePollParams> = {}): CreatePollParams => ({
  channelId: 9,
  question: "Lunch?",
  answers: [{ text: "Pizza", emoji: "🍕" }, { text: "Sushi" }],
  durationHours: 24,
  allowMultiselect: false,
  clientMessageId: "cmid-1",
  ...over,
});

beforeEach(() => {
  ws = createMockWsClient();
  ws.connect();
});
afterEach(() => vi.useRealTimers());

describe("createPoll", () => {
  it("sends the whole poll with its client_message_id and settles on its poll_create_ok", async () => {
    const done = createPoll(ws, params());
    await flush();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.type).toBe("poll_create");
    expect(sent()[0]!.payload).toEqual({
      client_message_id: "cmid-1",
      channel_id: 9,
      question: "Lunch?",
      answers: [{ text: "Pizza", emoji: "🍕" }, { text: "Sushi" }],
      duration_hours: 24,
      allow_multiselect: false,
    });
    ws.simulateMessage(
      "poll_create_ok",
      { message_id: 1104, channel_id: 9, client_message_id: "cmid-1", deduplicated: false },
      sent()[0]!.id,
    );
    await expect(done).resolves.toEqual({
      ok: true,
      value: { message_id: 1104, channel_id: 9, client_message_id: "cmid-1", deduplicated: false },
    });
  });

  it("settles on an error carrying its envelope id, and not on another frame's", async () => {
    const done = createPoll(ws, params());
    await flush();
    ws.simulateMessage("error", { code: "RATE_LIMITED", message: "slow" } as never, "other-id");
    ws.simulateMessage("error", { code: "RATE_LIMITED", message: "slow" } as never, sent()[0]!.id);
    await expect(done).resolves.toEqual({ ok: false, code: "RATE_LIMITED" });
  });

  it("does not take an ok that names another client_message_id", async () => {
    const done = createPoll(ws, params());
    await flush();
    ws.simulateMessage(
      "poll_create_ok",
      { message_id: 1, channel_id: 9, client_message_id: "someone-else", deduplicated: false },
      sent()[0]!.id,
    );
    ws.simulateSendFailure(sent()[0]!.id, "NETWORK");
    await expect(done).resolves.toEqual({ ok: false, code: "NETWORK" });
  });

  it("retry reuses the client_message_id, so a lost ack is answered from the receipt", async () => {
    vi.useFakeTimers();
    const first = createPoll(ws, params());
    await vi.advanceTimersByTimeAsync(POLL_REPLY_TIMEOUT_MS);
    await expect(first).resolves.toEqual({ ok: false, code: "UNCONFIRMED" });
    const retry = createPoll(ws, params());
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.payload["client_message_id"]).toBe(sent()[0]!.payload["client_message_id"]);
    ws.simulateMessage(
      "poll_create_ok",
      { message_id: 7, channel_id: 9, client_message_id: "cmid-1", deduplicated: true },
      sent()[1]!.id,
    );
    await expect(retry).resolves.toMatchObject({ ok: true, value: { deduplicated: true } });
  });

  it("is OFFLINE without sending while the socket is down", async () => {
    ws.simulateStateChange("reconnecting");
    await expect(createPoll(ws, params())).resolves.toEqual({ ok: false, code: "OFFLINE" });
    expect(sent()).toHaveLength(0);
  });

  it("drops its wait when the connection leaves connected, and ignores a stale ok after", async () => {
    const done = createPoll(ws, params());
    await flush();
    const old = sent()[0]!;
    ws.simulateStateChange("reconnecting");
    await expect(done).resolves.toEqual({ ok: false, code: "OFFLINE" });
    ws.simulateStateChange("connected");
    // The stale ack of the dropped connection's frame has nobody waiting.
    ws.simulateMessage(
      "poll_create_ok",
      { message_id: 1, channel_id: 9, client_message_id: "cmid-1", deduplicated: false },
      old.id,
    );
    const again = createPoll(ws, params());
    await flush();
    expect(sent()).toHaveLength(2);
    ws.simulateMessage(
      "poll_create_ok",
      { message_id: 1, channel_id: 9, client_message_id: "cmid-1", deduplicated: false },
      old.id,
    );
    ws.simulateSendFailure(sent()[1]!.id, "NETWORK");
    await expect(again).resolves.toEqual({ ok: false, code: "NETWORK" });
  });

  it("is UNCONFIRMED when no reply comes in time, and stays claimed so a late error is not toasted", async () => {
    vi.useFakeTimers();
    const done = createPoll(ws, params());
    await vi.advanceTimersByTimeAsync(POLL_REPLY_TIMEOUT_MS);
    await expect(done).resolves.toEqual({ ok: false, code: "UNCONFIRMED" });
    const id = sent()[0]!.id;
    await vi.advanceTimersByTimeAsync(0);
    expect(isPollRequest(id)).toBe(true);
  });

  it("is CANCELLED when its owner aborts", async () => {
    const abort = new AbortController();
    const done = createPoll(ws, params(), abort.signal);
    await flush();
    abort.abort();
    await expect(done).resolves.toEqual({ ok: false, code: "CANCELLED" });
    await expect(createPoll(ws, params(), abort.signal)).resolves.toEqual({
      ok: false,
      code: "CANCELLED",
    });
    expect(sent()).toHaveLength(1);
  });
});

describe("votePoll and endPoll", () => {
  it("votePoll sends the whole selection and settles on its poll_vote_ok", async () => {
    const done = votePoll(ws, 1104, [1, 3]);
    await flush();
    expect(sent()[0]).toMatchObject({
      type: "poll_vote",
      payload: { message_id: 1104, answer_ids: [1, 3] },
    });
    ws.simulateMessage(
      "poll_vote_ok",
      { message_id: 1104, version: 4, answer_ids: [1, 3] },
      sent()[0]!.id,
    );
    await expect(done).resolves.toEqual({
      ok: true,
      value: { message_id: 1104, version: 4, answer_ids: [1, 3] },
    });
  });

  it("votePoll([]) removes the vote", async () => {
    void votePoll(ws, 1104, []);
    await flush();
    expect(sent()[0]!.payload).toEqual({ message_id: 1104, answer_ids: [] });
  });

  it("a refused vote reports the code, here the ended poll", async () => {
    const done = votePoll(ws, 1104, [1]);
    await flush();
    ws.simulateMessage("error", { code: "POLL_ENDED", message: "ended" } as never, sent()[0]!.id);
    await expect(done).resolves.toEqual({ ok: false, code: "POLL_ENDED" });
  });

  it("endPoll settles on its poll_end_ok", async () => {
    const done = endPoll(ws, 1104);
    await flush();
    expect(sent()[0]).toMatchObject({ type: "poll_end", payload: { message_id: 1104 } });
    ws.simulateMessage("poll_end_ok", { message_id: 1104 }, sent()[0]!.id);
    await expect(done).resolves.toEqual({ ok: true, value: { message_id: 1104 } });
  });
});

describe("the dispatcher's error handler", () => {
  it("claims an in-flight frame, so a refusal is not toasted twice, and lets go after the reply", async () => {
    const done = votePoll(ws, 1104, [1]);
    await flush();
    const id = sent()[0]!.id;
    expect(isPollRequest(id)).toBe(true);
    expect(handleMessagingError({ code: "FORBIDDEN", message: "no" } as never, id)).toBe(true);
    ws.simulateMessage("error", { code: "FORBIDDEN", message: "no" } as never, id);
    await done;
    await flush();
    expect(isPollRequest(id)).toBe(false);
  });
});
