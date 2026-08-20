package ws

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
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
		out[id] = permissions.ChannelOverride{
			Allow:     o.Allow,
			Deny:      o.Deny,
			UserAllow: o.UserAllow,
			UserDeny:  o.UserDeny,
		}
	}
	return out
}

// channelCanSend reports whether a user with the given role and per-channel
// override may post in a channel of chanType. It mirrors the non-DM branch of
// MessageService.checkSendPermission so the client can pre-disable the composer
// without a round-trip; the server still enforces the rule authoritatively.
func channelCanSend(role *db.Role, o db.ChannelOverride, chanType string) bool {
	if role == nil {
		return false
	}
	if permissions.HasAdmin(role.Permissions) {
		return true
	}
	eff := permissions.EffectiveChannelPerms(role.Permissions, permissions.ChannelOverride{
		Allow: o.Allow, Deny: o.Deny, UserAllow: o.UserAllow, UserDeny: o.UserDeny,
	})
	need := permissions.ReadMessages | permissions.SendMessages
	if eff&need != need {
		return false
	}
	if chanType == "announcement" {
		return eff&permissions.ManageMessages == permissions.ManageMessages
	}
	return true
}

// readyVisibleChannels resolves the channels the user may see for the ready
// payload, returning the per-channel override map it fetched alongside them so
// buildReady can reuse it for the can_send affordance without a second query.
func (h *Hub) readyVisibleChannels(ctx context.Context, database *db.DB, userID int64, role *db.Role, channels []db.Channel) ([]db.Channel, map[int64]db.ChannelOverride, error) {
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
func (h *Hub) readyDMChannels(ctx context.Context, database *db.DB, userID int64, unreadMap map[int64]db.ChannelUnread) ([]db.DMChannelInfo, error) {
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
func (h *Hub) readyVoiceStates(ctx context.Context, database *db.DB, channels []db.Channel, visibleChannels []db.Channel, dmChannels []db.DMChannelInfo, userID int64) []db.VoiceState {
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
func (h *Hub) buildReady(ctx context.Context, database *db.DB, userID int64, role *db.Role) ([]byte, error) {
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
func collectAllVoiceStates(ctx context.Context, database *db.DB, _ []db.Channel) ([]db.VoiceState, error) {
	return database.GetAllVoiceStates(ctx)
}
