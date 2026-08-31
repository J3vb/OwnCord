package ws

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// buildAuthOK constructs the auth_ok server→client message.
// Per PROTOCOL.md, user object contains only id, username, avatar, role (no status).
//
// replaySource records which reconnection tier served this client:
//   - "none"   — fresh connection or full re-sync (no resume)
//   - "buffer" — resume served from the in-memory ring buffer
//   - "db"     — resume served from the persistent EventStore (Phase B Step 7)
func (h *Hub) buildAuthOK(ctx context.Context, user *db.User, roleName string, replaySource string) []byte {
	var avatarVal any
	if user.Avatar != nil {
		avatarVal = *user.Avatar
	}

	serverName, motd := h.getCachedSettings(ctx)

	return buildJSON(map[string]any{
		"type": MsgTypeAuthOK,
		"payload": map[string]any{
			"user": map[string]any{
				"id":       user.ID,
				"username": user.Username,
				"avatar":   avatarVal,
				"role":     roleName,
				// The signed-in user's own profile fields. Null when unset;
				// display_name falls back to username client-side, and about
				// is what the "edit my profile" form pre-fills from.
				"display_name":  user.DisplayName,
				"about":         user.About,
				"custom_status": user.CustomStatus,
				// The user's own true status — invisible included. Only their
				// own auth_ok ever carries it, which is the whole point: the
				// picker has to render what they chose, while every other
				// client is told offline.
				"status": user.Status,
			},
			"server_name":   serverName,
			"motd":          motd,
			"replay_source": replaySource,
		},
	})
}

// presentableMembers rewrites each member's status into what viewerID may see.
//
// Two rules, both applied here so no payload builder can implement only one:
//
//  1. A member with no live connection is offline, whatever the row says.
//     users.status keeps a *chosen* idle/dnd/invisible across a disconnect so
//     the next connect can honour it, which would otherwise leave a signed-out
//     user showing as "Do Not Disturb" indefinitely.
//  2. An invisible member is offline to everyone but themselves
//     (db.StatusForViewer). The owner keeps their true state so their own
//     picker renders the status they actually chose.
func (h *Hub) presentableMembers(members []db.MemberSummary, viewerID int64) []db.MemberSummary {
	connected := h.connectedUserIDs()
	out := make([]db.MemberSummary, 0, len(members))
	for _, m := range members {
		if !connected[m.ID] {
			m.Status = db.StatusOffline
			m.CustomStatus = nil
		}
		out = append(out, m.ForViewer(viewerID))
	}
	return out
}

// presentableDMChannels applies presentableMembers' "no live connection means
// offline" rule to a DM channel list's recipient statuses. GetUserDMChannels
// already applies db.StatusForViewer (the invisible-to-others half); this
// adds the missing "no live connection" half so dm_channels cannot disagree
// with the members array about whether the same disconnected user is online.
// Both Recipient (the legacy single-recipient field) and every entry of
// Recipients (the group-aware field) are rewritten, since a 1:1 DM's
// Recipient is a copy of Recipients[0], not a shared reference.
func (h *Hub) presentableDMChannels(dmChannels []db.DMChannelInfo) []db.DMChannelInfo {
	connected := h.connectedUserIDs()
	for i := range dmChannels {
		if dmChannels[i].Recipient.ID != 0 && !connected[dmChannels[i].Recipient.ID] {
			dmChannels[i].Recipient.Status = db.StatusOffline
		}
		for j := range dmChannels[i].Recipients {
			if !connected[dmChannels[i].Recipients[j].ID] {
				dmChannels[i].Recipients[j].Status = db.StatusOffline
			}
		}
	}
	return dmChannels
}

// connectedUserIDs snapshots the ids with a live WebSocket connection.
func (h *Hub) connectedUserIDs() map[int64]bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	set := make(map[int64]bool, len(h.clients))
	for uid := range h.clients {
		set[uid] = true
	}
	return set
}

// channelRefs maps db channels to the checker's db-agnostic ChannelRef so
// buildReady and computeAllowedChannels can share permissions.VisibleChannelIDs.
func channelRefs(channels []db.Channel) []permissions.ChannelRef {
	refs := make([]permissions.ChannelRef, len(channels))
	for i := range channels {
		refs[i] = permissions.ChannelRef{ID: channels[i].ID, Type: channels[i].Type, Archived: channels[i].Archived}
	}
	return refs
}

