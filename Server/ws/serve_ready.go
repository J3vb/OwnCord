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
			},
			"server_name":   serverName,
			"motd":          motd,
			"replay_source": replaySource,
		},
	})
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

// permOverrides maps a db override map to the checker's override map.
func permOverrides(overrides map[int64]db.ChannelOverride) map[int64]permissions.ChannelOverride {
	out := make(map[int64]permissions.ChannelOverride, len(overrides))
	for id, o := range overrides {
		out[id] = permissions.ChannelOverride{Allow: o.Allow, Deny: o.Deny}
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
	eff := permissions.EffectivePerms(role.Permissions, o.Allow, o.Deny)
	need := permissions.ReadMessages | permissions.SendMessages
	if eff&need != need {
		return false
	}
	if chanType == "announcement" {
		return eff&permissions.ManageMessages == permissions.ManageMessages
	}
	return true
}

// buildReady constructs the ready server→client message.
// Per PROTOCOL.md, channels include unread_count and last_message_id per user,
// and only protocol-specified fields (no slow_mode, archived, voice_* extras).
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
		slog.Warn("buildReady ListMembers", "err", err)
		members = []db.MemberSummary{}
	}

	// Filter channels by READ_MESSAGES through the single permissions.Checker
	// predicate shared with REST ListVisibleChannels and reconnect replay
	// filtering (computeAllowedChannels). The overrides map is fetched once and
	// reused below for the per-channel can_send affordance. DM channels are
	// excluded by the checker — they are delivered via the dm_channels field.
	overrides := map[int64]db.ChannelOverride{}
	if role != nil && !permissions.HasAdmin(role.Permissions) {
		var oErr error
		overrides, oErr = database.GetAllChannelPermissionsForRole(ctx, role.ID)
		if oErr != nil {
			return nil, fmt.Errorf("buildReady GetAllChannelPermissionsForRole: %w", oErr)
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

	// Per-user unread counts.
	unreadMap, err := database.GetChannelUnreadCounts(ctx, userID)
	if err != nil {
		slog.Warn("buildReady GetChannelUnreadCounts", "err", err)
		unreadMap = map[int64]db.ChannelUnread{}
	}

	// Build protocol-compliant channel objects (strip extra fields).
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

	// Collect voice states, filtered to only visible channels (BUG-095).
	allVoiceStates, err := collectAllVoiceStates(ctx, database, channels)
	if err != nil {
		// Non-fatal: send empty list rather than failing the whole ready payload.
		slog.Warn("buildReady collectAllVoiceStates", "err", err)
		allVoiceStates = []db.VoiceState{}
	}
	visibleSet := make(map[int64]struct{}, len(visibleChannels))
	for i := range visibleChannels {
		visibleSet[visibleChannels[i].ID] = struct{}{}
	}
	voiceStates := make([]db.VoiceState, 0, len(allVoiceStates))
	for i := range allVoiceStates {
		if _, ok := visibleSet[allVoiceStates[i].ChannelID]; ok {
			voiceStates = append(voiceStates, allVoiceStates[i])
		}
	}

	// Load open DM channels for this user.
	dmChannels, err := database.GetUserDMChannels(ctx, userID)
	if err != nil {
		slog.Warn("buildReady GetUserDMChannels", "err", err)
		dmChannels = []db.DMChannelInfo{}
	}

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
