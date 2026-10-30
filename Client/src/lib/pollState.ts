// Poll reducers for the messages store: a live `poll_update`, the
// vote acknowledgement, and `mergePoll`, which keeps a poll from going back.
// Pure (prev, input) => next functions; stores/messages.store.ts wraps each in
// messagesStore.setState. Returning `prev` by identity when nothing changed is
// behavior: selector subscriptions compare with ===.
//
// A poll copy has two watermarks. `results.version` orders the counts: the
// highest version is a complete state, so a lower one is dropped. `selfVersion`
// orders the viewer's own selection (`results.me`), which moves only from a
// frame that names the viewer and is above it. Two votes on two devices can
// reach this client out of order, and a stranger's newer vote must not hide the
// viewer's newest own one.
import type { PollUpdatePayload, PollView, PollVoteOkPayload } from "./types";
import type { Message, MessagesState } from "../features/messaging/messageModel";

/**
 * The poll a row should show when `next` replaces `prev` (a replayed
 * `chat_message` at version 0, a history page fetched before a newer update).
 * The higher version wins, and on equal versions the incoming copy does. `me`
 * follows its own watermark, and an ended poll never reopens.
 */
export function mergePoll(
  prev: PollView | undefined,
  next: PollView | undefined,
): PollView | undefined {
  if (prev === undefined || next === undefined) return next;
  const results = next.results.version >= prev.results.version ? next.results : prev.results;
  const own = next.selfVersion >= prev.selfVersion ? next : prev;
  if (results === next.results && own === next && (next.ended || !prev.ended)) return next;
  return {
    ...next,
    ended: prev.ended || next.ended,
    ended_at: next.ended_at ?? prev.ended_at,
    results: { ...results, me: own.results.me },
    selfVersion: own.selfVersion,
  };
}

/** `next` with the poll `prev` already holds merged in; `next` itself when nothing differs. */
export function mergeMessagePoll(prev: Message | undefined, next: Message): Message {
  if (prev === undefined || next.poll === undefined) return next;
  const poll = mergePoll(prev.poll, next.poll);
  return poll === next.poll ? next : { ...next, ...(poll !== undefined && { poll }) };
}

/** Replace one message of a channel, or null when it is not loaded or is no poll. */
function withPoll(
  prev: MessagesState,
  channelId: number,
  messageId: number,
  change: (poll: PollView) => PollView,
): MessagesState {
  const list = prev.messagesByChannel.get(channelId);
  const index = list?.findIndex((m) => m.id === messageId && m.poll !== undefined) ?? -1;
  if (list === undefined || index === -1) return prev;
  const row = list[index]!;
  const poll = change(row.poll!);
  if (poll === row.poll) return prev;
  const messagesByChannel = new Map(prev.messagesByChannel);
  messagesByChannel.set(
    channelId,
    list.map((m, i) => (i === index ? { ...row, poll } : m)),
  );
  return { ...prev, messagesByChannel };
}

/** updatePoll's reducer: apply a `poll_update`, in version order. */
export function reducePollUpdate(
  prev: MessagesState,
  payload: PollUpdatePayload,
  currentUserId: number,
): MessagesState {
  return withPoll(prev, payload.channel_id, payload.message_id, (poll) => {
    const newer = payload.version > poll.results.version;
    const own =
      payload.user_id === currentUserId &&
      payload.answer_ids !== undefined &&
      payload.version > poll.selfVersion;
    if (!newer && !own) return poll;
    const me = own ? payload.answer_ids : poll.results.me;
    if (!newer) return { ...poll, results: { ...poll.results, me }, selfVersion: payload.version };
    return {
      ...poll,
      ended: poll.ended || payload.ended,
      ended_at: payload.ended_at ?? poll.ended_at,
      results: {
        version: payload.version,
        total_voters: payload.total_voters,
        counts: payload.counts,
        me,
      },
      selfVersion: own ? payload.version : poll.selfVersion,
    };
  });
}

/**
 * applyPollVoteOk's reducer: the sender's own `poll_vote_ok` names their stored
 * selection at a version, so the card can show it before the sequenced
 * `poll_update` (which carries the counts) arrives. Same self watermark.
 */
export function reducePollVoteOk(prev: MessagesState, payload: PollVoteOkPayload): MessagesState {
  const { message_id, version, answer_ids } = payload;
  for (const channelId of prev.messagesByChannel.keys()) {
    const next = withPoll(prev, channelId, message_id, (poll) =>
      version > poll.selfVersion
        ? { ...poll, results: { ...poll.results, me: answer_ids }, selfVersion: version }
        : poll,
    );
    if (next !== prev) return next;
  }
  return prev;
}