// permOverrides maps a db override map to the checker's override map, carrying
// BOTH layers — the role override and the per-user override — so the checker
// resolves the full order (base -> role -> user) rather than half of it.
func permOverrides(overrides map[int64]db.ChannelOverride) map[int64]permissions.ChannelOverride {
	out := make(map[int64]permissions.ChannelOverride, len(overrides))
	for id, o := range overrides {
		out[id] = permOverride(o)
	}
	return out
}

// channelCanSend reports whether a user with the given role and per-channel
// override may post in a channel of chanType — the ready payload's can_send
// affordance, so the client can pre-disable the composer without a
// round-trip. It is permissions.CanSendMessage, the same predicate the send
// path enforces, so the affordance cannot drift from the rule (S-12).
func channelCanSend(role *db.Role, o db.ChannelOverride, chanType string) bool {
	if role == nil {
		return false
	}
	return permissions.CanSendMessage(permissions.Subject{
		RolePerms: role.Permissions,
		Override:  permOverride(o),
		Channel:   permissions.ChannelRef{Type: chanType},
	}) == nil
}

// channelRef maps one db channel to the predicates' db-agnostic ChannelRef.
func channelRef(ch *db.Channel) permissions.ChannelRef {
	return permissions.ChannelRef{ID: ch.ID, Type: ch.Type, Archived: ch.Archived}
}

// permOverride maps one db override (both layers) to the checker's type.
func permOverride(o db.ChannelOverride) permissions.ChannelOverride {
	return permissions.ChannelOverride{Allow: o.Allow, Deny: o.Deny, UserAllow: o.UserAllow, UserDeny: o.UserDeny}
}

// readyVisibleChannels resolves the channels the user may see for the ready
// payload, returning the per-channel override map it fetched alongside them so
// buildReady can reuse it for the can_send affordance without a second query.
func (h *Hub) readyVisibleChannels(ctx context.Context, database ReadySnapshotReader, userID int64, role *db.Role, channels []db.Channel) ([]db.Channel, map[int64]db.ChannelOverride, error) {
	// Filter channels by READ_MESSAGES through the single permissions.Checker
	// predicate shared with REST ListVisibleChannels and reconnect replay
	// filtering (computeAllowedChannels). The overrides map is fetched once and
	// reused below for the per-channel can_send affordance. DM channels are
	// excluded by the checker — they are delivered via the dm_channels field.
	overrides := map[int64]db.ChannelOverride{}
	if role != nil && !permissions.HasAdmin(role.Permissions) {
		var oErr error
		overrides, oErr = database.GetChannelOverridesFor(ctx, role.ID, userID)
		if oErr != nil {
			return nil, nil, fmt.Errorf("buildReady GetChannelOverridesFor: %w", oErr)
		}
	}
	var visibleChannels []db.Channel
	if role != nil {
		// Nil role = zero access (fail closed), handled by skipping the filter.
		visibleIDs := h.permChecker.VisibleChannelIDs(role.Permissions, channelRefs(channels), permOverrides(overrides))
		for i := range channels {
			if visibleIDs[channels[i].ID] {
				visibleChannels = append(visibleChannels, channels[i])
			}
		}
	}
	if visibleChannels == nil {
		visibleChannels = []db.Channel{}
	}
	return visibleChannels, overrides, nil
}

