/**
 * The three poll requests: `poll_create`, `poll_vote` and `poll_end`.
 * Each sends one frame and waits for its own `ok` or an `error` carrying the
 * frame's envelope id, for the connection to drop, or for the wait to time out.
 * None writes a store: the new poll reaches the list as the `chat_message`
 * broadcast and every count as a `poll_update`, through the dispatcher.
 *
 * A reply is matched by the envelope id `ws.send` returned. Leaving "connected"
 * fails every frame still waiting, so a reply that arrives after a reconnect
 * names an id nobody waits for and is ignored. A create is retried with the same
 * `client_message_id`, so one whose acknowledgement was lost is answered from
 * the server's receipt and never posts a second poll. A vote carries the whole
 * new selection, so repeating it is harmless. Votes are not optimistic: the card
 * shows a busy state until the reply, so there is nothing to roll back.
 */

import type {
  ClientMessage,
  PollCreateAnswer,
  PollCreateOkPayload,
  PollEndOkPayload,
  PollVoteOkPayload,
  ServerMessage,
} from "../../lib/types";
import type { ConnectionState, WsListener } from "../../lib/ws";
import { claimPollRequest, releasePollRequest } from "./pollRequests";

/** The slice of the WS client the requests use; the real client and the test mock both fit. */
export interface PollWs {
  send(msg: ClientMessage): string;
  on<T extends ServerMessage["type"]>(type: T, listener: WsListener<T>): () => void;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  onSendFailure(listener: (id: string, code: string) => void): () => void;
  getState(): ConnectionState;
}

/** The server cuts a frame off at 10 s with REQUEST_TIMEOUT; past this the reply is presumed lost. */
export const POLL_REPLY_TIMEOUT_MS = 20_000;

/** What a request came to: the server's reply, or an error code (or OFFLINE / UNCONFIRMED / CANCELLED). */
export type PollOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

export interface CreatePollParams {
  readonly channelId: number;
  readonly question: string;
  readonly answers: readonly PollCreateAnswer[];
  readonly durationHours: number;
  readonly allowMultiselect: boolean;
  /** Reuse the same id to retry a create that may have been accepted. */
  readonly clientMessageId: string;
}

type OkType = "poll_create_ok" | "poll_vote_ok" | "poll_end_ok";
type OkPayload<T extends OkType> = Extract<ServerMessage, { type: T }>["payload"];

/** Envelope ids given up on as UNCONFIRMED stay claimed until the session resets, so a late error is not toasted. */
function request<T extends OkType>(
  ws: PollWs,
  msg: ClientMessage,
  ok: T,
  matches: (payload: OkPayload<T>) => boolean,
  signal: AbortSignal | undefined,
): Promise<PollOutcome<OkPayload<T>>> {
  if (signal?.aborted === true) return Promise.resolve({ ok: false, code: "CANCELLED" });
  if (ws.getState() !== "connected") return Promise.resolve({ ok: false, code: "OFFLINE" });
  return new Promise((resolve) => {
    const id = ws.send(msg);
    claimPollRequest(id);
    let settled = false;
    const cleanups: (() => void)[] = [];
    const settle = (outcome: PollOutcome<OkPayload<T>>): void => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      if (outcome.ok || outcome.code !== "UNCONFIRMED") releasePollRequest(id);
      resolve(outcome);
    };
    cleanups.push(
      ws.on(ok, (payload, replyId) => {
        // The listener's payload is typed by its literal; `matches` is the request's own check.
        if (replyId === id && matches(payload as OkPayload<T>)) {
          settle({ ok: true, value: payload as OkPayload<T> });
        }
      }),
      ws.on("error", (payload, replyId) => {
        if (replyId === id) settle({ ok: false, code: payload.code });
      }),
      ws.onSendFailure((failedId, code) => {
        if (failedId === id) settle({ ok: false, code });
      }),
      ws.onStateChange((state) => {
        if (state !== "connected") settle({ ok: false, code: "OFFLINE" });
      }),
    );
    const timer = setTimeout(
      () => settle({ ok: false, code: "UNCONFIRMED" }),
      POLL_REPLY_TIMEOUT_MS,
    );
    cleanups.push(() => clearTimeout(timer));
    if (signal !== undefined) {
      const onAbort = (): void => settle({ ok: false, code: "CANCELLED" });
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }
  });
}

/** Post a poll. Resolves with the new message's id, or why it was not posted. */
export function createPoll(
  ws: PollWs,
  params: CreatePollParams,
  signal?: AbortSignal,
): Promise<PollOutcome<PollCreateOkPayload>> {
  return request(
    ws,
    {
      type: "poll_create",
      payload: {
        client_message_id: params.clientMessageId,
        channel_id: params.channelId,
        question: params.question,
        answers: params.answers,
        duration_hours: params.durationHours,
        allow_multiselect: params.allowMultiselect,
      },
    },
    "poll_create_ok",
    (p) => p.client_message_id === params.clientMessageId,
    signal,
  );
}

/** Set the whole selection on a poll; `[]` removes the vote. */
export function votePoll(
  ws: PollWs,
  messageId: number,
  answerIds: readonly number[],
  signal?: AbortSignal,
): Promise<PollOutcome<PollVoteOkPayload>> {
  return request(
    ws,
    { type: "poll_vote", payload: { message_id: messageId, answer_ids: answerIds } },
    "poll_vote_ok",
    (p) => p.message_id === messageId,
    signal,
  );
}

/** End a poll now (its author, or anyone who may delete the message). */
export function endPoll(
  ws: PollWs,
  messageId: number,
  signal?: AbortSignal,
): Promise<PollOutcome<PollEndOkPayload>> {
  return request(
    ws,
    { type: "poll_end", payload: { message_id: messageId } },
    "poll_end_ok",
    (p) => p.message_id === messageId,
    signal,
  );
}
