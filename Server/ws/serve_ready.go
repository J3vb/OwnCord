package ws

import (
	"context"
	"fmt"
	"iter"
	"log/slog"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
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
			"upload_policy": h.cachedUploadPolicy(ctx),
		},
	})
}

// presentableMembers rewrites each member's status into what viewerID may see.
//
// Three rules, all applied here so no payload builder can implement only one:
//
//  1. A member with no live connection is offline, whatever the row says.
//     users.status keeps a *chosen* idle/dnd/invisible across a disconnect so
//     the next connect can honour it, which would otherwise leave a signed-out
//     user showing as "Do Not Disturb" indefinitely.
//  2. A connected member shows the status their connection last stamped or
//     chose, never the row's: members comes from the shared read
//     (readyMembers), which may predate that write, since users.status does
//     not move the member generation. A connection that has not stamped one
//     yet shows as offline, like no connection; its connect presence is
//     announced after the stamp, so the viewer still converges.
//  3. An invisible member is offline to everyone but themselves
//     (db.StatusForViewer). The owner keeps their true state so their own
//     picker renders the status they actually chose.
//
// It yields members[i] as presented at index i, and changes only Status and
// CustomStatus, the latter only to nil: writeReadyMembers splices exactly
// those two into each member's cached encoding. members is shared with other
// ready payloads: each element is copied, never changed in place.
func (h *Hub) presentableMembers(members []db.MemberSummary, viewerID int64) iter.Seq2[int, db.MemberSummary] {
	live := h.livePresences()
	return func(yield func(int, db.MemberSummary) bool) {
		for i, m := range members {
			if status := live[m.ID].status; status != "" {
				m.Status = status
			} else {
				m.Status = db.StatusOffline
				m.CustomStatus = nil
			}
			if !yield(i, m.ForViewer(viewerID)) {
				return
			}
		}
	}
}

// presentableDMChannels applies presentableMembers' rules to a DM channel
// list's recipient statuses, so dm_channels cannot disagree with the members
// array about the same user: a recipient with no live connection (or one not
// yet stamped) is offline, a connected one shows their live status rather
// than the users.status row (whose connect stamp may still be pending), and
// db.StatusForViewer hides an invisible recipient from the viewer. Both
// Recipient (the legacy single-recipient field) and every entry of
// Recipients (the group-aware field) are rewritten, since a 1:1 DM's
// Recipient is a copy of Recipients[0], not a shared reference.
func (h *Hub) presentableDMChannels(dmChannels []db.DMChannelInfo, viewerID int64) []db.DMChannelInfo {
	live := h.liveStatuses()
	return presentDMStatuses(dmChannels, viewerID, func(id int64) string { return live[id] })
}