// readyChannelPayloads builds the ready payload's channel objects — one entry
// per visible channel, with the per-user unread fields folded in.
func readyChannelPayloads(visibleChannels []db.Channel, overrides map[int64]db.ChannelOverride, unreadMap map[int64]db.ChannelUnread, role *db.Role) []map[string]any {
	channelPayloads := make([]map[string]any, 0, len(visibleChannels))
	for i := range visibleChannels {
		entry := map[string]any{
			"id":       visibleChannels[i].ID,
			"name":     visibleChannels[i].Name,
			"type":     visibleChannels[i].Type,
			"category": visibleChannels[i].Category,
			"topic":    visibleChannels[i].Topic,
			"position": visibleChannels[i].Position,
			// can_send drives the client's composer affordance. It mirrors
			// MessageService.checkSendPermission for non-DM channels: base role
			// ± channel overrides must grant READ|SEND, and announcement
			// channels additionally require MANAGE_MESSAGES; admins bypass. The
			// server remains the authority — this only pre-disables the UI.
			"can_send": channelCanSend(role, overrides[visibleChannels[i].ID], visibleChannels[i].Type),
			// Cooldown in seconds (0 = off). Lets the composer disable itself
			// for the window instead of accepting a send the server refuses
			// with SLOW_MODE. The server still enforces.
			"slow_mode": visibleChannels[i].SlowMode,
			// Age-gate flag. Shipped so a client can label or gate the
			// channel; the server applies no content behaviour of its own to
			// a flagged channel (migration 025).
			"nsfw": visibleChannels[i].NSFW,
			// Voice capacity limits (0 = unlimited) — the same values the
			// voice-join path enforces with CHANNEL_FULL / VIDEO_LIMIT.
			"voice_max_users": visibleChannels[i].VoiceMaxUsers,
			"voice_max_video": visibleChannels[i].VoiceMaxVideo,
		}
		if visibleChannels[i].Type == "text" || visibleChannels[i].Type == "announcement" {
			if u, ok := unreadMap[visibleChannels[i].ID]; ok {
				entry["unread_count"] = u.UnreadCount
				entry["last_message_id"] = u.LastMessageID
				entry["mention_count"] = u.MentionCount
			} else {
				entry["unread_count"] = 0
				entry["last_message_id"] = 0
				entry["mention_count"] = 0
			}
		}
		channelPayloads = append(channelPayloads, entry)
	}
	return channelPayloads
}

// readyDMChannels loads the user's open DM channels and reconciles them with
// the rest of the ready payload: mention counts from unreadMap, and the same
// presence rule presentableMembers applies to the members array.
func (h *Hub) readyDMChannels(ctx context.Context, database ReadySnapshotReader, userID int64, unreadMap map[int64]db.ChannelUnread) ([]db.DMChannelInfo, error) {
	dmChannels, err := database.GetUserDMChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("buildReady GetUserDMChannels: %w", err)
	}
	// GetUserDMChannels computes unread from read_states but carries no mention
	// count, so a DM mention badge used to vanish on every reconnect. The
	// unread map now includes the user's DM rows — pull mention_count from it.
	for i := range dmChannels {
		if u, ok := unreadMap[dmChannels[i].ChannelID]; ok {
			dmChannels[i].MentionCount = u.MentionCount
		}
	}
	// GetUserDMChannels only applies db.StatusForViewer, which collapses
	// invisible to offline but passes a disconnected recipient's saved
	// idle/dnd through verbatim (MarkUserDisconnected deliberately keeps a
	// chosen idle/dnd across a disconnect so the next connect can honour it,
	// relying on every read path to hide it in the meantime). members already
	// gets the "no live connection means offline" half of that rule from
	// presentableMembers above; apply the same half here so dm_channels
	// cannot disagree with members about the same user within one payload.
	dmChannels = h.presentableDMChannels(dmChannels)
	return dmChannels, nil
}

// readyVoiceStates gathers the voice states the ready payload may expose to
// this user. A collect failure is non-fatal, so this returns no error.
func (h *Hub) readyVoiceStates(ctx context.Context, database ReadySnapshotReader, channels []db.Channel, visibleChannels []db.Channel, dmChannels []db.DMChannelInfo, userID int64) []db.VoiceState {
	// Collect voice states, filtered to visible channels (BUG-095) plus the
	// user's own open DM channels — mirroring computeAllowedChannels, which
	// layers DM IDs onto the same checker result for reconnect replay
	// filtering. Without this, a DM voice call's voice_state rows are
	// structurally unreachable: VisibleChannelIDs skips ch.Type == "dm", and
	// nothing else re-adds them for this filter.
	allVoiceStates, err := collectAllVoiceStates(ctx, database, channels)
	if err != nil {
		// Non-fatal: send empty list rather than failing the whole ready payload.
		slog.Warn("buildReady collectAllVoiceStates", "err", err)
		allVoiceStates = []db.VoiceState{}
	}
	visibleSet := make(map[int64]struct{}, len(visibleChannels)+len(dmChannels)+1)
	for i := range visibleChannels {
		visibleSet[visibleChannels[i].ID] = struct{}{}
	}
	for i := range dmChannels {
		visibleSet[dmChannels[i].ChannelID] = struct{}{}
	}
	// The caller's own live voice room can never leak by definition -- seed it
	// even if it fell outside both sets above (e.g. CONNECT_VOICE granted
	// without READ_MESSAGES, or a DM voice call after the DM was closed:
	// CloseDM removes dm_open_state but performs no voice eviction). This
	// mirrors liveVoiceEventsSince's rationale on the reconnect-replay tier
	// (serve.go), which this full-ready tier had no equivalent for (OC-0028).
	for i := range allVoiceStates {
		if allVoiceStates[i].UserID == userID {
			visibleSet[allVoiceStates[i].ChannelID] = struct{}{}
		}
	}
	voiceStates := make([]db.VoiceState, 0, len(allVoiceStates))
	for i := range allVoiceStates {
		if _, ok := visibleSet[allVoiceStates[i].ChannelID]; ok {
			voiceStates = append(voiceStates, allVoiceStates[i])
		}
	}
	return voiceStates
}

