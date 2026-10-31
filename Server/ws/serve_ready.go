package ws

import (
	"context"
	"fmt"
	"iter"
	"log/slog"
	"slices"
	"time"

	"github.com/coder/websocket"

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
			"game_activity_policy": gameActivityPolicyPayload{Enabled: h.gameActivity.on.Load()},
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
	for i := range dmChannels {
		ch := &dmChannels[i]
		ch.Recipient.Mobile = ch.Recipient.Status != db.StatusOffline && live[ch.Recipient.ID].mobile
		for j := range ch.Recipients {
			r := &ch.Recipients[j]
			r.Mobile = r.Status != db.StatusOffline && live[r.ID].mobile
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
// channel in visibleChannels (the per-channel nsfw_acknowledged field). Bounded by
// the labelled channels the caller can see, and skipped when none exist.
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
			Capabilities: readyCapabilities(retryFloorMS, h.threadHub.svc != nil, h.threadHub.svc != nil, h.gameActivity.on.Load()),
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

func (h *Hub) handleFreshConnect(ctx context.Context, conn *websocket.Conn, c *Client) error {
	// Bound concurrent ready builds. Taken before any handshake state change or
	// registration, so a waiting connect neither touches the database nor queues
	// broadcasts it cannot drain yet.
	release, admitted := h.admitReady(ctx)
	if !admitted {
		refuseBusy(ctx, conn, c)
		return fmt.Errorf("handleFreshConnect: ready builds saturated for user %d", c.userID)
	}
	defer release()
	// Use the configured seam, never a caller-supplied handle, so a service-backed or
	// instrumented Ready reader intercepts the snapshot reads below.
	database := h.readers.Ready
	h.freshConnectSettleVoice(ctx, c)

	// c.user is the auth-time snapshot; re-read it so the ready payload and inherited
	// subscriptions use the user's current role (as reconnectPrecheck does). Fail closed.
	if err := h.refreshUserSnapshot(ctx, database, c); err != nil {
		slog.Error("ws: user re-read failed, disconnecting", "user_id", c.userID, "err", err)
		_ = conn.Close(websocket.StatusInternalError, "user lookup failed")
		return err
	}

	// Fail closed: if the role lookup fails, disconnect rather than serve a permissive
	// ready with nil role. It is the same read refreshUserSnapshot just made, so
	// auth_ok.role_ids and ready permissions come from one snapshot.
	heldRoles := c.held
	if heldRoles == nil {
		slog.Error("ws: role lookup failed, disconnecting", "user_id", c.userID, "role_id", c.user.RoleID)
		_ = conn.Close(websocket.StatusInternalError, "role lookup failed")
		return fmt.Errorf("role lookup failed for user %d", c.userID)
	}
	// Top role identity with the OR of every held mask.
	userRole := heldRoles.Effective()

	// Register before writing auth_ok + ready so broadcasts during the write window
	// queue in the client's send buffer (writePump has not started; they drain later).
	allowedChannelIDs := h.gateResumeChannel(ctx, database, c)
	if freshConnectPreRegisterRaceHook != nil {
		freshConnectPreRegisterRaceHook()
	}
	txn := h.begin(c.userID)
	h.registerNow(c, allowedChannelIDs, txn)
	txn.end()

	// registerNow is the earliest point a revocation racing this handshake's DB work
	// could find this socket, so re-read the session now (postRegisterSessionRecheck).
	// On abort it already ran the failed-handshake teardown; only conn needs closing.
	if v := h.postRegisterSessionRecheck(ctx, c); v != postRegisterOK {
		closeAbortedHandshake(ctx, conn, v)
		return fmt.Errorf("handleFreshConnect: session revoked or user banned for user %d during handshake", c.userID)
	}

	// The re-read above and registerNow are not atomic: a role change committing in
	// between finds this socket absent from h.clients (its revokeUnreadableChannels
	// early-returns) yet builds our inherited subscriptions from the old role. One PK
	// re-read after registration makes the orderings meet: a commit visible here is
	// pruned by our own revoke pass, and one not yet visible runs its revoke lookup
	// after our registerNow and finds us. Scoped to the resume-fallback path: a pure
	// fresh connect inherits no subscriptions.
	if c.lastSeq > 0 {
		// Compared by the held-role set: adding or removing a non-top role changes what
		// they may read without moving the users.role_id mirror.
		if fresh, err := database.GetMemberRoles(ctx, c.userID); err != nil || fresh == nil || !sameRoleSet(fresh.IDs, heldRoles.IDs) {
			//nolint:contextcheck // revokeUnreadableChannels takes no context by design (admin HubBroadcaster interface).
			h.revokeUnreadableChannels(c.userID)
		}
	}

	// Settle the status before buildReady reads members so ready and the presence
	// broadcast cannot disagree.
	h.applyConnectStatus(ctx, c)

	slog.Info("ws sending auth_ok", "user_id", c.userID, "username", c.user.Username, "role", c.roleName)
	if err := handshakeWrite(ctx, conn, h.buildAuthOK(ctx, c.user, c.roleName, c.roleIDs, "none")); err != nil {
		slog.Warn("ws: failed to send auth_ok", "user_id", c.userID, "err", err)
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return err
	}
	// This ready carries every member's status, so it settles any presence resync owed.
	// Cleared before the build so a drop after it marks the user again; restored if
	// the ready never reaches the client.
	owedResync := h.takeOwedResync(c)
	ready, readyErr := h.buildFreshReady(ctx, database, c, userRole)
	release() // the write below is the peer's pace, not the database's
	if err := h.sendFreshReady(ctx, conn, c, ready, readyErr, owedResync); err != nil {
		return err
	}
	h.announceFreshConnect(c)

	return nil
}

// freshConnectSettleVoice runs a fresh connect's voice steps before ready is
// built, under the voice lock so the old socket's voice paths cannot interleave.
// The lock is released for the DB reads and retaken for registerNow; every row
// deleter also drops the grace entry, so the gap is safe.
func (h *Hub) freshConnectSettleVoice(ctx context.Context, c *Client) {
	txn := h.begin(c.userID)
	defer txn.end()
	// A fresh connect ends its own session's parked grace window (registerNow drops
	// it); a replay-failure fallback may inherit one only while its row exists.
	if c.lastSeq == 0 {
		txn.takeParkedOfSession(c.tokenHash) // another device's parked call stays parked
	} else {
		h.dropOrphanVoiceGrace(ctx, c.userID)
	}
	// Clean stale voice state before building ready: an F5 reload while in voice
	// leaves the previous session's row, which would show in ready and need a
	// voice_leave broadcast to other clients.
	if vs, err := h.voice.State(ctx, c.userID); err == nil && vs != nil {
		h.freshConnectCleanStaleVoice(ctx, txn, c, vs)
	}
}

// freshConnectCleanStaleVoice removes the voice state left by this user's previous
// session, unless that is the still-registered connection this one will inherit from.
func (h *Hub) freshConnectCleanStaleVoice(ctx context.Context, txn *voiceTxn, c *Client, vs *db.VoiceState) {
	// Replay-failure fallback (lastSeq > 0): registerNow transfers the
	// still-registered old connection's live voice state into this client. Deleting
	// the row (and the LiveKit participant, whose removal token is the JoinedAt being
	// transferred) would leave the user in voice on the hub only: voice_join bounces
	// off ALREADY_JOINED and sweepStaleVoiceStates never heals memory-without-row.
	// If the old client unregisters before registerNow, the next sweep reaps the row.
	//
	// The call belongs to another device when a live connection of a different
	// session holds it or that session parked it in the grace window. This connection
	// is only a new device (or a reload of another) and must not end it. A
	// same-session F5 falls through and cleans its own stale call.
	if h.voiceHeldByOtherSession(c, vs.ChannelID) {
		slog.Info("ws fresh connect: leaving another device's voice state",
			"user_id", c.userID, "channel_id", vs.ChannelID)
		return
	}
	if old := h.sessionClient(c.userID, c.tokenHash); c.lastSeq > 0 && old != nil && old.voice.channel() == vs.ChannelID {
		slog.Info("ws fresh connect: keeping voice state for replay-failure fallback",
			"user_id", c.userID, "channel_id", vs.ChannelID)
		return
	}
	// A replay-failure fallback whose previous socket parked this membership keeps
	// the row for registerNow to inherit (deleting it would leave an inherited state
	// with no row). Any other fresh connect or mismatched grace entry means the call
	// is over: stop the window so its timer cannot re-run finishVoiceLeave over a
	// cleaned row.
	if c.lastSeq > 0 && h.voiceReg.voiceGrace.has(c.userID, vs.ChannelID) {
		slog.Info("ws fresh connect: keeping graced voice state",
			"user_id", c.userID, "channel_id", vs.ChannelID)
		return
	}
	txn.takeParked(0) // same-session or unowned entry only: another session's returned above
	slog.Info("ws fresh connect: cleaning stale voice state",
		"user_id", c.userID, "channel_id", vs.ChannelID)
	if _, delErr := txn.deleteRow(ctx, vs.ChannelID, vs.JoinedAt); delErr != nil {
		slog.Warn("ws fresh connect: LeaveVoiceChannelIfMatch failed", "err", delErr)
	}
	// The still-registered old *Client (if any) is otherwise cleared only by
	// registerNow, which two early-return paths in handleFreshConnect can skip. Its
	// in-memory voiceChID and key-holder election would then survive as a
	// memory-without-row ghost sweepStaleVoiceStates cannot see (it iterates DB rows).
	// Clearing here keeps this function self-sufficient; registerNow's later
	// re-election becomes a redundant no-op.
	if old := h.sessionClient(c.userID, c.tokenHash); old != nil {
		txn.clearIfChannel(old, vs.ChannelID)
	}
	h.updateKeyHolder(vs.ChannelID)
	h.broadcastVoiceEvent(ctx, vs.ChannelID, c.userID, buildVoiceLeave(vs.ChannelID, c.userID))
	// Pass the stale join token so removal hits only that participant: the identity
	// includes joinedAt, so a quick rejoin's new session is not removed.
	h.removeLiveKitParticipantAsync(ctx, vs.ChannelID, c.userID, vs.JoinedAt, "ws fresh connect:")
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
