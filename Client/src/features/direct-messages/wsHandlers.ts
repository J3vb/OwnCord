// Direct-message WebSocket handlers — extracted from lib/dispatcher.ts, which
// keeps every socket subscription and calls these plain functions.
import { channelsStore, setActiveChannel } from "../../stores/channels.store";
import {
  dmStore,
  setDmChannels,
  addDmChannel,
  closeDmLocally,
  clearDmUnread,
  dmDisplayName,
} from "../../stores/dm.store";
import type { DmChannel } from "../../stores/dm.store";
import { blocksStore, setBlockedByMe, clearBlockedByThem } from "../../stores/blocks.store";
import type { DmChannelPayload } from "../../lib/types";
import { isTextLikeChannel } from "../../lib/types";
import { createLogger } from "../../lib/logger";
// SidebarDmHelpers is page-level, but addDmToChannelsStore is the only
// place the DM->channelsStore mirror row is synthesized (selectDmConversation
// on open); the dm_channel_close fallback below needs the same synthesis for
// a DM it is activating that was never opened this session.
import { addDmToChannelsStore } from "../../pages/main-page/SidebarDmHelpers";
import type { DispatchContext, Payload } from "../connection/dispatchContext";

// Same logger tag as before the extraction, so the log lines are unchanged.
const log = createLogger("dispatcher");

/** Map one DM participant from the wire shape to the store's. */
function mapDmUser(u: DmChannelPayload["recipient"]): DmChannel["recipient"] {
  return {
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    status: u.status,
    displayName: u.display_name ?? "",
  };
}

/** Map a server DM channel payload to the client DmChannel type. */
function mapDmPayload(p: DmChannelPayload): DmChannel {
  // A pre-group server sends only `recipient`, which for it *is* the whole
  // membership — so the fallback is a one-element list rather than an empty
  // one, and every group-aware call site keeps working against an old server.
  const participants = (p.recipients ?? [p.recipient]).map(mapDmUser);
  return {
    channelId: p.channel_id,
    recipient: participants[0] ?? mapDmUser(p.recipient),
    participants,
    name: p.name ?? "",
    isGroup: p.is_group ?? false,
    lastMessageId: p.last_message_id,
    lastMessage: p.last_message,
    lastMessageAt: p.last_message_at,
    unreadCount: p.unread_count,
    mentionCount: p.mention_count ?? 0,
  };
}

/** The DM slice of `ready`: restate dmStore and reconcile the channels-store mirror rows. */
export function applyReadyDms(payload: Payload<"ready">): void {
  // Populate DM channels from the ready payload. The server always sends
  // the field, so an empty array is an authoritative "no open DMs" (all
  // closed/left on another device) and must clear ghosts from dmStore —
  // skipping it would let a stale DM survive every reconnect.
  const dmPayloads = payload.dm_channels ?? [];
  setDmChannels(dmPayloads.map(mapDmPayload));

  // The channels-store mirror row for a DM (synthesized on open by
  // addDmToChannelsStore) is deliberately carried across setChannels'
  // rebuild above, because the ready payload never includes DM rows at
  // all — but that means a DM closed elsewhere while this client was
  // offline keeps a phantom row here (closeDmLocally fixes this exact
  // shape for the live dm_channel_close path; this is its ready-time
  // equivalent), and a DM read elsewhere keeps a stale unread/mention
  // count (noteChannelMessage bumps the mirror in parallel with dmStore
  // once it exists, but only dmStore is restated above).
  // Reconcile every dm-typed row against the just-restated payload.
  channelsStore.setState((prev) => {
    const dmById = new Map(dmPayloads.map((d) => [d.channel_id, d]));
    const nextChannels = new Map(prev.channels);
    let changed = false;
    for (const [id, ch] of prev.channels) {
      if (ch.type !== "dm") continue;
      const dm = dmById.get(id);
      if (dm === undefined) {
        nextChannels.delete(id);
        changed = true;
        continue;
      }
      const mentionCount = dm.mention_count ?? 0;
      if (ch.unreadCount !== dm.unread_count || ch.mentionCount !== mentionCount) {
        nextChannels.set(id, { ...ch, unreadCount: dm.unread_count, mentionCount });
        changed = true;
      }
    }
    return changed ? { ...prev, channels: nextChannels } : prev;
  });
}