// buildReady constructs the ready server→client message.
// Per docs/protocol.md, channels include unread_count and last_message_id per
// user plus the channelPayloadFrom fields (slow_mode, nsfw, voice_* caps);
// archived is the one stored field deliberately not shipped.
func (h *Hub) buildReady(ctx context.Context, database ReadySnapshotReader, userID int64, role *db.Role) ([]byte, error) {
	channels, err := database.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("buildReady ListChannels: %w", err)
	}
	roles, err := database.ListRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("buildReady ListRoles: %w", err)
	}

	members, err := database.ListMembers(ctx)
	if err != nil {
		return nil, fmt.Errorf("buildReady ListMembers: %w", err)
	}
	members = h.presentableMembers(members, userID)

	visibleChannels, overrides, err := h.readyVisibleChannels(ctx, database, userID, role, channels)
	if err != nil {
		return nil, err
	}

	// Per-user unread counts.
	unreadMap, err := database.GetChannelUnreadCounts(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("buildReady GetChannelUnreadCounts: %w", err)
	}

	// Build protocol-compliant channel objects (strip extra fields).
	channelPayloads := readyChannelPayloads(visibleChannels, overrides, unreadMap, role)

	// Load open DM channels for this user. Hoisted above the voice-state
	// filter below so DM channel IDs can seed visibleSet — permissions.Checker
	// (and therefore visibleChannels) deliberately skips DM channels, since
	// their visibility is membership-based rather than role-based, so without
	// this a DM voice call's voice_state rows would never make it into ready.
	dmChannels, err := h.readyDMChannels(ctx, database, userID, unreadMap)
	if err != nil {
		return nil, err
	}

	voiceStates := h.readyVoiceStates(ctx, database, channels, visibleChannels, dmChannels, userID)

	serverName, motd := h.getCachedSettings(ctx)

	return buildJSON(map[string]any{
		"type": MsgTypeReady,
		"payload": map[string]any{
			"channels":     channelPayloads,
			"members":      members,
			"voice_states": voiceStates,
			"roles":        roles,
			"dm_channels":  dmChannels,
			"server_name":  serverName,
			"motd":         motd,
		},
	}), nil
}

// collectAllVoiceStates gathers voice states across all channels in a single
// query, replacing the previous N+1 per-channel pattern.
func collectAllVoiceStates(ctx context.Context, database ReadySnapshotReader, _ []db.Channel) ([]db.VoiceState, error) {
	return database.GetAllVoiceStates(ctx)
}

