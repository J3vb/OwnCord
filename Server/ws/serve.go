package ws

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	authDeadline     = 10 * time.Second
	writeTimeout     = 10 * time.Second
	settingsCacheTTL = 30 * time.Second

	// wsReadLimitBytes is the maximum size of a single inbound WebSocket
	// message. Must match the client-side upload cap.
	wsReadLimitBytes = config.MaxMessageBytes

	// preAuthReadLimitBytes caps inbound messages until the auth frame is
	// accepted; an auth frame is a few hundred bytes.
	preAuthReadLimitBytes = 8 << 10
)

// ServeWS upgrades an HTTP connection to WebSocket, performs in-band auth,
// then drives the client's read/write loops.
// Do not wrap with AuthMiddleware — WS does its own auth.
//
// allowedOrigins controls which HTTP origins may open a WebSocket connection.
// Pass nil or []string{"*"} to allow all origins (insecure, for development).
// Pass explicit origins such as []string{"https://example.com"} to restrict access.
//
// maxConns, when > 0, refuses new connections with 503 once that many clients
// are registered or still handshaking — a static capacity guardrail
// (server.max_ws_connections). The check runs before the upgrade so a refused
// connection costs one HTTP request, not a socket plus goroutines.
func ServeWS(hub *Hub, allowedOrigins []string, maxConns int) http.HandlerFunc {
	acceptOpts := OriginAcceptOptions(allowedOrigins)
	// admissionMu makes the capacity decision atomic with reserving the slot:
	// pending counts this handler's admitted sockets that have not yet started
	// their pumps (authenticating, waiting for a ready-build permit, or
	// handshaking), and the check reads it together with the hub's active
	// count. Reserving before the upgrade means a socket costs one HTTP
	// request when refused, and a slot is held across registration (registerNow
	// runs before startPumps' release), so active+pending never dips below the
	// true reserved count.
	var admissionMu syncutil.Mutex
	pending := 0 // guarded by admissionMu
	return func(w http.ResponseWriter, r *http.Request) {
		if serveWSAdmissionRaceHook != nil {
			serveWSAdmissionRaceHook()
		}
		admissionMu.Lock()
		if maxConns > 0 && hub.ClientCount()+pending >= maxConns {
			admissionMu.Unlock()
			hub.connRejects.Add(1)
			w.Header().Set("Retry-After", "30")
			http.Error(w, "server at connection capacity", http.StatusServiceUnavailable)
			return
		}
		pending++
		admissionMu.Unlock()

		var ended bool
		endPending := func() {
			if !ended {
				ended = true
				admissionMu.Lock()
				pending--
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

		// Reconnection with state recovery: if the client sent a last_seq,
		// try to replay missed events from the ring buffer instead of
		// sending a full ready payload.
		if lastSeq > 0 {
			if handled, shouldStartPumps := hub.handleReconnect(ctx, conn, c, lastSeq); handled {
				if shouldStartPumps {
					startPumps()
				}
				return
			}
			// Replay failed (seq too old) — fall through to full ready payload.
			slog.Info("ws replay failed (seq too old), sending full ready", "user_id", c.userID, "last_seq", lastSeq)
		}

		if err := hub.handleFreshConnect(ctx, conn, c); err != nil {
			return
		}

		// writePump runs in background; readPump blocks.
		// When readPump returns (disconnect), close the send channel first
		// so writePump drains any remaining messages, then cancel its context.
		startPumps()
	}
}

// serveWSAdmissionRaceHook, when non-nil, runs once per ServeWS upgrade request
// at handler entry, before admissionMu is acquired and the atomic capacity
// check-and-reserve runs, so a test can park every concurrent upgrade at the
// admission boundary and release them together. Test-only (nil in production),
// same pattern as handleReconnectPreRegisterRaceHook.
var serveWSAdmissionRaceHook func()

// handleReconnectPreRegisterRaceHook, when non-nil, runs once inside
// handleReconnect's h.seqMu critical section immediately before the
// mustFullResync re-check that guards registerNow. Test-only (nil in
// production); a real visibility change lands too fast relative to the DB
// round trips above to reliably land a concurrent goroutine in this window,
// so tests use this hook to pin it deterministically instead — mirrors the
// refreshChannelVisibilityRaceHook / voiceJoinPostTokenRaceHook pattern used
// for the analogous races elsewhere in this package (OC-0206).
var handleReconnectPreRegisterRaceHook func()

// handleReconnectPostCheckPreRegisterRaceHook, when non-nil, runs once
// inside handleReconnect's h.seqMu critical section immediately AFTER the
// mustFullResync re-check passes and immediately before registerNow (Codex
// round 4, item A). Test-only (nil in production): unlike
// handleReconnectPreRegisterRaceHook (which fires before that re-check),
// this pins the exact gap a concurrent MarkVisibilityChanged call must not
// be able to land in unnoticed — since it now also takes h.seqMu, a real
// concurrent caller starting here is provably blocked until this critical
// section (and registerNow within it) completes.
var handleReconnectPostCheckPreRegisterRaceHook func()

// freshConnectPreRegisterRaceHook, when non-nil, runs once inside
// handleFreshConnect after refreshUserSnapshot has re-read the user row but
// before registerNow. Test-only (nil in production); pins the
// role-reassignment-vs-handshake window (audit-2026-08-19 F-2)
// deterministically, same pattern as handleReconnectPreRegisterRaceHook.
var freshConnectPreRegisterRaceHook func()

// refreshUserSnapshot replaces c.user (and, when the role changed, c.roleName)
// with a fresh read of the user row. Handshake paths call it before
// registerNow, while c is still invisible to every other goroutine, so the
// plain field writes are safe. Fail closed: callers must not proceed on the
// stale snapshot when the re-read fails.
func (h *Hub) refreshUserSnapshot(ctx context.Context, database VisibilityReader, c *Client) error {
	user, err := database.GetUserByID(ctx, c.userID)
	if err != nil {
		return fmt.Errorf("refreshUserSnapshot GetUserByID: %w", err)
	}
	if user == nil {
		return fmt.Errorf("refreshUserSnapshot: user %d vanished", c.userID)
	}
	// A ban committing during the handshake window (after authenticateConn's
	// own check) must stop the connection here rather than sail through to a
	// live, fully authorized socket: both callers are already fail-closed on
	// this function's error (handleFreshConnect closes the conn;
	// reconnectPrecheck falls back to the full-ready path, which re-reads and
	// hits this same guard) (OC-0272).
	if auth.IsEffectivelyBanned(user) {
		return fmt.Errorf("refreshUserSnapshot: user %d is banned", c.userID)
	}
	if user.RoleID != c.user.RoleID {
		// Fail closed like the sibling lookups in upgradeAndAuth and
		// handleFreshConnect: c.roleName is authoritative on the wire
		// (auth_ok, member_join, every chat_message), so a lookup failure
		// must not silently substitute "member" and pin the session to a
		// fabricated role (OC-0299).
		role, roleErr := database.GetRoleByID(ctx, user.RoleID)
		if roleErr != nil || role == nil {
			return fmt.Errorf("refreshUserSnapshot: role lookup failed for user %d role %d: %w", c.userID, user.RoleID, roleErr)
		}
		c.roleName = strings.ToLower(role.Name)
	}
	c.user = user
	return nil
}

// applyConnectStatus stamps the status this session comes online as and caches
// it on the client. Which status that is belongs to the presence seam
// (UserService.StampConnect: a saved idle/dnd/invisible survives a reconnect,
// anything else becomes online); what stays here is what the hub does with the
// answer.
//
// It runs BEFORE the ready payload is built so the member list the client is
// handed already agrees with the presence broadcast that follows it.
func (h *Hub) applyConnectStatus(ctx context.Context, c *Client) {
	if c.user.LastSeen == nil {
		h.presenceRepair.mark(&h.presenceRepair.joins, c.userID, true)
	}
	status, err := h.presence.StampConnect(ctx, c.userID, c.user.Status)
	if err != nil {
		slog.Warn("ws StampConnect", "err", err)
		// Do not stamp c.user.Status on a failed write: it would make the
		// auth_ok reply and the presence broadcast below both claim a value
		// that users.status disagrees with, and buildReady's ListMembers read
		// of users.status (via presentableMembers, which only ever downgrades
		// a connected user to offline, never upgrades one) would then never
		// self-correct for the rest of this session (OC-0298). The live
		// presence follows the row for the same reason.
		c.setLivePresence(c.user.Status, c.user.CustomStatus)
		return
	}
	c.user.Status = status
	c.setLivePresence(status, c.user.CustomStatus)
}

// announceFreshConnect tells every other client that c came online after a
// full ready. Coming online is presence, not a join: every client's ready
// already lists every member, so a member_join goes ahead of the presence
// only for a member other clients cannot have yet — a user still owed one
// since their first-ever connect (applyConnectStatus marks it before the
// stamp erases last_seen NULL; announceMember clears it), or the return of a
// user whose temporary ban lapsed (member_ban removed them everywhere, and
// users.banned stays 1 until an unban).
func (h *Hub) announceFreshConnect(c *Client) {
	p := pendingPresence{status: c.user.Status, customStatus: c.user.CustomStatus}
	if h.presenceRepair.marked(&h.presenceRepair.joins, c.userID) || c.user.Banned {
		m := memberPayloadFor(c.user, c.roleName)
		p.member = &m
	}
	slog.Info("ws announcing connect presence", "user_id", c.userID, "username", c.user.Username, "new_member", p.member != nil)
	h.queuePresence(c.userID, p)
}

// announceConnectPresence fans out the status applyConnectStatus settled on,
// with the invisible mapping applied.
func (h *Hub) announceConnectPresence(c *Client) {
	h.QueuePresence(c.userID, c.user.Status, c.user.CustomStatus)
}

// gateResumeChannel resolves the read-permission set a resume fallback
// (lastSeq > 0) registers with and settles c.channelID against it before
// registerNow subscribes it. It returns nil for a pure fresh connect.
func (h *Hub) gateResumeChannel(ctx context.Context, database ReadySnapshotReader, c *Client) map[int64]bool {
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
	// The auth frame's active_channel_id was honoured only along
	// handleReconnect's replay-capable path. On a full resync (last_seq > 0
	// but replay forced "none" — every post-restart resume, since the fresh
	// per-boot seq floor renumbers the space and the boot bumps the
	// visibility watermark) registerNow copies the subscription from the OLD
	// client entry, which readPump's unregister has normally already deleted.
	// Without this promotion the socket holds no ChannelTopic subscription
	// until its post-ready channel_focus round trip lands, and every channel
	// frame broadcast in that window (auth_ok + ready write, pump startup,
	// one RTT) is delivered to nobody and can never be re-requested, because
	// the client only reports max(seq). Honoured only when READ-visible, the
	// same fail-closed gate handleReconnect applies, and only on a resume
	// (last_seq > 0), as docs/protocol.md specifies; the re-gate below stays
	// as defence for the abort-path promotion it already documents.
	if c.lastSeq > 0 && c.authChannelID != 0 && allowedChannelIDs[c.authChannelID] {
		c.mu.Lock()
		c.channelID = c.authChannelID
		c.mu.Unlock()
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
	return allowedChannelIDs
}
