package ws

import (
	"context"
	"fmt"
	"iter"
	"log/slog"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// buildAuthOK constructs the auth_ok message. replaySource records the
// reconnection tier: "none" (fresh or full re-sync), "buffer" (ring buffer) or
// "db" (persistent EventStore).
func (h *Hub) buildAuthOK(ctx context.Context, user *db.User, roleName string, roleIDs []int64, replaySource string) []byte {
	var avatarVal any
	if user.Avatar != nil {
		avatarVal = *user.Avatar
	}

	serverName, motd := h.getCachedSettings(ctx)

	// Only the user's own auth_ok carries the expiry instant; an expired status the
	// expirer has not cleared yet is not handed back.
	customStatus, expiresAt := storedCustomStatus(user.CustomStatus, user.CustomStatusExpiresAt, time.Now())
	var expiresAtVal any
	if expiresAt != "" {
		expiresAtVal = expiresAt
	}

	return buildJSON(map[string]any{
		"type": MsgTypeAuthOK,
		"payload": map[string]any{
			"user": map[string]any{
				"id":                       user.ID,
				"username":                 user.Username,
				"avatar":                   avatarVal,
				"role":                     roleName,
				"role_ids":                 roleIDsOrEmpty(roleIDs),
				"display_name":             user.DisplayName,
				"about":                    user.About,
				"banner":                   user.BannerPath(),
				"banner_color":             user.BannerColor,
				"custom_status":            customStatus,
				"custom_status_expires_at": expiresAtVal,
				// Only their own auth_ok carries the true status (invisible included) so the
				// picker renders what they chose; every other client is told offline.
				"status": user.Status,
			},
			"server_name":   serverName,
			"motd":          motd,
			"replay_source": replaySource,
			"upload_policy": h.cachedUploadPolicy(ctx),
			// The runtime game activity switch. A resume gets no ready and the unsequenced
			// game_activity_policy frame is not replayed, so every auth_ok restores it.
			"game_activity_policy": gameActivityPolicyPayload{Enabled: h.settings.gameActivity.on.Load()},
			// The video upload cap, restored on every connect and resume for the same reason.
			"video_bitrate_cap": videoBitrateCapPayload{MaxVideoBitrate: h.videoBitrateCap()},
		},
	})
}

// presentableMembers rewrites each member's status into what viewerID may see.
// All rules live here so no payload builder can implement only one:
//
//  1. A member with no live connection is offline whatever the row says:
//     users.status keeps a chosen idle/dnd/invisible across a disconnect so the
//     next connect can honour it.
//  2. A connected member shows the status their connection last stamped, never the
//     row's: members comes from the shared read (readyMembers), which may predate
//     that write because users.status does not move the member generation. A
//     connection that has not stamped yet shows offline (its connect presence is
//     announced after the stamp, so the viewer converges). The live custom status
//     is a second guard: if the connection stamped a presence with none, the row's
//     text is stale (the expirer sends no null frame because the live text is
//     already nil), so it is blanked, as is one past its expiry.
//  3. An invisible member is offline to everyone but themselves
//     (db.StatusForViewer).
//
// It yields members[i] as presented, changing only Status and CustomStatus (the
// latter only to nil: writeReadyMembers splices exactly those into each cached
// encoding). members is shared with other ready payloads, so each element is
// copied, never changed in place.
func (h *Hub) presentableMembers(members []db.MemberSummary, viewerID int64) iter.Seq2[int, db.MemberSummary] {
	live := h.livePresences()
	now := time.Now()
	return func(yield func(int, db.MemberSummary) bool) {
		for i, m := range members {
			if lp := live[m.ID]; lp.status != "" {
				m.Status = lp.status
				m.Mobile = lp.mobile
				if visibleCustomStatus(lp.customStatus, lp.customStatusExpiresAt, now) == nil {
					// Only ever to nil (the splice contract); m is this iteration's copy.
					m.CustomStatus = nil
				}
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

// presentableDMChannels applies presentableMembers' rules to a DM list's recipient
// statuses so dm_channels cannot disagree with the members array. Both Recipient
// (legacy) and every Recipients entry are rewritten, since a 1:1 DM's Recipient is
// a copy of Recipients[0], not a shared reference.
func (h *Hub) presentableDMChannels(dmChannels []db.DMChannelInfo, viewerID int64) []db.DMChannelInfo {
	live := h.livePresences()
	dmChannels = presentDMStatuses(dmChannels, viewerID, func(id int64) string { return live[id].status })
	return presentDMMobile(dmChannels, func(id int64) bool { return live[id].mobile })
}

// presentDMMobile sets each recipient's phone flag from liveMobile, false for one
// who reads as offline. Run after presentDMStatuses, whose statuses it reads.
func presentDMMobile(dmChannels []db.DMChannelInfo, liveMobile func(userID int64) bool) []db.DMChannelInfo {
	for i := range dmChannels {
		ch := &dmChannels[i]
		ch.Recipient.Mobile = ch.Recipient.Status != db.StatusOffline && liveMobile(ch.Recipient.ID)
		for j := range ch.Recipients {
			r := &ch.Recipients[j]
			r.Mobile = r.Status != db.StatusOffline && liveMobile(r.ID)
		}
	}
	return dmChannels
}

// presentDMStatuses is presentableDMChannels over any live-status lookup ("" for
// no stamped connection), for a caller presenting a single DM.
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

// channelRefs maps db channels to the checker's db-agnostic ChannelRef.
func channelRefs(channels []db.Channel) []permissions.ChannelRef {
	refs := make([]permissions.ChannelRef, len(channels))
	for i := range channels {
		refs[i] = channelRef(&channels[i])
	}
	return refs
}

// readyAffordances resolves one ready channel's subject from the member's grants
// (OR of held roles, each role's override in that channel, and the member layer)
// and the caller's timeout verdict (resolved once per payload, administrators
// exempt), then asks affordancesFor. Zero grants fail closed.
func readyAffordances(grants permissions.MemberGrants, ch *db.Channel, timedOut bool) channelAffordances {
	sub := grants.Subject(ch.AuthorityID())
	sub.Channel = channelRef(ch)
	sub.TimedOut = timedOut
	return affordancesFor(sub)
}

// channelCanSend is the ready payload's can_send verdict; it delegates to affordancesFor.
func channelCanSend(grants permissions.MemberGrants, chanType string, timedOut bool) bool {
	return readyAffordances(grants, &db.Channel{Type: chanType}, timedOut).CanSend
}

// channelCanModerateVoice is the ready payload's can_moderate_voice verdict; it delegates to affordancesFor.
func channelCanModerateVoice(grants permissions.MemberGrants, chanType string) bool {
	return readyAffordances(grants, &db.Channel{Type: chanType}, false).CanModerateVoice
}

// channelRef maps one db channel to the predicates' db-agnostic ChannelRef.
func channelRef(ch *db.Channel) permissions.ChannelRef {
	return permissions.ChannelRef{ID: ch.ID, Type: ch.Type, Archived: ch.Archived, NSFW: ch.NSFW,
		AuthorityID: ch.Thread.ParentID, ThreadLocked: ch.Thread.Locked}
}

// readyVisibleChannels resolves the channels the user may see for the ready
// payload and returns the member grants it fetched so buildReady can reuse them
// for can_send. role is the member's effective role (top identity, OR of masks).
func (h *Hub) readyVisibleChannels(ctx context.Context, database ReadySnapshotReader, userID int64, role *db.Role, channels []db.Channel) ([]db.Channel, permissions.MemberGrants, error) {
	// Filter by READ_MESSAGES through the shared permissions.Checker predicate. DMs
	// are excluded by the checker and delivered via dm_channels.
	var grants permissions.MemberGrants
	if role != nil {
		grants.Perms = role.Permissions
		if !permissions.HasAdmin(role.Permissions) {
			var oErr error
			grants, oErr = database.GetMemberGrants(ctx, userID)
			if oErr != nil {
				return nil, permissions.MemberGrants{}, fmt.Errorf("buildReady GetMemberGrants: %w", oErr)
			}
			grants.Perms = role.Permissions
		}
	}
	var visibleChannels []db.Channel
	if role != nil {
		visibleIDs := h.permChecker.VisibleChannelIDs(grants, channelRefs(channels))
		for i := range channels {
			if visibleIDs[channels[i].ID] {
				visibleChannels = append(visibleChannels, channels[i])
			}
		}
	}
	if visibleChannels == nil {
		visibleChannels = []db.Channel{}
	}
	return visibleChannels, grants, nil
}

// readyThreads is ready.threads: the viewer's followed open threads whose parent is
// in visibleChannels (an NSFW parent only once acknowledged), newest activity
// first, capped at service.MaxFollowedThreads. A follow row for an unreadable
// parent stays in the table and is left out, so regaining the parent brings the
// thread back. nil (key omitted) when there is no thread service or the read
// fails, so the client keeps what it had instead of being told it follows nothing.
func (h *Hub) readyThreads(ctx context.Context, userID int64, visibleChannels []db.Channel, nsfwAck map[int64]bool) *[]readyThreadPayload {
	svc := h.threadHub.svc
	if svc == nil {
		return nil
	}
	readable := make(map[int64]struct{}, len(visibleChannels))
	for i := range visibleChannels {
		// A thread's name discloses its starter, so an unacknowledged NSFW parent lists
		// none of its threads, as thread_changed withholds them.
		if visibleChannels[i].NSFW && !nsfwAck[visibleChannels[i].ID] {
			continue
		}
		readable[visibleChannels[i].ID] = struct{}{}
	}
	followed, err := svc.Followed(ctx, userID, readable)
	if err != nil {
		slog.Warn("ws: ready followed threads read failed, omitting", "user_id", userID, "err", err)
		return nil
	}
	out := make([]readyThreadPayload, 0, len(followed))
	for i := range followed {
		f := &followed[i]
		out = append(out, readyThreadPayload{
			Thread: &f.Thread, LastMessageID: f.LastMessageID, LastReadMessageID: f.LastReadMessageID,
			UnreadCount: f.UnreadCount, MentionCount: f.MentionCount,
		})
	}
	return &out
}

// readyDMChannels loads the user's open DM channels and applies the same presence
// rule presentableMembers uses.
func (h *Hub) readyDMChannels(ctx context.Context, database ReadySnapshotReader, userID int64) ([]db.DMChannelInfo, error) {
	dmChannels, err := database.GetUserDMChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("buildReady GetUserDMChannels: %w", err)
	}
	// GetUserDMChannels reads users.status, which keeps a chosen idle/dnd across a
	// disconnect and trails a connect by the batched stamp; overlay the live status.
	dmChannels = h.presentableDMChannels(dmChannels, userID)
	return dmChannels, nil
}

// readyVoiceStates gathers the voice states the ready payload may expose to this
// user. A collect failure is non-fatal.
func (h *Hub) readyVoiceStates(ctx context.Context, database ReadySnapshotReader, visibleChannels []db.Channel, dmChannels []db.DMChannelInfo, userID int64) []db.VoiceState {
	// Filter to visible channels plus the user's open DMs, like computeAllowedChannels
	// does for replay; otherwise a DM voice call's rows are unreachable
	// (VisibleChannelIDs skips DMs).
	allVoiceStates, err := database.GetAllVoiceStates(ctx)
	if err != nil {
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
	// The caller's own live voice room can never leak, so seed it even if it fell
	// outside both sets (READ_MESSAGES revoked mid-call, or a DM call after the DM
	// closed: CloseDM removes dm_open_state but does no voice eviction). Mirrors
	// liveVoiceEventsSince on the replay tier.
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

// readyNSFWAcknowledgements resolves userID's acknowledgement for every labelled
// channel in visibleChannels (the per-channel nsfw_acknowledged field) from one
// read of the user's acknowledgements, skipped when no visible channel is
// labelled. A failed read reports every labelled channel as unacknowledged.
func readyNSFWAcknowledgements(ctx context.Context, database VisibilityReader, userID int64, visibleChannels []db.Channel) map[int64]bool {
	var acked map[int64]bool
	var ackMap map[int64]bool
	for i := range visibleChannels {
		if !visibleChannels[i].NSFW {
			continue
		}
		if acked == nil {
			var err error
			if acked, err = database.ListNSFWAcknowledgedChannelIDs(ctx, userID); err != nil {
				slog.Warn("ws: buildReady ListNSFWAcknowledgedChannelIDs failed, reporting unacknowledged",
					"user_id", userID, "err", err)
				return nil
			}
			ackMap = make(map[int64]bool)
		}
		ackMap[visibleChannels[i].ID] = acked[visibleChannels[i].ID]
	}
	return ackMap
}

// readReady reads everything the ready message carries (see docs/protocol.md).
// Channels include per-user unread_count and last_message_id plus the
// channelPayloadFrom fields; archived is the one stored field not shipped.
func (h *Hub) readReady(ctx context.Context, database ReadySnapshotReader, userID int64, role *db.Role, feat clientFeatures) (*readyFields, error) {
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

	visibleChannels, grants, err := h.readyVisibleChannels(ctx, database, userID, role, channels)
	if err != nil {
		return nil, err
	}

	unreadMap, err := database.GetChannelUnreadCounts(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("buildReady GetChannelUnreadCounts: %w", err)
	}

	// Resolve the current timeout verdict the same way (subjectFor) as
	// refreshChannelVisibilityAffordances, or a just-timed-out user's fresh-connect
	// ready would ship can_send: true until their next send bounces. Channel 0 is
	// fine: only TimedOut is consulted and subjectFor skips administrators. A lookup
	// failure fails the handshake closed.
	sub, err := h.subjectFor(ctx, userID, 0)
	if err != nil {
		return nil, fmt.Errorf("buildReady subjectFor: %w", err)
	}

	timeouts, err := h.readyMemberTimeouts(ctx, userID, sub)
	if err != nil {
		return nil, err
	}

	categories, err := h.readyCategories(ctx, database, sub)
	if err != nil {
		return nil, err
	}

	ackMap := readyNSFWAcknowledgements(ctx, database, userID, visibleChannels)
	// The lock is cosmetic: a failed read must not fail ready.
	privacy := h.privacySnapshot(ctx)
	channelPayloads := readyChannelPayloads(feat.filterChannels(visibleChannels), grants, unreadMap, ackMap, sub.TimedOut, privacy)

	// Hoisted above the voice-state filter so DM channel IDs can seed visibleSet:
	// permissions.Checker deliberately skips DMs (membership-based visibility), so
	// otherwise a DM voice call's rows would never reach ready.
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
	threads := h.readyThreads(ctx, userID, visibleChannels, ackMap)
	live := h.livePresences()
	return &readyFields{
		head: readyHead{
			Activities:   readyActivities(live, userID),
			Capabilities: readyCapabilities(retryFloorMS, h.threadHub.svc != nil, h.threadHub.svc != nil, h.settings.gameActivity.on.Load()),
			Categories:   categories,
			Channels:     channelPayloads,
			DMChannels:   dmChannels,
			Listening:    readyListening(live, userID),

			MemberTimeouts: timeouts.entries,
		},
		tail: readyTail{
			MOTD:        motd,
			Notices:     notices,
			Roles:       roles,
			ServerName:  serverName,
			Threads:     threads,
			VoiceStates: voiceStates,
		},
		roster:       roster,
		viewerID:     userID,
		timeoutsFull: timeouts.full,
	}, nil
}

// roleIDsOrEmpty is ids as a non-nil slice, so auth_ok.user.role_ids is always
// an array.
func roleIDsOrEmpty(ids []int64) []int64 {
	if ids == nil {
		return []int64{}
	}
	return ids
}

// sameRoleSet reports whether a and b name the same roles, whatever their
// order (a position change reorders a member's roles without changing them).
func sameRoleSet(a, b []int64) bool {
	return slices.Equal(slices.Sorted(slices.Values(a)), slices.Sorted(slices.Values(b)))
}