/** The block slice of `ready`: forget "blocked by them" and re-fetch our own blocks. */
export function applyReadyBlocks(ctx: DispatchContext): void {
  const { api } = ctx;
  // Refresh DM block state (channels-members-dms.md §3.2). "Being blocked"
  // is only known from a refused send, so it's stale after a reconnect —
  // clear it and re-fetch our own outgoing blocks authoritatively.
  clearBlockedByThem();
  if (api !== undefined) {
    // OC-0218: snapshot the revision blocksStore was at right before
    // issuing this fetch. If the user blocks/unblocks someone (via
    // SidebarMemberSection's onToggleBlock -> setUserBlockedByMe) while
    // this GET is in flight, that per-user delta bumps the revision;
    // setBlockedByMe then sees the mismatch and skips applying this
    // reply instead of clobbering the fresher local truth with a stale
    // full-set snapshot.
    const blockedByMeRevAtFetch = blocksStore.getState().blockedByMeRev ?? 0;
    api
      .listBlocks()
      .then((r) => setBlockedByMe(r.blocked_user_ids, blockedByMeRevAtFetch))
      .catch((err) => log.warn("Failed to load block list", { error: String(err) }));
  }
}

export function handleDmChannelOpen(payload: Payload<"dm_channel_open">): void {
  log.info("DM channel opened", { channelId: payload.channel_id });
  const dm = mapDmPayload(payload);
  addDmChannel(dm);

  // A DM's channels-store row is synthesised from the DM store, and this
  // event is also how a *membership* change arrives (group renamed, member
  // left). Without this the chat header would keep the name the DM had
  // when it was first opened, until the user navigated away and back.
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(dm.channelId);
    const name = dmDisplayName(dm);
    if (existing === undefined || existing.name === name) return prev;
    const next = new Map(prev.channels);
    next.set(dm.channelId, { ...existing, name });
    return { ...prev, channels: next };
  });
}

export function handleDmChannelClose(payload: Payload<"dm_channel_close">): void {
  log.info("DM channel closed", { channelId: payload.channel_id });
  // Delivered to a device that never ran the local close flow (closed
  // from another signed-in device) — unlike the sidebar's closeOrLeaveDm,
  // there is no "channel visited before this DM" to restore, so fall
  // back to another open DM, else the first text channel.
  closeDmLocally(payload.channel_id, () => {
    const remaining = dmStore.getState().channels;
    if (remaining.length > 0) {
      // Synthesize the channelsStore mirror row before activating: it is
      // only ever created by addDmToChannelsStore (on open, via
      // selectDmConversation), so a DM present in dmStore from `ready`
      // but never opened this session has none — without this,
      // activating it lands on an id ChannelController can't resolve and
      // blanks the chat area with no way to recover.
      addDmToChannelsStore(remaining[0]!);
      // A DM's unread badge lives in dmStore, not the channelsStore
      // mirror — setActiveChannel only zeroes the latter. Every other
      // "open this DM" path (selectDmConversation, navigateToChannel,
      // markChannelRead) pairs activation with clearDmUnread for exactly
      // this reason; without it here the badge on the DM we're about to
      // treat as active survives forever (new messages take the
      // isDmActive branch below and never increment it back).
      clearDmUnread(remaining[0]!.channelId);
      setActiveChannel(remaining[0]!.channelId);
      return;
    }
    const firstText = [...channelsStore.getState().channels.values()]
      .filter((ch) => isTextLikeChannel(ch))
      .toSorted((a, b) => a.position - b.position)[0];
    setActiveChannel(firstText?.id ?? null);
  });
}
