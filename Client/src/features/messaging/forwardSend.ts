/**
 * Sending a Forward: the lazy half of the picker. One `chat_forward`
 * per target, one after another, each with a `client_message_id` of its own and
 * held until its `chat_forward_ok` or `error` arrives (or the connection drops,
 * or the wait times out). An optional comment follows each accepted forward as
 * an ordinary `chat_send`. It writes no store: the forwarded message reaches the
 * target's list as the `chat_message` broadcast, through the dispatcher.
 *
 * A reply is matched by the envelope id `ws.send` returned. Leaving "connected"
 * fails every frame still waiting, so a reply that arrives after a reconnect
 * names an id nobody waits for and is ignored. Retry resends with the same
 * `client_message_id`, so a forward whose ack was lost is answered from the
 * server's receipt and never duplicated.
 */

import { setOwnedTimeout } from "../../lib/dom";
import { newClientMessageId } from "../../lib/pendingMessages";
import type { ClientMessage, ServerMessage } from "../../lib/types";
import type { ConnectionState, WsListener } from "../../lib/ws";
import { claimForwardRequest, releaseForwardRequest } from "./forwardRequests";

/** The slice of the WS client the sender uses; the real client and the test mock both fit. */
export interface ForwardWs {
  send(msg: ClientMessage): string;
  on<T extends ServerMessage["type"]>(type: T, listener: WsListener<T>): () => void;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  onSendFailure(listener: (id: string, code: string) => void): () => void;
  getState(): ConnectionState;
}

/** The server cuts a frame off at 10 s with REQUEST_TIMEOUT; past this the ack is presumed lost. */
export const FORWARD_REPLY_TIMEOUT_MS = 20_000;

export type ForwardStatus = "queued" | "sending" | "sent" | "failed";

export interface ForwardResult {
  readonly channelId: number;
  readonly status: ForwardStatus;
  /** An error code (or OFFLINE / NETWORK / UNCONFIRMED) while `failed`; otherwise null. */
  readonly reason: string | null;
  /** The forward itself was accepted, so a failure is the comment's and Retry resends only that. */
  readonly forwarded: boolean;
}

export interface ForwardSessionOptions {
  readonly ws: ForwardWs;
  readonly sourceMessageId: number;
  readonly channelIds: readonly number[];
  /** Sent after each accepted forward as a plain message; "" sends none. */
  readonly comment: string;
  readonly onChange: (results: readonly ForwardResult[]) => void;
  /** The picker's lifetime: aborting drops every wait and listener. */
  readonly signal: AbortSignal;
}

export interface ForwardSession {
  /** Forward to every target in order. Never rejects. */
  start(): Promise<void>;
  /** Run again the targets that failed, reusing their ids. Never rejects. */
  retryFailed(): Promise<void>;
  results(): readonly ForwardResult[];
}

type Outcome = { readonly ok: true } | { readonly ok: false; readonly code: string };

interface Entry {
  readonly channelId: number;
  status: ForwardStatus;
  reason: string | null;
  forwarded: boolean;
  readonly forwardCmid: string;
  readonly commentCmid: string;
}

interface Waiter {
  readonly clientMessageId: string;
  readonly settle: (outcome: Outcome) => void;
}

