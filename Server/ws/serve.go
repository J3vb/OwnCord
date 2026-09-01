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
	"github.com/J3vb/OwnCord/Server/db"
)

const (
	authDeadline     = 10 * time.Second
	writeTimeout     = 10 * time.Second
	settingsCacheTTL = 30 * time.Second

	// wsReadLimitBytes is the maximum size of a single inbound WebSocket
	// message. Must match the client-side upload cap.
	wsReadLimitBytes = config.MaxMessageBytes
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
// are registered — a static capacity guardrail (server.max_ws_connections).
// The check runs before the upgrade so a refused connection costs one HTTP
// request, not a socket plus goroutines. Registered count trails pre-auth
// connections by design; the 10s auth deadline bounds that gap.
func ServeWS(hub *Hub, database *db.DB, allowedOrigins []string, maxConns int) http.HandlerFunc {
	acceptOpts := OriginAcceptOptions(allowedOrigins)
	return func(w http.ResponseWriter, r *http.Request) {
		if maxConns > 0 && hub.ClientCount() >= maxConns {
			hub.connRejects.Add(1)
			w.Header().Set("Retry-After", "30")
			http.Error(w, "server at connection capacity", http.StatusServiceUnavailable)
			return
		}
		conn, err := websocket.Accept(w, r, acceptOpts)
		if err != nil {
			slog.Warn("ws upgrade failed", "err", err)
			return
		}
		conn.SetReadLimit(wsReadLimitBytes) // match client-side upload cap

		c, lastSeq, err := hub.upgradeAndAuth(conn, database, r)
		if err != nil {
			return
		}

		ctx := r.Context()
		startPumps := func() {
			writeCtx, writeCancel := context.WithCancel(ctx)
			go writePump(writeCtx, conn, c)
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

// handleReconnectPreRegisterRaceHook, when non-nil, runs once inside
// handleReconnect's h.seqMu critical section immediately before the
// mustFullResync re-check that guards registerNow. Test-only (nil in
// production); a real visibility change lands too fast relative to the DB
// round trips above to reliably land a concurrent goroutine in this window,
// so tests use this hook to pin it deterministically instead — mirrors the
// refreshChannelVisibilityRaceHook / voiceJoinPostTokenRaceHook pattern used
// for the analogous races elsewhere in this package (OC-0206).
var handleReconnectPreRegisterRaceHook func()

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
	status, err := h.presence.StampConnect(ctx, c.userID, c.user.Status)
	if err != nil {
		slog.Warn("ws StampConnect", "err", err)
		// Do not stamp c.user.Status on a failed write: it would make the
		// auth_ok reply and the presence broadcast below both claim a value
		// that users.status disagrees with, and buildReady's ListMembers read
		// of users.status (via presentableMembers, which only ever downgrades
		// a connected user to offline, never upgrades one) would then never
		// self-correct for the rest of this session (OC-0298).
		return
	}
	c.user.Status = status
}

// announceConnectPresence fans out the status applyConnectStatus settled on,
// with the invisible mapping applied.
func (h *Hub) announceConnectPresence(c *Client) {
	h.QueuePresence(c.userID, c.user.Status, c.user.CustomStatus)
}