func (h *Hub) handleFreshConnect(
	ctx context.Context, conn *websocket.Conn, c *Client, database ReadySnapshotReader,
) error {
	// Clean stale voice state BEFORE building ready and registering.
	// When a user F5-reloads while in voice, the DB row from the previous
	// session must be removed so the ready payload doesn't include it and
	// other clients see a voice_leave broadcast.
	if vs, err := h.readers.StaleVoice.GetVoiceState(ctx, c.userID); err == nil && vs != nil {
		h.freshConnectCleanStaleVoice(ctx, c, vs)
	}

	// c.user is the auth-time snapshot — re-read it so the ready payload and
	// any inherited subscriptions resolve from the user's CURRENT role, not
	// the one they held when the auth frame was evaluated (audit-2026-08-19
	// F-2; the resume path does the same in reconnectPrecheck). Fail closed
	// like the role lookup below.
	if err := h.refreshUserSnapshot(ctx, database, c); err != nil {
		slog.Error("ws: user re-read failed, disconnecting", "user_id", c.userID, "err", err)
		_ = conn.Close(websocket.StatusInternalError, "user lookup failed")
		return err
	}

	// Look up role for permission-filtered ready payload.
	// Fail closed: if the role lookup fails, disconnect rather than serving
	// a permissive ready payload with nil role (BUG-094).
	userRole, roleErr := database.GetRoleByID(ctx, c.user.RoleID)
	if roleErr != nil || userRole == nil {
		slog.Error("ws: role lookup failed, disconnecting", "user_id", c.userID, "role_id", c.user.RoleID, "err", roleErr)
		_ = conn.Close(websocket.StatusInternalError, "role lookup failed")
		return fmt.Errorf("role lookup failed for user %d: %w", c.userID, roleErr)
	}

	// Register BEFORE writing auth_ok + ready so broadcasts that arrive during
	// the write window are queued in the client's send buffer instead of
	// being lost (BUG-123). writePump hasn't started yet, so queued messages
	// will be drained once the pumps begin.
	//
	// Only the replay-failure fallback (lastSeq > 0) can inherit voice state
	// from the previous connection, so that is the only case where registerNow
	// needs the read-permission set. Fail closed on error: nil denies the
	// inherited voice-channel subscription.
	var allowedChannelIDs map[int64]bool
	if c.lastSeq > 0 {
		allowed, allowedErr := h.computeAllowedChannels(ctx, database, c.user)
		if allowedErr != nil {
			slog.Warn("ws handleFreshConnect: computeAllowedChannels failed, skipping voice channel subscription",
				"user_id", c.userID, "err", allowedErr)
		} else {
			allowedChannelIDs = allowed
		}
	}
	// handleReconnect may have promoted an auth-frame active_channel_id into
	// c.channelID (serve.go, honoured only when it was READ-visible at that
	// moment) and then aborted on one of its own re-checks — most notably the
	// final mustFullResync check, tripped by a permission revocation that
	// landed mid-handshake. None of those abort paths undo the c.channelID
	// write. registerNow subscribes c.channelID's ChannelTopic
	// unconditionally, so re-gate it here against the freshly recomputed
	// permission set before registering. Fail closed: a nil allowedChannelIDs
	// (lastSeq == 0, or the computeAllowedChannels error branch above) denies.
	if chID := c.getChannelID(); chID != 0 && !allowedChannelIDs[chID] {
		c.mu.Lock()
		c.channelID = 0
		c.mu.Unlock()
	}
	if freshConnectPreRegisterRaceHook != nil {
		freshConnectPreRegisterRaceHook()
	}
	h.registerNow(c, allowedChannelIDs)

	// The re-read above and registerNow are not atomic: a role reassignment
	// committing in between finds this socket absent from h.clients (so its
	// revokeUnreadableChannels pass early-returns) yet builds our inherited
	// subscriptions from the pre-change role. One PK re-read after
	// registration makes the two orderings meet: a commit visible here is
	// pruned by our own revoke pass, and a commit that is not yet visible
	// necessarily runs its own revoke lookup after our registerNow and
	// finds us.
	// Scoped to the resume-fallback path — a pure fresh connect (lastSeq==0)
	// inherits no subscriptions; channel_focus and voice_join re-check live.
	if c.lastSeq > 0 {
		if fresh, err := database.GetUserByID(ctx, c.userID); err != nil || fresh == nil || fresh.RoleID != c.user.RoleID {
			//nolint:contextcheck // revokeUnreadableChannels takes no context by design (admin HubBroadcaster interface).
			h.revokeUnreadableChannels(c.userID)
		}
	}

	// Settle the session's status before buildReady reads the member list, so
	// the ready payload and the presence broadcast below cannot disagree.
	applyConnectStatus(ctx, h.db, c)

	// Fresh connection or replay fallback: full auth_ok + ready flow.
	slog.Info("ws sending auth_ok", "user_id", c.userID, "username", c.user.Username, "role", c.roleName)
	if err := handshakeWrite(ctx, conn, h.buildAuthOK(ctx, c.user, c.roleName, "none")); err != nil {
		slog.Warn("ws: failed to send auth_ok", "user_id", c.userID, "err", err)
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return err
	}
	if ready, readyErr := h.buildReady(ctx, database, c.userID, userRole); readyErr == nil {
		slog.Info("ws sending ready payload", "user_id", c.userID, "payload_bytes", len(ready))
		if err := handshakeWrite(ctx, conn, ready); err != nil {
			slog.Warn("ws: failed to send ready payload", "user_id", c.userID, "err", err)
			h.unregisterFailedHandshake(ctx, c)
			_ = conn.Close(websocket.StatusInternalError, "handshake failed")
			return err
		}
	} else {
		slog.Error("buildReady failed", "user_id", c.userID, "err", readyErr)
		_ = handshakeWrite(ctx, conn, buildErrorMsg(ErrCodeInternal, "failed to build ready payload"))
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "failed to build ready payload")
		return readyErr
	}

	slog.Info("ws broadcasting member_join and presence", "user_id", c.userID, "username", c.user.Username)
	h.BroadcastToAll(buildMemberJoin(c.user, c.roleName))
	h.announceConnectPresence(c)

	return nil
}

