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

// buildAuthOK constructs the auth_ok server→client message.
// Per PROTOCOL.md, user object contains only id, username, avatar, role (no status).
//
// replaySource records which reconnection tier served this client:
//   - "none"   — fresh connection or full re-sync (no resume)
//   - "buffer" — resume served from the in-memory ring buffer
//   - "db"     — resume served from the persistent EventStore (Phase B Step 7)
func (h *Hub) buildAuthOK(ctx context.Context, user *db.User, roleName string, roleIDs []int64, replaySource string) []byte {
	var avatarVal any
	if user.Avatar != nil {
		avatarVal = *user.Avatar
	}

	serverName, motd := h.getCachedSettings(ctx)

	// Only the user's own auth_ok carries the expiry instant; everyone else is
	// told the status went to null. Both fields are guarded together, so an
	// expired status the expirer has not cleared yet is not handed back.
	customStatus, expiresAt := storedCustomStatus(user.CustomStatus, user.CustomStatusExpiresAt, time.Now())
	var expiresAtVal any
	if expiresAt != "" {
		expiresAtVal = expiresAt
	}

	return buildJSON(map[string]any{
		"type": MsgTypeAuthOK,
		"payload": map[string]any{
			"user": map[string]any{
				"id":       user.ID,
				"username": user.Username,
				"avatar":   avatarVal,
				"role":     roleName,
				// Every held role, top first; role is the top's name.
				"role_ids": roleIDsOrEmpty(roleIDs),
				// The signed-in user's own profile fields. Null when unset;
				// display_name falls back to username client-side, and about
				// is what the "edit my profile" form pre-fills from.
				"display_name":  user.DisplayName,
				"about":         user.About,
				"banner":        user.BannerPath(),
				"banner_color":  user.BannerColor,
				"custom_status": customStatus,
				// RFC 3339 instant the custom status clears itself, or null.
				"custom_status_expires_at": expiresAtVal,
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
			// the runtime game activity switch. A resume gets no
			// ready, and the unsequenced game_activity_policy frame is not
			// replayed, so every auth_ok restores the state.
			"game_activity_policy": gameActivityPolicyPayload{Enabled: h.gameActivity.on.Load()},
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
//     announced after the stamp, so the viewer still converges. The live
//     custom status is a second guard: when the connection stamped a presence
//     with no custom status, the row's text is stale (a reconnect, resume or
//     bare status flip cleared it live up to a second before the expirer
//     clears the row, and the expirer then sends no null frame because the
//     live text is already nil), so it is blanked here. A live status past
//     its expiry is blanked too, for the second before the expirer clears it.
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
	now := time.Now()
	return func(yield func(int, db.MemberSummary) bool) {
		for i, m := range members {
			if lp := live[m.ID]; lp.status != "" {
				m.Status = lp.status
				if visibleCustomStatus(lp.customStatus, lp.customStatusExpiresAt, now) == nil {
					// Only ever to nil: the splice contract, and the shared
					// encoded roster is untouched (m is this iteration's copy).
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
	live := h.livePresences()
	return presentDMStatuses(dmChannels, viewerID, func(id int64) string { return live[id].status })
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
		refs[i] = channelRef(&channels[i])
	}
	return refs
}

// readyAffordances resolves one ready channel's subject from the member's
// grants (the OR of their held roles, every held role's override in that
// channel and the member layer) and the caller's timeout verdict (resolved
// once per payload via subjectFor, administrators exempt), then asks
// affordancesFor. Zero grants fail closed to all false.
func readyAffordances(grants permissions.MemberGrants, ch *db.Channel, timedOut bool) channelAffordances {
	sub := grants.Subject(ch.AuthorityID())
	sub.Channel = channelRef(ch)
	sub.TimedOut = timedOut
	return affordancesFor(sub)
}

// channelCanSend is the ready payload's can_send verdict for a member's grants
// and channel type; a one-line delegation to affordancesFor.
func channelCanSend(grants permissions.MemberGrants, chanType string, timedOut bool) bool {
	return readyAffordances(grants, &db.Channel{Type: chanType}, timedOut).CanSend
}

// channelCanModerateVoice is the ready payload's can_moderate_voice verdict
// (B9 Q5); a one-line delegation to affordancesFor.
func channelCanModerateVoice(grants permissions.MemberGrants, chanType string) bool {
	return readyAffordances(grants, &db.Channel{Type: chanType}, false).CanModerateVoice
}

// channelRef maps one db channel to the predicates' db-agnostic ChannelRef.
func channelRef(ch *db.Channel) permissions.ChannelRef {
	return permissions.ChannelRef{ID: ch.ID, Type: ch.Type, Archived: ch.Archived, NSFW: ch.NSFW,
		AuthorityID: ch.Thread.ParentID, ThreadLocked: ch.Thread.Locked}
}

// readyVisibleChannels resolves the channels the user may see for the ready
// payload, returning the member grants it fetched alongside them so buildReady
// can reuse them for the can_send affordance without a second query. role is
// the member's effective role (top role identity, OR of every held mask).
func (h *Hub) readyVisibleChannels(ctx context.Context, database ReadySnapshotReader, userID int64, role *db.Role, channels []db.Channel) ([]db.Channel, permissions.MemberGrants, error) {
	// Filter channels by READ_MESSAGES through the single permissions.Checker
	// predicate shared with REST ListVisibleChannels and reconnect replay
	// filtering (computeAllowedChannels). The grants are fetched once and
	// reused below for the per-channel can_send affordance. DM channels are
	// excluded by the checker — they are delivered via the dm_channels field.
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
		// Nil role = zero access (fail closed), handled by skipping the filter.
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

// readyThreads is ready.threads: the viewer's followed open threads
// whose parent is in visibleChannels (an NSFW parent only once acknowledged), newest activity first, capped at
// service.MaxFollowedThreads. A follow row for a parent the viewer can no
// longer read stays in the table and is simply left out here, so regaining the
// parent brings the thread back. nil (the key is omitted) when the hub has no
// thread service, and also on a failed read: the client keeps what it had
// instead of being told it follows nothing.
func (h *Hub) readyThreads(ctx context.Context, userID int64, visibleChannels []db.Channel, nsfwAck map[int64]bool) *[]readyThreadPayload {
	svc := h.threadHub.svc
	if svc == nil {
		return nil
	}
	readable := make(map[int64]struct{}, len(visibleChannels))
	for i := range visibleChannels {
		// A thread's name discloses its starter, so an NSFW parent the viewer
		// has not acknowledged lists none of its threads, as thread_changed
		// withholds them.
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
	// Collect voice states, filtered to visible channels plus the
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
	// (serve.go), which this full-ready tier had no equivalent for.
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
// nsfw_acknowledged field. Bounded by how many labelled channels the
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

	// Per-user unread counts.
	unreadMap, err := database.GetChannelUnreadCounts(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("buildReady GetChannelUnreadCounts: %w", err)
	}

	// Current timeout verdict: readyAffordances' Subject must
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

	timeouts, err := h.readyMemberTimeouts(ctx, userID, sub)
	if err != nil {
		return nil, err
	}

	categories, err := h.readyCategories(ctx, database, sub)
	if err != nil {
		return nil, err
	}

	// Build protocol-compliant channel objects (strip extra fields).
	ackMap := readyNSFWAcknowledgements(ctx, database, userID, visibleChannels)
	// The lock is cosmetic: a failed read must not fail ready (nothing is
	// private then, as on the single-channel frames).
	privacy := h.privacySnapshot(ctx)
	channelPayloads := readyChannelPayloads(feat.filterChannels(visibleChannels), grants, unreadMap, ackMap, sub.TimedOut, privacy)

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
	// P5-S04: bound concurrent ready builds. Taken before any handshake state
	// change or registration, so a waiting connect neither touches the
	// database nor queues broadcasts it cannot drain yet.
	release, admitted := h.admitReady(ctx)
	if !admitted {
		refuseBusy(ctx, conn, c)
		return fmt.Errorf("handleFreshConnect: ready builds saturated for user %d", c.userID)
	}
	defer release()
	// The configured seam, never a caller-supplied handle: binding here is what
	// lets a service-backed or instrumented Ready reader actually intercept the
	// snapshot reads below — same posture as freshConnectCleanStaleVoice's
	// own read through the voice service.
	database := h.readers.Ready
	h.freshConnectSettleVoice(ctx, c)

	// c.user is the auth-time snapshot — re-read it so the ready payload and
	// any inherited subscriptions resolve from the user's CURRENT role, not
	// the one they held when the auth frame was evaluated (the resume path does the same in reconnectPrecheck). Fail closed
	// like the role lookup below.
	if err := h.refreshUserSnapshot(ctx, database, c); err != nil {
		slog.Error("ws: user re-read failed, disconnecting", "user_id", c.userID, "err", err)
		_ = conn.Close(websocket.StatusInternalError, "user lookup failed")
		return err
	}

	// Look up role for permission-filtered ready payload.
	// Fail closed: if the role lookup fails, disconnect rather than serving
	// a permissive ready payload with nil role.
	// The same read refreshUserSnapshot just made, so auth_ok.role_ids and the
	// ready permissions come from one snapshot.
	heldRoles := c.held
	if heldRoles == nil {
		slog.Error("ws: role lookup failed, disconnecting", "user_id", c.userID, "role_id", c.user.RoleID)
		_ = conn.Close(websocket.StatusInternalError, "role lookup failed")
		return fmt.Errorf("role lookup failed for user %d", c.userID)
	}
	// Top role identity with the OR of every held mask: what the ready
	// payload's permission-filtered fields resolve from.
	userRole := heldRoles.Effective()

	// Register BEFORE writing auth_ok + ready so broadcasts that arrive during
	// the write window are queued in the client's send buffer instead of
	// being lost. writePump hasn't started yet, so queued messages
	// will be drained once the pumps begin.
	allowedChannelIDs := h.gateResumeChannel(ctx, database, c)
	if freshConnectPreRegisterRaceHook != nil {
		freshConnectPreRegisterRaceHook()
	}
	txn := h.begin(c.userID)
	h.registerNow(c, allowedChannelIDs, txn)
	txn.end()

	// registerNow just above is the earliest point a revocation
	// racing this handshake's DB work could have found this socket, so
	// re-read the session now that c is reachable — see
	// postRegisterSessionRecheck's doc. When it aborts it has already
	// run the full failed-handshake teardown; only closing conn is left.
	if v := h.postRegisterSessionRecheck(ctx, c); v != postRegisterOK {
		closeAbortedHandshake(ctx, conn, v)
		return fmt.Errorf("handleFreshConnect: session revoked or user banned for user %d during handshake", c.userID)
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
		// Compared by the held-role SET: adding or removing a role that is not
		// the member's top role changes what they may read without moving the
		// users.role_id mirror.
		if fresh, err := database.GetMemberRoles(ctx, c.userID); err != nil || fresh == nil || !sameRoleSet(fresh.IDs, heldRoles.IDs) {
			//nolint:contextcheck // revokeUnreadableChannels takes no context by design (admin HubBroadcaster interface).
			h.revokeUnreadableChannels(c.userID)
		}
	}

	// Settle the session's status before buildReady reads the member list, so
	// the ready payload and the presence broadcast below cannot disagree.
	h.applyConnectStatus(ctx, c)

	// Fresh connection or replay fallback: full auth_ok + ready flow.
	slog.Info("ws sending auth_ok", "user_id", c.userID, "username", c.user.Username, "role", c.roleName)
	if err := handshakeWrite(ctx, conn, h.buildAuthOK(ctx, c.user, c.roleName, c.roleIDs, "none")); err != nil {
		slog.Warn("ws: failed to send auth_ok", "user_id", c.userID, "err", err)
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return err
	}
	// This ready carries every member's status, so it settles any presence
	// resync owed (P5-S03). Cleared before the build, so a drop after it
	// marks the user again; restored if the ready never reaches the client.
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
// built, under the voice lock so the old socket's voice paths cannot
// interleave. The lock is released for handleFreshConnect's DB reads and
// taken again for registerNow; every row deleter also drops the grace entry,
// so the gap is safe.
func (h *Hub) freshConnectSettleVoice(ctx context.Context, c *Client) {
	txn := h.begin(c.userID)
	defer txn.end()
	// a fresh connect ends its own session's parked grace window
	// (registerNow drops it); a replay-failure fallback may inherit one only while its row
	// still exists.
	if c.lastSeq == 0 {
		txn.takeParkedOfSession(c.tokenHash) // another device's parked call stays parked
	} else {
		h.dropOrphanVoiceGrace(ctx, c.userID)
	}
	// Clean stale voice state BEFORE building ready and registering.
	// When a user F5-reloads while in voice, the DB row from the previous
	// session must be removed so the ready payload doesn't include it and
	// other clients see a voice_leave broadcast.
	if vs, err := h.voice.State(ctx, c.userID); err == nil && vs != nil {
		h.freshConnectCleanStaleVoice(ctx, txn, c, vs)
	}
}

// freshConnectCleanStaleVoice removes the voice state left behind by this
// user's previous session, unless that session is the still-registered
// connection this one is about to inherit from.
func (h *Hub) freshConnectCleanStaleVoice(ctx context.Context, txn *voiceTxn, c *Client, vs *db.VoiceState) {
	// Replay-failure fallback (lastSeq > 0): registerNow below transfers
	// the still-registered old connection's live voice state into this
	// client. Deleting the DB row here — and the LiveKit participant,
	// whose removal token is the very JoinedAt being transferred — would
	// leave the user "in voice" on the hub only: voice_join bounces off
	// ALREADY_JOINED and sweepStaleVoiceStates never heals
	// memory-without-row. Keep the row so ready stays consistent. If the
	// old client unregisters before registerNow runs, the transfer is
	// skipped and the next sweep reaps the then-truly-stale row.
	// The call belongs to another device when a live connection of a DIFFERENT
	// session holds it, or that session parked it in the grace window. This
	// connection is only a new device (or a reload of another one): it must not
	// end that call. Same-session F5 falls through and cleans its own stale call.
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
	// a replay-failure fallback whose previous socket parked this
	// membership in the grace window keeps the row for registerNow to inherit
	// (deleting it would leave an inherited state with no row — the ghost
	// closed for the still-registered case). Any other fresh connect or
	// mismatched grace entry means the call is over: stop the window so its
	// timer cannot later re-run finishVoiceLeave over a cleaned row.
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
	// The DB row is gone, but the still-registered OLD *Client (if any) is
	// otherwise only cleared by registerNow — which two early-return paths
	// further down handleFreshConnect (the refreshUserSnapshot and
	// GetRoleByID failure branches) can skip entirely. Without this, that
	// old client's in-memory voiceChID and the E2EE key-holder election for
	// this room survive as a memory-without-row ghost that
	// sweepStaleVoiceStates can never see, since it iterates DB rows.
	// Clearing here makes freshConnectCleanStaleVoice self
	// sufficient regardless of whether registerNow ever runs; registerNow's
	// own replacedVoiceChID re-election later becomes a redundant no-op
	// (clearVoiceState finds nothing left to clear), not a conflict.
	if old := h.sessionClient(c.userID, c.tokenHash); old != nil {
		txn.clearIfChannel(old, vs.ChannelID)
	}
	h.updateKeyHolder(vs.ChannelID)
	h.broadcastVoiceEvent(ctx, vs.ChannelID, c.userID, buildVoiceLeave(vs.ChannelID, c.userID))
	// pass the stale join token so the removal only hits the exact
	// stale participant — the identity includes joinedAt, so a quick rejoin's
	// new session has a different identity and won't be removed.
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
