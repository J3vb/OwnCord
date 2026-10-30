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
	authDeadline     = 10 * time.Second
	writeTimeout     = 10 * time.Second
	settingsCacheTTL = 30 * time.Second

	// wsReadLimitBytes is the maximum inbound WebSocket message size; must match the client upload cap.
	wsReadLimitBytes = config.MaxMessageBytes

	// preAuthReadLimitBytes caps inbound messages until the auth frame is accepted.
	preAuthReadLimitBytes = 8 << 10
)

// ServeWS upgrades an HTTP connection to WebSocket, authenticates in-band, then
// drives the client's read/write loops. Do not wrap with AuthMiddleware: WS does
// its own auth.
//
// allowedOrigins controls which origins may connect: nil or {"*"} allows all
// (insecure, development); explicit origins restrict. maxConns, when > 0, refuses
// new connections with 503 once that many clients are registered or handshaking
// (server.max_ws_connections); the check runs before the upgrade so a refusal
// costs one HTTP request, not a socket plus goroutines.
func ServeWS(hub *Hub, allowedOrigins []string, maxConns int) http.HandlerFunc {
	acceptOpts := OriginAcceptOptions(allowedOrigins)
	// pending counts admitted sockets that have not started their pumps
	// (authenticating, waiting for a ready-build permit, or handshaking). admissionMu
	// serializes the capacity decision with the release so the check reads the hub's
	// active count and pending as one consistent pair: registerNow (under h.mu) runs
	// before startPumps' release, and that unlock publishes the registration to the
	// next admission, so a stale reader cannot reserve a slot a just-registered
	// connection took. A slot is held across registration, so
	// hub.ClientCount() + pending never dips below the true reserved count. pending is
	// atomic only so the unlocked fast-path read is race-free; the authoritative
	// check-and-reserve and the release are under admissionMu.
	var admissionMu syncutil.Ranked[lockRankSerialiser]
	var pending atomic.Int64
	return func(w http.ResponseWriter, r *http.Request) {
		reject := func() {
			hub.connRejects.Add(1)
			w.Header().Set("Retry-After", "30")
			httperr.Write(w, http.StatusServiceUnavailable, httperr.CodeServerBusy, "server at connection capacity")
		}
		// Fast-path refusal. It only ever refuses, never admits, so a stale unlocked read
		// cannot let a connection past the ceiling; the check below re-reads under admissionMu.
		if maxConns > 0 && hub.ClientCount()+int(pending.Load()) >= maxConns {
			reject()
			return
		}
		// Runs after the capacity comparison and before the reservation. Test-only.
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

		// With a last_seq, try to replay missed events instead of a full ready payload.
		if lastSeq > 0 {
			if handled, shouldStartPumps := hub.handleReconnect(ctx, conn, c, lastSeq); handled {
				if shouldStartPumps {
					startPumps()
				}
				return
			}
			slog.Info("ws replay failed (seq too old), sending full ready", "user_id", c.userID, "last_seq", lastSeq)
		}

		if err := hub.handleFreshConnect(ctx, conn, c); err != nil {
			return
		}

		// writePump runs in the background and readPump blocks. When readPump returns,
		// close the send channel first so writePump drains remaining messages, then cancel
		// its context.
		startPumps()
	}
}

// serveWSAdmissionRaceHook, when non-nil, runs once per upgrade between the
// capacity comparison and the reservation, so a test can park concurrent upgrades
// in that check-then-reserve window. Test-only.
var serveWSAdmissionRaceHook func()

// handleReconnectPreRegisterRaceHook, when non-nil, runs inside handleReconnect's
// h.seqMu section right before the mustFullResync re-check guarding registerNow.
// Test-only: a real visibility change is too fast relative to the DB round trips to
// land in this window reliably.
var handleReconnectPreRegisterRaceHook func()

// handleReconnectPreSeqMuRaceHook, when non-nil, runs in reconnectRegister just
// before it takes h.seqMu, after the allowed set is computed. Test-only. A
// visibility fan-out takes h.seqMu through beginTargetedFanout, so a test lands one
// here, never from handleReconnectPreRegisterRaceHook, which runs holding seqMu.
var handleReconnectPreSeqMuRaceHook func()

// handleReconnectPostCheckPreRegisterRaceHook, when non-nil, runs inside
// handleReconnect's h.seqMu section after the mustFullResync re-check passes and
// before registerNow. Test-only: it pins the gap a concurrent
// MarkVisibilityChanged must not land in unnoticed; since that call also takes
// h.seqMu, it is provably blocked until this section completes.
var handleReconnectPostCheckPreRegisterRaceHook func()

// freshConnectPreRegisterRaceHook, when non-nil, runs in handleFreshConnect after
// refreshUserSnapshot and before registerNow. Test-only; pins the
// role-reassignment-vs-handshake window.
var freshConnectPreRegisterRaceHook func()