// freshConnectCleanStaleVoice removes the voice state left behind by this
// user's previous session, unless that session is the still-registered
// connection this one is about to inherit from.
func (h *Hub) freshConnectCleanStaleVoice(ctx context.Context, c *Client, vs *db.VoiceState) {
	// Replay-failure fallback (lastSeq > 0): registerNow below transfers
	// the still-registered old connection's live voice state into this
	// client. Deleting the DB row here — and the LiveKit participant,
	// whose removal token is the very JoinedAt being transferred — would
	// leave the user "in voice" on the hub only: voice_join bounces off
	// ALREADY_JOINED and sweepStaleVoiceStates never heals
	// memory-without-row. Keep the row so ready stays consistent. If the
	// old client unregisters before registerNow runs, the transfer is
	// skipped and the next sweep reaps the then-truly-stale row.
	if old := h.GetClient(c.userID); c.lastSeq > 0 && old != nil && old.getVoiceChID() == vs.ChannelID {
		slog.Info("ws fresh connect: keeping voice state for replay-failure fallback",
			"user_id", c.userID, "channel_id", vs.ChannelID)
		return
	}
	slog.Info("ws fresh connect: cleaning stale voice state",
		"user_id", c.userID, "channel_id", vs.ChannelID)
	if _, delErr := h.readers.StaleVoice.LeaveVoiceChannelIfMatch(ctx, c.userID, vs.ChannelID, vs.JoinedAt); delErr != nil {
		slog.Warn("ws fresh connect: LeaveVoiceChannelIfMatch failed", "err", delErr)
	}
	// The DB row is gone, but the still-registered OLD *Client (if any) is
	// otherwise only cleared by registerNow — which two early-return paths
	// further down handleFreshConnect (the refreshUserSnapshot and
	// GetRoleByID failure branches) can skip entirely. Without this, that
	// old client's in-memory voiceChID and the E2EE key-holder election for
	// this room survive as a memory-without-row ghost that
	// sweepStaleVoiceStates can never see, since it iterates DB rows
	// (OC-0252). Clearing here makes freshConnectCleanStaleVoice self
	// sufficient regardless of whether registerNow ever runs; registerNow's
	// own replacedVoiceChID re-election later becomes a redundant no-op
	// (clearVoiceState finds nothing left to clear), not a conflict.
	if old := h.GetClient(c.userID); old != nil {
		if _, cleared := old.clearVoiceStateIfMatch(vs.ChannelID); cleared {
			h.pubsub.Unsubscribe(old, VoiceTopic(vs.ChannelID))
		}
	}
	h.updateKeyHolder(vs.ChannelID)
	h.broadcastVoiceEvent(ctx, vs.ChannelID, buildVoiceLeave(vs.ChannelID, c.userID))
	if h.livekit == nil {
		return
	}
	// BUG-089: Capture stale join token so the goroutine only removes
	// the exact stale participant. The identity includes joinedAt, so
	// even if the user rejoins voice quickly, the new session has a
	// different identity and won't be removed. The removal must
	// complete even if this connection drops mid-handshake, so detach
	// from cancellation (values kept); shutdown is handled via h.stop.
	staleChID, staleUserID, staleJoinToken := vs.ChannelID, c.userID, vs.JoinedAt
	lkCtx := context.WithoutCancel(ctx)
	go func() {
		select {
		case <-h.stop:
			return
		default:
		}
		if err := h.livekit.RemoveParticipant(lkCtx, staleChID, staleUserID, staleJoinToken); err != nil {
			slog.Warn("ws fresh connect: RemoveParticipant failed (may already be gone)",
				"err", err, "user_id", staleUserID, "channel_id", staleChID)
		}
	}()
}