// presentDMStatuses is presentableDMChannels over any live-status lookup
// ("" for no stamped connection), for a caller that presents a single DM and
// need not snapshot every connection.
func presentDMStatuses(dmChannels []db.DMChannelInfo, viewerID int64, liveStatus func(userID int64) string) []db.DMChannelInfo {
	status := func(id int64) string {
		if s := liveStatus(id); s != "" {
			return db.StatusForViewer(s, id, viewerID)
		}
		return db.StatusOffline
	}
	for i := range dmChannels {
		ch := &dmChannels[i]
		if ch.Recipient.ID != 0 {
			ch.Recipient.Status = status(ch.Recipient.ID)
		}
		for j := range ch.Recipients {
			r := &ch.Recipients[j]
			r.Status = status(r.ID)
		}
	}
	return dmChannels
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
//
// timedOut is the caller's current timeout verdict (via subjectFor),
// threaded through as a plain bool so the lookup happens once per ready
// payload instead of once per channel — a timed-out user must not see
// can_send: true anywhere (OC-0434).
func channelCanSend(role *db.Role, o db.ChannelOverride, chanType string, timedOut bool) bool {
	if role == nil {
		return false
	}
	return permissions.CanSendMessage(permissions.Subject{
		RolePerms: role.Permissions,
		Override:  permOverride(o),
		Channel:   permissions.ChannelRef{Type: chanType},
		TimedOut:  timedOut,
	}) == nil
}

// channelCanModerateVoice is the ready payload's can_moderate_voice
// affordance (B9 Q5): whether the caller may mute, deafen, move or
// disconnect voice participants in this channel. It is
// permissions.AuthorizeVoiceModerator — the one authorizer voiceModTarget
// enforces in the target's channel (base MUTE_MEMBERS, then effective
// READ|MUTE_MEMBERS after both override layers, i.e. CanModerateVoice) — so
// the client's controls follow the effective permission, not the base bit.
// Target rank and move capacity are per-target and stay server-side refusals.
func channelCanModerateVoice(role *db.Role, o db.ChannelOverride, chanType string) bool {
	if role == nil {
		return false
	}
	return permissions.AuthorizeVoiceModerator(permissions.Subject{
		RolePerms: role.Permissions,
		Override:  permOverride(o),
		Channel:   permissions.ChannelRef{Type: chanType},
	}) == nil
}

// channelRef maps one db channel to the predicates' db-agnostic ChannelRef.
func channelRef(ch *db.Channel) permissions.ChannelRef {
	return permissions.ChannelRef{ID: ch.ID, Type: ch.Type, Archived: ch.Archived, NSFW: ch.NSFW}
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
// per visible channel, with the per-user unread fields folded in. ackMap
// carries the caller's own acknowledgement per NSFW-labelled channel id
// (readyNSFWAcknowledgements); a missing entry (an unlabelled channel never
// gets one) reads as false, which is correct either way — nothing needs
// acknowledging there. timedOut is the caller's current timeout verdict,
// fed into every channel's can_send — see channelCanSend (OC-0434).
func readyChannelPayloads(visibleChannels []db.Channel, overrides map[int64]db.ChannelOverride, unreadMap map[int64]db.ChannelUnread, role *db.Role, ackMap map[int64]bool, timedOut bool) []map[string]any {
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
			"can_send": channelCanSend(role, overrides[visibleChannels[i].ID], visibleChannels[i].Type, timedOut),
			// Voice-moderation affordance (B9 Q5), same shape and refresh
			// path as can_send — see channelCanModerateVoice.
			"can_moderate_voice": channelCanModerateVoice(role, overrides[visibleChannels[i].ID], visibleChannels[i].Type),
			// Cooldown in seconds (0 = off). Lets the composer disable itself
			// for the window instead of accepting a send the server refuses
			// with SLOW_MODE. The server still enforces.
			"slow_mode": visibleChannels[i].SlowMode,
			// Age-gate flag. The server enforces content behaviour on a
			// flagged channel now (B5-7, permissions.CanReadContent); see
			// nsfw_acknowledged below for the caller's own consent state.
			"nsfw": visibleChannels[i].NSFW,
			// Whether THIS caller has acknowledged the label (B5-7). Always
			// present, like nsfw itself — false for an unlabelled channel,
			// where it means nothing but must not be omitted (two different
			// meanings for "absent" is exactly what B5-7's other always-shipped
			// fields avoid).
			"nsfw_acknowledged": ackMap[visibleChannels[i].ID],
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
// the rest of the ready payload: the same presence rule presentableMembers
// applies to the members array.
func (h *Hub) readyDMChannels(ctx context.Context, database ReadySnapshotReader, userID int64) ([]db.DMChannelInfo, error) {
	dmChannels, err := database.GetUserDMChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("buildReady GetUserDMChannels: %w", err)
	}
	// GetUserDMChannels reads users.status, which keeps a chosen idle/dnd
	// across a disconnect and trails a connect by the batched stamp; overlay
	// the live status the members array uses so the two cannot disagree.
	dmChannels = h.presentableDMChannels(dmChannels, userID)
	return dmChannels, nil
}

// readyVoiceStates gathers the voice states the ready payload may expose to
// this user. A collect failure is non-fatal, so this returns no error.
func (h *Hub) readyVoiceStates(ctx context.Context, database ReadySnapshotReader, visibleChannels []db.Channel, dmChannels []db.DMChannelInfo, userID int64) []db.VoiceState {
	// Collect voice states, filtered to visible channels (BUG-095) plus the
	// user's own open DM channels — mirroring computeAllowedChannels, which
	// layers DM IDs onto the same checker result for reconnect replay
	// filtering. Without this, a DM voice call's voice_state rows are
	// structurally unreachable: VisibleChannelIDs skips ch.Type == "dm", and
	// nothing else re-adds them for this filter.
	allVoiceStates, err := database.GetAllVoiceStates(ctx)
	if err != nil {
		// Non-fatal: send empty list rather than failing the whole ready payload.
		slog.Warn("buildReady GetAllVoiceStates", "err", err)
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
	// even if it fell outside both sets above (e.g. READ_MESSAGES revoked
	// mid-call, or a DM voice call after the DM was closed:
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

// readyNSFWAcknowledgements resolves userID's acknowledgement for every
// LABELLED channel in visibleChannels — the ready payload's per-channel
// nsfw_acknowledged field (B5-7). Bounded by how many labelled channels the
// caller can see (typically zero), not by the full channel list, and skipped
// entirely when none are labelled: an unflagged deployment pays nothing.
func readyNSFWAcknowledgements(ctx context.Context, database VisibilityReader, userID int64, visibleChannels []db.Channel) map[int64]bool {
	var ackMap map[int64]bool
	for i := range visibleChannels {
		if !visibleChannels[i].NSFW {
			continue
		}
		ok, err := database.HasNSFWAcknowledgement(ctx, userID, visibleChannels[i].ID)
		if err != nil {
			slog.Warn("ws: buildReady HasNSFWAcknowledgement failed, reporting unacknowledged",
				"user_id", userID, "channel_id", visibleChannels[i].ID, "err", err)
			continue
		}
		if ackMap == nil {
			ackMap = make(map[int64]bool)
		}
		ackMap[visibleChannels[i].ID] = ok
	}
	return ackMap
}

// readReady reads everything the ready server→client message carries.
// Per docs/protocol.md, channels include unread_count and last_message_id per
// user plus the channelPayloadFrom fields (slow_mode, nsfw, voice_* caps);
// archived is the one stored field deliberately not shipped.
func (h *Hub) readReady(ctx context.Context, database ReadySnapshotReader, userID int64, role *db.Role) (*readyFields, error) {
	channels, err := database.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("buildReady ListChannels: %w", err)
	}
	roles, err := database.ListRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("buildReady ListRoles: %w", err)
	}

	roster, err := h.readyMembers(ctx, database)
	if err != nil {
		return nil, fmt.Errorf("buildReady ListMembers: %w", err)
	}

	visibleChannels, overrides, err := h.readyVisibleChannels(ctx, database, userID, role, channels)
	if err != nil {
		return nil, err
	}

	// Per-user unread counts.
	unreadMap, err := database.GetChannelUnreadCounts(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("buildReady GetChannelUnreadCounts: %w", err)
	}

	// Current timeout verdict (OC-0434): channelCanSend's Subject must
	// carry the same TimedOut refreshChannelVisibilityAffordances resolves for a
	// live socket (via the identical subjectFor), or a just-timed-out user's
	// fresh-connect ready payload ships can_send: true on every channel right
	// up until their next send bounces off TIMED_OUT. Channel 0 is fine here:
	// only TimedOut is consulted below, and subjectFor already skips the
	// lookup entirely for an administrator. A lookup failure fails the whole
	// handshake closed, like every other buildReady read.
	sub, err := h.subjectFor(ctx, userID, 0)
	if err != nil {
		return nil, fmt.Errorf("buildReady subjectFor: %w", err)
	}

	// Build protocol-compliant channel objects (strip extra fields).
	ackMap := readyNSFWAcknowledgements(ctx, database, userID, visibleChannels)
	channelPayloads := readyChannelPayloads(visibleChannels, overrides, unreadMap, role, ackMap, sub.TimedOut)

	// Load open DM channels for this user. Hoisted above the voice-state
	// filter below so DM channel IDs can seed visibleSet — permissions.Checker
	// (and therefore visibleChannels) deliberately skips DM channels, since
	// their visibility is membership-based rather than role-based, so without
	// this a DM voice call's voice_state rows would never make it into ready.
	dmChannels, err := h.readyDMChannels(ctx, database, userID)
	if err != nil {
		return nil, err
	}

	voiceStates := h.readyVoiceStates(ctx, database, visibleChannels, dmChannels, userID)

	serverName, motd := h.getCachedSettings(ctx)

	notices, err := readyNotices(ctx, database, userID)
	if err != nil {
		return nil, fmt.Errorf("buildReady ListUnacknowledgedWarnings: %w", err)
	}
	retryFloorMS := int64(0)
	if h.db != nil {
		retryFloorMS = h.readers.Ready.MessageDeliveryFloorMS()
	}

	return &readyFields{
		head: readyHead{
			Capabilities: map[string]any{
				"message_deduplication":        true,
				"message_retry_window_seconds": int64(service.MessageRetryWindow.Seconds()),
				"message_retry_floor_ms":       retryFloorMS,
			},
			Channels:   channelPayloads,
			DMChannels: dmChannels,
		},
		tail: readyTail{
			MOTD:        motd,
			Notices:     notices,
			Roles:       roles,
			ServerName:  serverName,
			VoiceStates: voiceStates,
		},
		roster:   roster,
		viewerID: userID,
	}, nil
}

// readyNoticePayload is one row of ready's notices slot (B5-9): an
// unacknowledged warning. Never the actor, never the report link.
type readyNoticePayload struct {
	ID        int64  `json:"id"`
	Kind      string `json:"kind"`
	Reason    string `json:"reason"`
	CreatedAt string `json:"created_at"`
}

// readyNotices resolves the connecting user's unacknowledged warnings for
// ready's notices slot, always as a non-nil (possibly empty) slice so the
// wire payload never carries a bare `null`.
func readyNotices(ctx context.Context, database ReadySnapshotReader, userID int64) ([]readyNoticePayload, error) {
	rows, err := database.ListUnacknowledgedWarnings(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]readyNoticePayload, 0, len(rows))
	for _, r := range rows {
		out = append(out, readyNoticePayload{ID: r.ID, Kind: r.Kind, Reason: r.Reason, CreatedAt: r.CreatedAt})
	}
	return out, nil
}

func (h *Hub) handleFreshConnect(ctx context.Context, conn *websocket.Conn, c *Client) error {
	// U4: refuse a wake reconnect before ANY handshake state change — most
	// importantly before the grace take and freshConnectCleanStaleVoice below,
	// which would end the other device's live or parked call. registerNow
	// re-checks atomically below.
	if h.wakeBlocked(c) {
		refuseWake(ctx, conn, c)
		return fmt.Errorf("handleFreshConnect: wake refused for user %d", c.userID)
	}
	// The configured seam, never a caller-supplied handle: binding here is what
	// lets a service-backed or instrumented Ready reader actually intercept the
	// snapshot reads below — same posture as freshConnectCleanStaleVoice's
	// own read through the voice service.
	database := h.readers.Ready
	// RT-8: a fresh connect ends any parked grace window (registerNow drops
	// it); a replay-failure fallback may inherit one only while its row
	// still exists.
	if c.lastSeq == 0 {
		h.voiceGrace.take(c.userID)
	} else {
		h.dropOrphanVoiceGrace(ctx, c.userID)
	}
	// Clean stale voice state BEFORE building ready and registering.
	// When a user F5-reloads while in voice, the DB row from the previous
	// session must be removed so the ready payload doesn't include it and
	// other clients see a voice_leave broadcast.
	if vs, err := h.voice.State(ctx, c.userID); err == nil && vs != nil {
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
	allowedChannelIDs := h.gateResumeChannel(ctx, database, c)
	if freshConnectPreRegisterRaceHook != nil {
		freshConnectPreRegisterRaceHook()
	}
	// U4: an atomic re-check under h.mu. A device connecting between the check
	// above and here would otherwise be displaced; refuse instead.
	if h.registerNow(c, allowedChannelIDs) {
		refuseWake(ctx, conn, c)
		return fmt.Errorf("handleFreshConnect: wake refused for user %d", c.userID)
	}

	// OC-0423: registerNow just above is the earliest point a revocation
	// racing this handshake's DB work could have found this socket, so
	// re-read the session now that c is reachable — see
	// postRegisterSessionRecheck's doc. When it reports true it has already
	// run the full failed-handshake teardown; only closing conn is left.
	if h.postRegisterSessionRecheck(ctx, c) {
		_ = conn.Close(websocket.StatusPolicyViolation, "session revoked")
		return fmt.Errorf("handleFreshConnect: session revoked for user %d during handshake", c.userID)
	}

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
	h.applyConnectStatus(ctx, c)

	// Fresh connection or replay fallback: full auth_ok + ready flow.
	slog.Info("ws sending auth_ok", "user_id", c.userID, "username", c.user.Username, "role", c.roleName)
	if err := handshakeWrite(ctx, conn, h.buildAuthOK(ctx, c.user, c.roleName, "none")); err != nil {
		slog.Warn("ws: failed to send auth_ok", "user_id", c.userID, "err", err)
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return err
	}
	// This ready carries every member's status, so it settles any presence
	// resync owed (P5-S03). Cleared before the build, so a drop after it
	// marks the user again; restored if the ready never reaches the client.
	owedResync := h.setPresenceResync(c.userID, false)
	if ready, readyErr := h.buildReady(ctx, database, c.userID, userRole); readyErr == nil {
		n, err := h.handshakeWriteReady(ctx, conn, ready)
		if err != nil {
			slog.Warn("ws: failed to send ready payload", "user_id", c.userID, "err", err)
			if owedResync {
				h.setPresenceResync(c.userID, true)
			}
			h.unregisterFailedHandshake(ctx, c)
			_ = conn.Close(websocket.StatusInternalError, "handshake failed")
			return err
		}
		slog.Info("ws sent ready payload", "user_id", c.userID, "payload_bytes", n)
	} else {
		slog.Error("buildReady failed", "user_id", c.userID, "err", readyErr)
		if owedResync {
			h.setPresenceResync(c.userID, true)
		}
		_ = handshakeWrite(ctx, conn, buildErrorMsg(ErrCodeInternal, "failed to build ready payload"))
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "failed to build ready payload")
		return readyErr
	}

	h.announceFreshConnect(c)

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
	// RT-8: a replay-failure fallback whose previous socket parked this
	// membership in the grace window keeps the row for registerNow to inherit
	// (deleting it would leave an inherited state with no row — the ghost
	// OC-0270 closes for the still-registered case). Any other fresh connect or
	// mismatched grace entry means the call is over: stop the window so its
	// timer cannot later re-run finishVoiceLeave over a cleaned row.
	if c.lastSeq > 0 && h.voiceGrace.has(c.userID, vs.ChannelID) {
		slog.Info("ws fresh connect: keeping graced voice state",
			"user_id", c.userID, "channel_id", vs.ChannelID)
		return
	}
	h.voiceGrace.take(c.userID)
	slog.Info("ws fresh connect: cleaning stale voice state",
		"user_id", c.userID, "channel_id", vs.ChannelID)
	if _, delErr := h.voice.LeaveIfMatch(ctx, c.userID, vs.ChannelID, vs.JoinedAt); delErr != nil {
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
	h.broadcastVoiceEvent(ctx, vs.ChannelID, c.userID, buildVoiceLeave(vs.ChannelID, c.userID))
	// BUG-089: pass the stale join token so the removal only hits the exact
	// stale participant — the identity includes joinedAt, so a quick rejoin's
	// new session has a different identity and won't be removed.
	h.removeLiveKitParticipantAsync(ctx, vs.ChannelID, c.userID, vs.JoinedAt, "ws fresh connect:")
}
