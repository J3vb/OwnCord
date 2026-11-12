package ws

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	authDeadline = 10 * time.Second
	writeTimeout = 10 * time.Second

	// wsReadLimitBytes is the maximum inbound WebSocket message size; must match the client upload cap.
	wsReadLimitBytes = config.MaxMessageBytes

	// preAuthReadLimitBytes caps inbound messages until the auth frame is accepted.
	preAuthReadLimitBytes = 8 << 10
)

// ServeWS upgrades an HTTP connection to WebSocket, authenticates in-band, then drives the
// read/write loops. Do not wrap with AuthMiddleware. allowedOrigins: nil or {"*"}
// allows all (insecure, development). maxConns > 0 refuses with 503 once that many clients are
// registered or handshaking, before the upgrade.
func ServeWS(hub *Hub, allowedOrigins []string, maxConns int) http.HandlerFunc {
	acceptOpts := OriginAcceptOptions(allowedOrigins)
	// pending counts admitted sockets that have not started their pumps. admissionMu serializes
	// the capacity decision with the release so the hub's active count and pending read as one
	// consistent pair: registerNow (under h.mu) runs before startPumps' release, and a slot is held
	// across registration, so ClientCount()+pending never dips below the reserved count.
	// pending is atomic only for the unlocked fast-path read.
	var admissionMu syncutil.Ranked[lockRankSerialiser]
	var pending atomic.Int64
	return func(w http.ResponseWriter, r *http.Request) {
		reject := func() {
			hub.stats.ConnRejects.Add(1)
			w.Header().Set("Retry-After", "30")
			httperr.Write(w, http.StatusServiceUnavailable, httperr.CodeServerBusy, "server at connection capacity")
		}
		// Fast path only refuses, never admits; the check below re-reads under admissionMu.
		if maxConns > 0 && hub.ClientCount()+int(pending.Load()) >= maxConns {
			reject()
			return
		}
		if serveWSAdmissionRaceHook != nil {
			serveWSAdmissionRaceHook()
		}
		admissionMu.Lock()
		if maxConns > 0 && hub.ClientCount()+int(pending.Load()) >= maxConns {
			admissionMu.Unlock()
			reject()
			return
		}
		pending.Add(1)
		admissionMu.Unlock()

		var ended bool
		endPending := func() {
			if !ended {
				ended = true
				admissionMu.Lock()
				pending.Add(-1)
				admissionMu.Unlock()
			}
		}
		defer endPending()

		conn, err := websocket.Accept(w, r, acceptOpts)
		if err != nil {
			slog.Warn("ws upgrade failed", "err", err)
			return
		}
		conn.SetReadLimit(preAuthReadLimitBytes)

		c, lastSeq, err := hub.upgradeAndAuth(conn, r)
		if err != nil {
			return
		}
		conn.SetReadLimit(wsReadLimitBytes) // match client-side upload cap

		ctx := r.Context()

		startPumps := func() {
			endPending()
			writeCtx, writeCancel := context.WithCancel(ctx)
			go writePump(writeCtx, conn, c)
			go pingPump(writeCtx, conn, c, pingInterval)
			readPump(ctx, conn, hub, c)
			c.closeSend()
			writeCancel()
		}

		if lastSeq > 0 {
			if handled, shouldStartPumps := hub.handleReconnect(ctx, conn, c, lastSeq); handled {
				if shouldStartPumps {
					startPumps()
				}
				return
			}
			slog.Info("ws replay not possible or not asked for, sending full ready", "user_id", c.userID, "last_seq", lastSeq)
		}

		if err := hub.handleFreshConnect(ctx, conn, c); err != nil {
			return
		}

		// When readPump returns, close the send channel first so writePump drains, then cancel its context.
		startPumps()
	}
}

// serveWSAdmissionRaceHook runs between the capacity comparison and the reservation. Test-only.
var serveWSAdmissionRaceHook func()

// handleReconnectPreRegisterRaceHook runs inside handleReconnect's h.seqMu section before
// the mustFullResync re-check guarding registerNow. Test-only.
var handleReconnectPreRegisterRaceHook func()

// handleReconnectPreSeqMuRaceHook runs in reconnectRegister just before it takes h.seqMu.
// Test-only; visibility fan-out takes seqMu via beginTargetedFanout, so tests land it here,
// not in the PreRegister hook, which holds seqMu.
var handleReconnectPreSeqMuRaceHook func()

// handleReconnectPostCheckPreRegisterRaceHook runs in handleReconnect's seqMu section after
// the re-check passes, before registerNow. Test-only; MarkVisibilityChanged also takes
// seqMu, so it is blocked until the section completes.
var handleReconnectPostCheckPreRegisterRaceHook func()

// freshConnectPreRegisterRaceHook runs in handleFreshConnect between refreshUserSnapshot and
// registerNow. Test-only.
var freshConnectPreRegisterRaceHook func()

