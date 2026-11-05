package admin

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// ticketEntry holds a single-use ticket with a creation timestamp for TTL.
type ticketEntry struct {
	createdAt time.Time
	tokenHash string
}

// ticketStore manages short-lived, single-use tickets for SSE authentication.
type ticketStore struct {
	mu      syncutil.Mutex
	tickets map[string]ticketEntry
}

var logTickets = &ticketStore{
	tickets: make(map[string]ticketEntry),
}

const ticketTTL = 30 * time.Second

// issue creates a new single-use ticket and returns its hex string.
func (ts *ticketStore) issue(tokenHash string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generating ticket: %w", err)
	}
	ticket := hex.EncodeToString(b)

	ts.mu.Lock()
	defer ts.mu.Unlock()

	// Opportunistic cleanup of expired tickets.
	now := time.Now()
	for k, v := range ts.tickets {
		if now.Sub(v.createdAt) > ticketTTL {
			delete(ts.tickets, k)
		}
	}

	ts.tickets[ticket] = ticketEntry{createdAt: now, tokenHash: tokenHash}
	return ticket, nil
}

// redeem validates and consumes a ticket.
func (ts *ticketStore) redeem(ticket string) (ticketEntry, bool) {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	entry, ok := ts.tickets[ticket]
	if !ok {
		return ticketEntry{}, false
	}
	delete(ts.tickets, ticket) // single-use: delete immediately

	if time.Since(entry.createdAt) > ticketTTL {
		return ticketEntry{}, false
	}
	return entry, true
}

// handleLogTicket issues a short-lived, single-use ticket for the SSE log stream.
// POST /admin/api/logs/ticket — requires normal admin auth (header). The ticket
// is bound to the hash of whichever bearer credential authenticated the request
// (login session or API token), so both principal kinds can stream logs.
func handleLogTicket(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hash, ok := r.Context().Value(adminTokenHashKey).(string)
		if !ok || hash == "" {
			writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "invalid or expired session")
			return
		}

		ticket, err := logTickets.issue(hash)
		if err != nil {
			slog.Error("failed to issue log stream ticket", "err", err)
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to generate ticket")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"ticket": ticket})
	}
}

// logStreamAuthorize runs the log stream's authentication prologue: it redeems
// the single-use ticket, resolves the principal behind it, and returns the
// re-check closure the stream calls to confirm the viewer still has access. It
// writes the error response itself and reports false when the caller must stop.
// onResolve, when set, is called each time the closure resolves the principal
// (tests count those; production passes nil).
func logStreamAuthorize(w http.ResponseWriter, r *http.Request, database *db.DB, onResolve func()) (func() bool, bool) {
	// Authenticate via single-use ticket.
	ticket := r.URL.Query().Get("ticket")
	entry, ok := logTickets.redeem(ticket)
	if ticket == "" || !ok {
		writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "invalid or expired ticket")
		return nil, false
	}
	// Stream lifetime == request lifetime, so all principal re-checks below use
	// the stream request's context. The ticket's hash is resolved like
	// adminAuthMiddleware resolves a bearer credential (session first, then API
	// token), so revoking either kind mid-stream cuts the stream.
	ctx := r.Context()
	user, role, _, err := auth.ResolveTokenHash(ctx, database, entry.tokenHash)
	if err != nil || user == nil || role == nil {
		writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "invalid or expired session")
		return nil, false
	}
	principalStillAuthorized := func() bool {
		if onResolve != nil {
			onResolve()
		}
		current, currentRole, _, resolveErr := auth.ResolveTokenHash(ctx, database, entry.tokenHash)
		if resolveErr != nil || current == nil || currentRole == nil {
			return false
		}
		// A ban mid-stream must cut the stream, same as adminAuthMiddleware
		// rejects a banned user on the request path.
		if auth.IsEffectivelyBanned(current) {
			return false
		}
		return permissions.CanViewDiagnostics(currentRole.Permissions)
	}
	if !principalStillAuthorized() {
		writeErr(w, http.StatusForbidden, httperr.CodeForbidden, "VIEW_DIAGNOSTICS permission required")
		return nil, false
	}
	return principalStillAuthorized, true
}