// refreshUserSnapshot replaces c.user, c.roleName and c.roleIDs with a fresh read.
// Handshake paths call it before registerNow, while c is invisible to other
// goroutines, so the plain writes are safe. Fail closed: callers must not proceed
// on the stale snapshot when the re-read fails.
func (h *Hub) refreshUserSnapshot(ctx context.Context, database VisibilityReader, c *Client) error {
	user, err := database.GetUserByID(ctx, c.userID)
	if err != nil {
		return fmt.Errorf("refreshUserSnapshot GetUserByID: %w", err)
	}
	if user == nil {
		return fmt.Errorf("refreshUserSnapshot: user %d vanished", c.userID)
	}
	// A ban committing during the handshake window (after authenticateConn's check)
	// must stop the connection here. Both callers fail closed on this error
	// (handleFreshConnect closes the conn; reconnectPrecheck falls back to full ready,
	// which hits this guard again).
	if auth.IsEffectivelyBanned(user) {
		return fmt.Errorf("refreshUserSnapshot: user %d is banned", c.userID)
	}
	// Read the held-role set, not just the users.role_id mirror: adding or removing a
	// non-top role moves permissions without moving the mirror. Fail closed:
	// c.roleName is authoritative on the wire (auth_ok, member_join, every
	// chat_message), so a lookup failure must not substitute "member" and pin the
	// session to a fabricated role.
	held, roleErr := database.GetMemberRoles(ctx, c.userID)
	if roleErr != nil || held == nil {
		return fmt.Errorf("refreshUserSnapshot: role lookup failed for user %d role %d: %w", c.userID, user.RoleID, roleErr)
	}
	if user.RoleID != held.Top.ID {
		// The mirror and held set disagree (a change landed between reads, or the mirror
		// is damaged). The held set is authoritative; a mirror naming a nonexistent role
		// is still a refusal.
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

// applyConnectStatus stamps the status this session comes online as and caches it
// on the client. Which status belongs to the presence seam
// (UserService.StampConnect: a saved idle/dnd/invisible survives a reconnect,
// anything else becomes online). It runs before the ready payload is built so the
// member list agrees with the presence broadcast that follows.
func (h *Hub) applyConnectStatus(ctx context.Context, c *Client) {
	if c.user.LastSeen == nil {
		h.presenceRepair.mark(&h.presenceRepair.joins, c.userID, true)
	}
	status, err := h.presence.StampConnect(ctx, c.userID, c.user.Status)
	if err != nil {
		slog.Warn("ws StampConnect", "err", err)
		// Do not stamp c.user.Status on a failed write: auth_ok and the presence broadcast
		// would claim a value users.status disagrees with, and buildReady's read via
		// presentableMembers (which only downgrades a connected user to offline) would
		// never self-correct for the session. The live presence follows the row for the
		// same reason.
		text, tag := storedCustomStatus(c.user.CustomStatus, c.user.CustomStatusExpiresAt, time.Now())
		c.setLivePresence(c.user.Status, text, tag)
		return
	}
	c.user.Status = status
	text, tag := storedCustomStatus(c.user.CustomStatus, c.user.CustomStatusExpiresAt, time.Now())
	c.setLivePresence(status, text, tag)
}

// announceFreshConnect tells every other client that c came online after a full
// ready. Coming online is presence, not a join (every ready lists every member), so
// a member_join goes ahead only for a member other clients cannot have yet: a user
// owed one since their first-ever connect (applyConnectStatus marks it before the
// stamp erases last_seen NULL; announceMember clears it), or one whose temporary
// ban lapsed (member_ban removed them everywhere; users.banned stays 1).
func (h *Hub) announceFreshConnect(c *Client) {
	text, _ := storedCustomStatus(c.user.CustomStatus, c.user.CustomStatusExpiresAt, time.Now())
	p := pendingPresence{status: c.user.Status, customStatus: text}
	if h.presenceRepair.marked(&h.presenceRepair.joins, c.userID) || c.user.Banned {
		m := memberPayloadFor(c.user, c.roleName, c.roleIDs)
		p.member = &m
	}
	slog.Info("ws announcing connect presence", "user_id", c.userID, "username", c.user.Username, "new_member", p.member != nil)
	h.queuePresence(c.userID, p)
}

// announceConnectPresence fans out the status applyConnectStatus settled on, with
// the invisible mapping applied.
func (h *Hub) announceConnectPresence(c *Client) {
	text, _ := storedCustomStatus(c.user.CustomStatus, c.user.CustomStatusExpiresAt, time.Now())
	h.QueuePresence(c.userID, c.user.Status, text)
}

// gateResumeChannel resolves the read-permission set a resume fallback
// (lastSeq > 0) registers with and settles c.channelID against it before
// registerNow subscribes. It returns nil for a pure fresh connect.
func (h *Hub) gateResumeChannel(ctx context.Context, database ReadySnapshotReader, c *Client) map[int64]bool {
	// Only the replay-failure fallback can inherit voice state from the previous
	// connection, so only it needs the set. Fail closed: nil denies the inherited
	// voice-channel subscription.
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
	// The auth frame's active_channel_id was honoured only on handleReconnect's
	// replay path. On a full resync (last_seq > 0 but replay forced "none", e.g. every
	// post-restart resume: the new per-boot seq floor renumbers and the boot bumps the
	// watermark) registerNow copies the subscription from the old client entry, which
	// readPump's unregister has normally deleted. Without this promotion the socket
	// holds no ChannelTopic subscription until its post-ready channel_focus lands, and
	// every channel frame in that window is delivered to nobody and can never be
	// re-requested (the client reports only max(seq)). Honoured only when
	// READ-visible (the gate handleReconnect applies) and only on a resume
	// (docs/protocol.md); the re-gate below covers the abort-path promotion.
	if c.lastSeq > 0 && c.authChannelID != 0 && allowedChannelIDs[c.authChannelID] {
		c.mu.Lock()
		c.channelID = c.authChannelID
		c.mu.Unlock()
	}
	// handleReconnect may have promoted an auth-frame active_channel_id into
	// c.channelID (READ-visible then) and then aborted on one of its re-checks, e.g.
	// the final mustFullResync check tripped by a mid-handshake revocation. Abort paths
	// do not undo the write, and registerNow subscribes c.channelID's topic
	// unconditionally, so re-gate it against the fresh permission set. Fail closed: a
	// nil allowedChannelIDs denies.
	if chID := c.getChannelID(); chID != 0 && !allowedChannelIDs[chID] {
		c.mu.Lock()
		c.channelID = 0
		c.mu.Unlock()
	}
	return allowedChannelIDs
}