// refreshUserSnapshot replaces c.user, c.roleName and c.roleIDs with a fresh read before
// registerNow, while c is invisible to other goroutines. Fails closed: callers must not
// proceed on the stale snapshot.
func (h *Hub) refreshUserSnapshot(ctx context.Context, database VisibilityReader, c *Client) error {
	user, err := database.GetUserByID(ctx, c.userID)
	if err != nil {
		return fmt.Errorf("refreshUserSnapshot GetUserByID: %w", err)
	}
	if user == nil {
		return fmt.Errorf("refreshUserSnapshot: user %d vanished", c.userID)
	}
	// A ban committing during the handshake must stop the connection here; both callers fail
	// closed on this error.
	if auth.IsEffectivelyBanned(user) {
		return fmt.Errorf("refreshUserSnapshot: user %d is banned", c.userID)
	}
	// Read the held-role set, not just the users.role_id mirror: a non-top role moves
	// permissions without moving it. Fail closed: c.roleName is authoritative on the wire, so a
	// lookup failure must not substitute "member".
	held, roleErr := database.GetMemberRoles(ctx, c.userID)
	if roleErr != nil || held == nil {
		return fmt.Errorf("refreshUserSnapshot: role lookup failed for user %d role %d: %w", c.userID, user.RoleID, roleErr)
	}
	if user.RoleID != held.Top.ID {
		// Mirror and held set disagree; the held set is authoritative, but a mirror naming a
		// nonexistent role is still a refusal.
		if mirror, mirrorErr := database.GetRoleByID(ctx, user.RoleID); mirrorErr != nil || mirror == nil {
			return fmt.Errorf("refreshUserSnapshot: role lookup failed for user %d role %d: %w", c.userID, user.RoleID, mirrorErr)
		}
	}
	c.roleName = strings.ToLower(held.Top.Name)
	c.roleIDs = held.IDs
	c.held = held
	c.user = user
	return nil
}

// applyConnectStatus stamps the status this session comes online as (per
// UserService.StampConnect) and caches it on the client, before the ready payload is built
// so the member list agrees with the presence broadcast.
func (h *Hub) applyConnectStatus(ctx context.Context, c *Client) {
	if c.user.LastSeen == nil {
		h.presenceFeed.repair.mark(&h.presenceFeed.repair.joins, c.userID, true)
	}
	status, err := h.presence.StampConnect(ctx, c.userID, c.user.Status)
	if err != nil {
		slog.Warn("ws StampConnect", "err", err)
		// Do not stamp c.user.Status on a failed write: auth_ok and presence would claim a value
		// users.status disagrees with, and presentableMembers would never self-correct.
		text, tag := storedCustomStatus(c.user.CustomStatus, c.user.CustomStatusExpiresAt, time.Now())
		c.setLivePresence(c.user.Status, text, tag)
		return
	}
	c.user.Status = status
	text, tag := storedCustomStatus(c.user.CustomStatus, c.user.CustomStatusExpiresAt, time.Now())
	c.setLivePresence(status, text, tag)
}

// announceFreshConnect tells other clients c came online after a full ready. That is
// presence, not a join, so member_join goes only for a member others cannot have yet: a
// first-ever connect (applyConnectStatus marks it; announceMember clears it) or one whose
// temporary ban lapsed.
func (h *Hub) announceFreshConnect(c *Client) {
	text, _ := storedCustomStatus(c.user.CustomStatus, c.user.CustomStatusExpiresAt, time.Now())
	p := pendingPresence{status: c.user.Status, customStatus: text}
	p.connecting = c
	if h.presenceFeed.repair.marked(&h.presenceFeed.repair.joins, c.userID) || c.user.Banned {
		m := memberPayloadFor(c.user, c.roleName, c.roleIDs)
		p.member = &m
	}
	slog.Info("ws announcing connect presence", "user_id", c.userID, "username", c.user.Username, "new_member", p.member != nil)
	h.queuePresence(c.userID, p)
}

func (h *Hub) announceConnectPresence(c *Client) {
	text, _ := storedCustomStatus(c.user.CustomStatus, c.user.CustomStatusExpiresAt, time.Now())
	h.queuePresence(c.userID, pendingPresence{status: c.user.Status, customStatus: text, connecting: c})
}

// connectMobile is the phone flag a connect announcement carries: the merged flag, only
// while the merged status is the one being announced.
func (h *Hub) connectMobile(c *Client, status string) bool {
	shown := mergeLivePresence(h.clientsOf(c.userID))
	return shown.status == status && shown.mobile
}

// gateResumeChannel resolves the read-permission set a resume fallback registers with and
// settles c.channelID against it before registerNow. Returns nil for a pure fresh connect.
func (h *Hub) gateResumeChannel(ctx context.Context, database ReadySnapshotReader, c *Client) map[int64]bool {
	// Only the replay-failure fallback can inherit voice state, so only it needs the set. Fail
	// closed: nil denies the inherited voice-channel subscription.
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
	// Promote the auth frame's active_channel_id on a full resync too (e.g. every post-restart
	// resume): registerNow copies the subscription from the old entry, which readPump's
	// unregister normally deleted, so otherwise the socket gets no ChannelTopic subscription
	// until channel_focus and channel frames in that window reach nobody. Only when
	// READ-visible and only on a resume (docs/protocol.md).
	if c.lastSeq > 0 && c.authChannelID != 0 && allowedChannelIDs[c.authChannelID] {
		c.mu.Lock()
		c.channelID = c.authChannelID
		c.mu.Unlock()
	}
	// handleReconnect may have promoted active_channel_id into c.channelID then aborted on a
	// re-check; abort paths do not undo it and registerNow subscribes it unconditionally, so
	// re-gate against the fresh set. Fail closed: nil denies.
	if chID := c.getChannelID(); chID != 0 && !allowedChannelIDs[chID] {
		c.mu.Lock()
		c.channelID = 0
		c.mu.Unlock()
	}
	return allowedChannelIDs
}