export function createForwardSession(opts: ForwardSessionOptions): ForwardSession {
  const { ws, signal } = opts;
  const entries: Entry[] = opts.channelIds.map((channelId) => ({
    channelId,
    status: "queued",
    reason: null,
    forwarded: false,
    forwardCmid: newClientMessageId(),
    commentCmid: newClientMessageId(),
  }));
  const waiting = new Map<string, Waiter>();
  // Envelope ids given up on as UNCONFIRMED stay claimed until the session ends,
  // so a late error for one is not toasted on top of its row.
  const abandoned: string[] = [];
  let running = false;

  const results = (): readonly ForwardResult[] =>
    entries.map(({ channelId, status, reason, forwarded }) => ({
      channelId,
      status,
      reason,
      forwarded,
    }));
  const emit = (): void => {
    if (!signal.aborted) opts.onChange(results());
  };

  function settleWaiter(id: string, outcome: Outcome): void {
    const waiter = waiting.get(id);
    if (waiter === undefined) return;
    waiting.delete(id);
    if (!outcome.ok && outcome.code === "UNCONFIRMED") abandoned.push(id);
    else releaseForwardRequest(id);
    waiter.settle(outcome);
  }

  function failAll(code: string): void {
    for (const id of waiting.keys()) settleWaiter(id, { ok: false, code });
  }

  // A reply for an id nobody waits for (a frame that was failed on disconnect,
  // or one of another feature) falls through every handler below untouched.
  const unsubs = [
    ws.on("chat_forward_ok", (payload, id) => {
      if (id === undefined || waiting.get(id)?.clientMessageId !== payload.client_message_id)
        return;
      settleWaiter(id, { ok: true });
    }),
    ws.on("chat_send_ok", (payload, id) => {
      if (id === undefined || waiting.get(id)?.clientMessageId !== payload.client_message_id)
        return;
      settleWaiter(id, { ok: true });
    }),
    ws.on("error", (payload, id) => {
      if (id !== undefined) settleWaiter(id, { ok: false, code: payload.code });
    }),
    ws.onSendFailure((id, code) => settleWaiter(id, { ok: false, code })),
    ws.onStateChange((state) => {
      if (state !== "connected") failAll("OFFLINE");
    }),
  ];
  signal.addEventListener(
    "abort",
    () => {
      for (const unsub of unsubs) unsub();
      failAll("CANCELLED");
      for (const id of abandoned.splice(0)) releaseForwardRequest(id);
    },
    { once: true },
  );

  /** Send `msg` and wait for the reply to exactly this frame. */
  function request(msg: ClientMessage, clientMessageId: string): Promise<Outcome> {
    if (signal.aborted) return Promise.resolve({ ok: false, code: "CANCELLED" });
    if (ws.getState() !== "connected") return Promise.resolve({ ok: false, code: "OFFLINE" });
    return new Promise<Outcome>((resolve) => {
      const id = ws.send(msg);
      claimForwardRequest(id);
      const stopTimer = setOwnedTimeout(
        signal,
        () => settleWaiter(id, { ok: false, code: "UNCONFIRMED" }),
        FORWARD_REPLY_TIMEOUT_MS,
      );
      waiting.set(id, {
        clientMessageId,
        settle: (outcome) => {
          stopTimer();
          resolve(outcome);
        },
      });
    });
  }

  async function runEntry(entry: Entry): Promise<void> {
    entry.status = "sending";
    entry.reason = null;
    emit();
    if (!entry.forwarded) {
      const out = await request(
        {
          type: "chat_forward",
          payload: {
            client_message_id: entry.forwardCmid,
            channel_id: entry.channelId,
            message_id: opts.sourceMessageId,
          },
        },
        entry.forwardCmid,
      );
      if (!out.ok) {
        entry.status = "failed";
        entry.reason = out.code;
        emit();
        return;
      }
      entry.forwarded = true;
    }
    if (opts.comment !== "") {
      // A plain send that skips the composer's bookkeeping: it does not start the
      // channel's slow-mode countdown or clear a draft, so the server's SLOW_MODE
      // refusal is what the row reports.
      const out = await request(
        {
          type: "chat_send",
          payload: {
            client_message_id: entry.commentCmid,
            channel_id: entry.channelId,
            content: opts.comment,
            reply_to: null,
            attachments: [],
          },
        },
        entry.commentCmid,
      );
      if (!out.ok) {
        entry.status = "failed";
        entry.reason = out.code;
        emit();
        return;
      }
    }
    entry.status = "sent";
    emit();
  }

  async function run(todo: readonly Entry[]): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (const entry of todo) {
        // oxlint-disable-next-line no-await-in-loop -- one target at a time, so a refusal never races the next frame
        await runEntry(entry);
      }
    } finally {
      running = false;
    }
  }

  return {
    start: () => run(entries),
    retryFailed: () => run(entries.filter((e) => e.status === "failed")),
    results,
  };
}
