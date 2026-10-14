# Decision: live and replay channel scope

**Status:** accepted, 2026-10-14 (roadmap WP 2A-9, source ARCH-041).
**Verified against:** `origin/dev` at `3049a1e`, 2026-10-14.

This is a short decision record. It moves into the ADR series when that
series exists (roadmap Phase 7).

## Context

The server sends channel frames to a client over two paths, and they use
different scopes:

- **Live.** A channel-scoped frame (`chat_message`, `chat_edited`,
  `chat_deleted`, `chat_bulk_deleted`, `chat_pinned`, `reaction_update`)
  in a server channel goes only to the channel's topic subscribers. In
  practice that is the one channel each connection has focused (`deliverGated`
  in `Server/ws/hub_broadcast.go`). DM content goes to every participant.
- **Replay.** A resume replays the frames since `last_seq` for **every
  channel the user can read**, subject to the content gate, not only the
  focused one
  (`reconnectSelectReplay` in `Server/ws/replay.go`, through
  `EventsSinceFilteredContent`).

So unread counts for unfocused channels move when a client resumes but not
while it stays connected. Mentions are the exception: `mention_count` is a
targeted frame that keeps the mention badge of an unfocused channel live
(`docs/protocol.md`, `mention_count`). The UX spec has the unread badge go up
on any `chat_message` in a non-active channel
(`docs/architecture/ux/channels-members-dms.md`, "unread" row).

## Decision

**Keep both scopes as they are, and add a small activity frame for live
unread instead of widening either one.**

1. **Live content stays focused-channel only.** Sending every content frame to
   every reader of every channel would multiply fan-out by the number of
   channels a user can read. It would also run the content gate per frame for
   readers who are not looking. Full content is only worth sending where it is
   shown.
2. **Replay stays all readable channels.** A resume is one bounded batch (ring
   buffer, then the capped cold tier). It is the client's only way to catch up
   on unread state without a full `ready`, and the server cannot know which
   channel the client will focus next.
3. **Live unread for unfocused channels comes from a separate light frame**:
   `channel_activity` (roadmap WP 2B-2), sent to every connected reader of the
   channel, carrying ids and not content. It is **unsequenced, never stored in
   the ring and never replayed**. Replay already carries the content frames
   that rebuild unread state on resume, and a full `ready` carries the
   authoritative counts, so a lost activity frame leaves that channel's dot or count
   behind until its next message, the next resume or `ready`, or the user
   opening it. The 2B-2 design decides coalescing and rate limits, and
   whether the frame reaches readers of an NSFW-labelled channel who have
   not acknowledged it (it names the author and whether they were
   mentioned).
4. **`mention_count` stays as it is.** It already keeps mention badges live.

### Rejected: filter replay down to the live scope

Replaying only the focused channel would make the two paths agree, but every
resume would then lose the unread changes for every other channel until the
next full `ready`. Unread state would get worse after a short network drop
than it is today.

## What clients must assume

- A content frame for a channel that is not on screen can arrive, on replay
  today and through any later scope change. Handling it must be idempotent:
  `noteChannelMessage` (`Client/src/stores/channels.store.ts`) ignores a
  message id at or below the channel's `lastMessageId`. The same guard lets a
  `channel_activity` and a replayed `chat_message` for the same message count
  once. If 2B-2 coalesces a burst into one frame with the latest id, the
  replayed earlier messages are skipped and the burst counts as one unread,
  which is acceptable for a hint.
- Unread for an unfocused channel is a hint between `ready`s. The counts in
  `ready` are the authority.
- Per-connection `cseq` (WP 2A-5) counts only frames sent to that
  connection, so the focused-only live scope never looks like a gap.

## Consequences

- Live unread for unfocused channels ships with 2B-2, not with this record.
  Until then, unfocused server channels update live only through mention
  badges; DMs and the focused channel are live already.
- Widening the live content scope later (for example, a client that shows two
  channels at once) is a new decision. It must state its fan-out cost against
  the capacity budgets in `docs/capacity.md`.