// backfillChunk is how many backfill entries go out per write. The principal is
// re-checked before each chunk rather than each entry: a check is a few DB
// queries, and per entry that cost a full ring's worth of round-trips before
// the first line reached the browser. A credential revoked mid-backfill still
// cuts the stream within one chunk.
const backfillChunk = 500

// writeBackfill sends the backfill in chunks, flushing after each, and reports
// false when the principal lost access and the stream must end.
func writeBackfill(w http.ResponseWriter, flusher http.Flusher, backfill []LogEntry, stillAuthorized func() bool) bool {
	var buf bytes.Buffer
	for start := 0; start < len(backfill); start += backfillChunk {
		if !stillAuthorized() {
			return false
		}
		buf.Reset()
		for _, entry := range backfill[start:min(start+backfillChunk, len(backfill))] {
			if data, err := json.Marshal(entry); err == nil {
				buf.WriteString("data: ")
				buf.Write(data)
				buf.WriteString("\n\n")
			}
		}
		_, _ = w.Write(buf.Bytes())
		flusher.Flush()
	}
	return true
}

// handleLogStream serves an SSE endpoint that streams log entries in real-time.
// Auth is via query param ?ticket= — a short-lived single-use ticket obtained
// from POST /admin/api/logs/ticket (which requires normal admin auth).
func handleLogStream(database *db.DB, ringBuf *RingBuffer) http.HandlerFunc {
	return handleLogStreamWith(database, ringBuf, logStreamHooks{})
}

func handleLogStreamWith(database *db.DB, ringBuf *RingBuffer, hooks logStreamHooks) http.HandlerFunc {
	now := hooks.now
	if now == nil {
		now = time.Now
	}
	return func(w http.ResponseWriter, r *http.Request) {
		principalStillAuthorized, ok := logStreamAuthorize(w, r, database, hooks.onResolve)
		if !ok {
			return
		}
		// Live lines re-check at most once per logStreamRecheckEvery.
		liveStillAuthorized := throttledCheck(principalStillAuthorized, logStreamRecheckEvery, now)
		ctx := r.Context()

		// Check that we can flush (required for SSE).
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "streaming not supported")
			return
		}

		// Set SSE headers.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		// This handler streams through the ordinary ResponseWriter, so it is
		// subject to http.Server.WriteTimeout: net/http sets the write deadline
		// once, when headers are read, and writing more data does not extend it.
		// Left in place, every write past it (keepalives included) silently
		// times out, since the caller discards write errors per SSE convention,
		// and the stream goes dead until the client reconnects and replays the
		// full backfill. SetWriteDeadline(zero) clears it on HTTP/1 and cancels
		// the per-stream timer on HTTP/2; ErrNotSupported means no real
		// connection (tests) and is ignored.
		if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
			slog.Warn("log stream: failed to clear write deadline; stream may be cut by WriteTimeout", "err", err)
		}

		// Snapshot the backfill and subscribe atomically: the principal
		// re-check below is a DB round-trip, so a Snapshot()-then-Subscribe()
		// gap would silently drop entries written in between.
		backfill, ch, unsub := ringBuf.SnapshotAndSubscribe()
		defer unsub()

		if !writeBackfill(w, flusher, backfill, principalStillAuthorized) {
			return
		}

		// Keepalive ticker against intermediary/proxy idle timeouts (the
		// connection's own WriteTimeout was already neutralized above).
		keepalive := time.NewTicker(15 * time.Second)
		defer keepalive.Stop()

		for {
			select {
			case entry := <-ch:
				if !liveStillAuthorized() {
					return
				}
				if data, err := json.Marshal(entry); err == nil {
					_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
					flusher.Flush()
				}
			case <-keepalive.C:
				if !principalStillAuthorized() {
					return
				}
				_, _ = fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
			case <-ctx.Done():
				return
			case <-ringBuf.streamsEnd:
				return
			}
		}
	}
}
