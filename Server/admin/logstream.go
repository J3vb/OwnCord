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

func (ts *ticketStore) issue(tokenHash string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generating ticket: %w", err)
	}
	ticket := hex.EncodeToString(b)

	ts.mu.Lock()
	defer ts.mu.Unlock()

	now := time.Now()
	for k, v := range ts.tickets {
		if now.Sub(v.createdAt) > ticketTTL {
			delete(ts.tickets, k)
		}
	}

	ts.tickets[ticket] = ticketEntry{createdAt: now, tokenHash: tokenHash}
	return ticket, nil
}

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

// handleLogTicket issues a short-lived single-use ticket for the SSE log stream (POST /logs/ticket, normal
// admin auth). It binds to the hash of whichever bearer credential authenticated, session or API token, so
// both principal kinds can stream logs.
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

// logStreamAuthorize redeems the single-use ticket, resolves the principal, and returns the re-check closure
// the stream calls to confirm the viewer still has access. It writes the error itself and reports false when
// the caller must stop. onResolve counts resolves in tests; production passes nil.
func logStreamAuthorize(w http.ResponseWriter, r *http.Request, database *db.DB, onResolve func()) (func() bool, bool) {
	ticket := r.URL.Query().Get("ticket")
	entry, ok := logTickets.redeem(ticket)
	if ticket == "" || !ok {
		writeErr(w, http.StatusUnauthorized, httperr.CodeUnauthorized, "invalid or expired ticket")
		return nil, false
	}
	// Stream lifetime == request lifetime, so re-checks use the stream request's context. The ticket's hash
	// resolves like adminAuthMiddleware does (session, then API token), so revoking either mid-stream cuts it.
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
		// A ban mid-stream must cut the stream, as adminAuthMiddleware rejects a banned user on the request path.
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

// backfillChunk is how many backfill entries go out per write. The principal is re-checked per chunk, not per
// entry: a check is a few DB queries, and per entry that delayed the first line by a full ring of
// round-trips. A credential revoked mid-backfill still cuts the stream within one chunk.
const backfillChunk = 500

// writeBackfill sends the backfill in chunks, flushing each; false means the principal lost access.
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

// handleLogStream serves the SSE log stream; auth is ?ticket= from POST /admin/api/logs/ticket.
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

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "streaming not supported")
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		// This handler streams through the ordinary ResponseWriter, so http.Server.WriteTimeout applies: net/http
		// sets the write deadline once at header read and writing does not extend it, so every write past it
		// (keepalives included) would silently time out (SSE callers discard write errors) and the stream goes dead
		// until the client reconnects and replays the backfill. SetWriteDeadline(zero) clears it on HTTP/1 and
		// cancels the per-stream timer on HTTP/2; ErrNotSupported (tests) is ignored.
		if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
			slog.Warn("log stream: failed to clear write deadline; stream may be cut by WriteTimeout", "err", err)
		}

		// Snapshot the backfill and subscribe atomically: the principal re-check is a DB round-trip, so a
		// Snapshot()-then-Subscribe() gap would drop entries written between.
		backfill, ch, unsub := ringBuf.SnapshotAndSubscribe()
		defer unsub()

		if !writeBackfill(w, flusher, backfill, principalStillAuthorized) {
			return
		}

		// Keepalive against proxy idle timeouts (WriteTimeout was neutralized above).
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
