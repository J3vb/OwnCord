// Server-built link cards in the messages store. A row holds the cards the
// server built for it (`linkPreviews`) and the content version they were built
// for (`linkPreviewsVersion`: the message's edited_at, else its timestamp). A
// `message_link_previews` frame replaces the cards unless the row already holds
// cards for a newer version, and a history page fetched before a newer frame
// must not take them back. Pure (prev, input) => next functions, in the style
// of lib/pollState.ts; returning `prev` by identity when nothing changed is
// behavior, because selector subscriptions compare with ===.
import { mergeMessagePoll } from "./pollState";
import type { LinkPreviewCard, MessageLinkPreviewsPayload } from "./types";
import type { Message, MessagesState } from "../features/messaging/messageModel";

/** The instant a content version names, in ms; NaN for text that is not a time.
 *  The server writes versions as `YYYY-MM-DD HH:MM:SS` (UTC) and message
 *  timestamps as RFC 3339, so both are read as instants rather than compared
 *  as strings. */
function versionInstant(version: string): number {
  const text = version.trim().replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  return Date.parse(zoned);
}

/** Negative when `a` is older than `b`, 0 when they are the same version. */
export function compareContentVersion(a: string, b: string): number {
  const x = versionInstant(a);
  const y = versionInstant(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return a < b ? -1 : a > b ? 1 : 0;
  return x - y;
}

/** The version of a row's own content: what its cards are built for. */
export function contentVersionOf(row: { editedAt: string | null; timestamp: string }): string {
  return row.editedAt ?? row.timestamp;
}

/** `next` with the cards `prev` already holds kept when they are newer. The
 *  incoming copy wins on the same version; a copy that carries no cards at all
 *  (the server omits an empty array) loses only to cards of its own version or
 *  later. */
export function mergeMessageLinkPreviews(prev: Message | undefined, next: Message): Message {
  if (prev?.linkPreviews === undefined || prev.linkPreviewsVersion === undefined) return next;
  const heldVersion = prev.linkPreviewsVersion;
  const nextVersion = next.linkPreviewsVersion ?? contentVersionOf(next);
  const keepHeld =
    next.linkPreviews === undefined
      ? compareContentVersion(heldVersion, nextVersion) >= 0
      : compareContentVersion(heldVersion, nextVersion) > 0;
  if (!keepHeld) return next;
  return { ...next, linkPreviews: prev.linkPreviews, linkPreviewsVersion: heldVersion };
}

/** `next` with the state a live row holds that a replacing copy must not roll
 *  back: a poll's counts and a message's link cards. */
export function mergeHeldState(prev: Message | undefined, next: Message): Message {
  return mergeMessageLinkPreviews(prev, mergeMessagePoll(prev, next));
}

/** updateLinkPreviews' reducer: apply a `message_link_previews` frame. A frame
 *  for a message that is not loaded is dropped (loading it brings its cards),
 *  and so is one older than the cards held. */
export function reduceLinkPreviews(
  prev: MessagesState,
  payload: MessageLinkPreviewsPayload,
): MessagesState {
  const list = prev.messagesByChannel.get(payload.channel_id);
  const index = list?.findIndex((m) => m.id !== 0 && m.id === payload.message_id) ?? -1;
  if (list === undefined || index === -1) return prev;
  const row = list[index]!;
  if (
    row.linkPreviewsVersion !== undefined &&
    compareContentVersion(payload.content_version, row.linkPreviewsVersion) < 0
  ) {
    return prev;
  }
  const messagesByChannel = new Map(prev.messagesByChannel);
  messagesByChannel.set(
    payload.channel_id,
    list.map((m, i) =>
      i === index
        ? {
            ...row,
            linkPreviews: payload.link_previews,
            linkPreviewsVersion: payload.content_version,
          }
        : m,
    ),
  );
  return { ...prev, messagesByChannel };
}

/** The cards a wire payload carries, as the fields a row holds them in. */
export function linkPreviewFields(
  cards: readonly LinkPreviewCard[] | undefined,
  version: string,
): Pick<Message, "linkPreviews" | "linkPreviewsVersion"> {
  return cards === undefined ? {} : { linkPreviews: cards, linkPreviewsVersion: version };
}
