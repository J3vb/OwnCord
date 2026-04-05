package admin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/syncutil"
)

// ─── Ticket Store for SSE Log Stream ────────────────────────────────────────

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
// POST /admin/api/logs/ticket — requires normal admin auth (cookie/header).
func handleLogTicket(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := r.Context().Value(adminSessionKey).(*db.Session)
		if !ok || sess == nil || sess.TokenHash == "" {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid or expired session")
			return
		}

		ticket, err := logTickets.issue(sess.TokenHash)
		if err != nil {
			slog.Error("failed to issue log stream ticket", "err", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to generate ticket")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"ticket": ticket})
	}
}

// LogEntry holds a single structured log record for the ring buffer.
type LogEntry struct {
	Timestamp string `json:"ts"`
	Level     string `json:"level"`
	Message   string `json:"msg"`
	Source    string `json:"source"`
	Attrs     string `json:"attrs,omitempty"`
}

// RingBuffer is a bounded, thread-safe circular buffer of log entries
// with fan-out to SSE subscriber channels.
type RingBuffer struct {
	mu          syncutil.Mutex
	entries     []LogEntry
	capacity    int
	subscribers map[*chan LogEntry]struct{}
}

// NewRingBuffer creates a ring buffer with the given capacity.
func NewRingBuffer(capacity int) *RingBuffer {
	return &RingBuffer{
		entries:     make([]LogEntry, 0, capacity),
		capacity:    capacity,
		subscribers: make(map[*chan LogEntry]struct{}),
	}
}

// Write appends an entry, drops the oldest if full, and fans out
// to all subscribers (non-blocking to avoid slow clients blocking logging).
func (rb *RingBuffer) Write(entry LogEntry) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	if len(rb.entries) >= rb.capacity {
		// Copy to a new slice to release the backing array's first slot,
		// preventing unbounded growth from repeated re-slicing.
		fresh := make([]LogEntry, rb.capacity-1, rb.capacity)
		copy(fresh, rb.entries[1:])
		rb.entries = fresh
	}
	rb.entries = append(rb.entries, entry)

	for chp := range rb.subscribers {
		select {
		case *chp <- entry:
		default:
			// Slow subscriber — drop to avoid blocking.
		}
	}
}

// Snapshot returns a copy of all current entries for backfill.
func (rb *RingBuffer) Snapshot() []LogEntry {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	out := make([]LogEntry, len(rb.entries))
	copy(out, rb.entries)
	return out
}

// Subscribe creates a buffered channel for a new SSE client.
// Returns the channel and an unsubscribe function.
func (rb *RingBuffer) Subscribe() (<-chan LogEntry, func()) {
	ch := make(chan LogEntry, 64)
	chp := &ch
	rb.mu.Lock()
	rb.subscribers[chp] = struct{}{}
	rb.mu.Unlock()

	return ch, func() {
		rb.mu.Lock()
		delete(rb.subscribers, chp)
		rb.mu.Unlock()
	}
}

// multiHandler is an slog.Handler that tees records to two handlers:
// the original stdout handler and a ring buffer handler.
type multiHandler struct {
	stdout slog.Handler
	ring   *ringHandler
}

// ringHandler converts slog.Records into LogEntries and writes them
// to the RingBuffer.
type ringHandler struct {
	buf    *RingBuffer
	level  slog.Leveler
	attrs  []slog.Attr
	groups []string
}

// NewMultiHandler creates a handler that sends records to both stdout
// and the ring buffer. The ring buffer captures all levels from minLevel.
func NewMultiHandler(stdout slog.Handler, buf *RingBuffer, minLevel slog.Leveler) slog.Handler {
	return &multiHandler{
		stdout: stdout,
		ring: &ringHandler{
			buf:   buf,
			level: minLevel,
		},
	}
}

func (h *multiHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.stdout.Enabled(ctx, level) || h.ring.Enabled(level)
}

func (h *multiHandler) Handle(ctx context.Context, r slog.Record) error {
	if h.stdout.Enabled(ctx, r.Level) {
		_ = h.stdout.Handle(ctx, r)
	}
	if h.ring.Enabled(r.Level) {
		h.ring.Handle(r)
	}
	return nil
}

func (h *multiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &multiHandler{
		stdout: h.stdout.WithAttrs(attrs),
		ring:   h.ring.withAttrs(attrs),
	}
}

func (h *multiHandler) WithGroup(name string) slog.Handler {
	return &multiHandler{
		stdout: h.stdout.WithGroup(name),
		ring:   h.ring.withGroup(name),
	}
}

func (rh *ringHandler) Enabled(level slog.Level) bool {
	return level >= rh.level.Level()
}

func (rh *ringHandler) Handle(r slog.Record) {
	// Build source from file path.
	source := categorizeSource(r)

	// Collect attributes as a JSON object.
	attrs := make(map[string]any)
	// Add pre-set attrs from WithAttrs.
	for _, a := range rh.attrs {
		attrs[a.Key] = a.Value.Any()
	}
	// Add record attrs.
	r.Attrs(func(a slog.Attr) bool {
		key := a.Key
		if len(rh.groups) > 0 {
			key = strings.Join(rh.groups, ".") + "." + key
		}
		attrs[key] = a.Value.Any()
		return true
	})

	var attrsJSON string
	if len(attrs) > 0 {
		if b, err := json.Marshal(attrs); err == nil {
			attrsJSON = string(b)
		}
	}

	rh.buf.Write(LogEntry{
		Timestamp: r.Time.Format(time.RFC3339Nano),
		Level:     r.Level.String(),
		Message:   r.Message,
		Source:    source,
		Attrs:     attrsJSON,
	})
}

func (rh *ringHandler) withAttrs(attrs []slog.Attr) *ringHandler {
	combined := make([]slog.Attr, len(rh.attrs)+len(attrs))
	copy(combined, rh.attrs)
	copy(combined[len(rh.attrs):], attrs)
	return &ringHandler{
		buf:    rh.buf,
		level:  rh.level,
		attrs:  combined,
		groups: rh.groups,
	}
}

func (rh *ringHandler) withGroup(name string) *ringHandler {
	groups := make([]string, len(rh.groups)+1)
	copy(groups, rh.groups)
	groups[len(rh.groups)] = name
	return &ringHandler{
		buf:    rh.buf,
		level:  rh.level,
		attrs:  rh.attrs,
		groups: groups,
	}
}

// categorizeSource extracts a human-readable source category from the log record.
func categorizeSource(r slog.Record) string {
	if r.PC == 0 {
		return "server"
	}
	// Use runtime frame to get the source file path.
	frames := runtime.CallersFrames([]uintptr{r.PC})
	frame, _ := frames.Next()
	file := frame.File
	switch {
	case strings.Contains(file, "/ws/"):
		return "websocket"
	case strings.Contains(file, "/api/"):
		return "http"
	case strings.Contains(file, "/admin/"):
		return "admin"
	case strings.Contains(file, "/auth/"):
		return "auth"
	case strings.Contains(file, "/db/"):
		return "database"
	case strings.Contains(file, "/storage/"):
		return "storage"
	case strings.Contains(file, "/updater/"):
		return "updater"
	case strings.Contains(file, "/config/"):
		return "config"
	default:
		return "server"
	}
}

// handleLogStream serves an SSE endpoint that streams log entries in real-time.
// Auth is via query param ?ticket= — a short-lived single-use ticket obtained
// from POST /admin/api/logs/ticket (which requires normal admin auth).
func handleLogStream(database *db.DB, ringBuf *RingBuffer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Authenticate via single-use ticket.
		ticket := r.URL.Query().Get("ticket")
		entry, ok := logTickets.redeem(ticket)
		if ticket == "" || !ok {
			errResp, _ := json.Marshal(map[string]string{
				"error":   "UNAUTHORIZED",
				"message": "invalid or expired ticket",
			})
			http.Error(w, string(errResp), http.StatusUnauthorized)
			return
		}
		sess, err := database.GetSessionByTokenHash(entry.tokenHash)
		if err != nil || sess == nil || auth.IsSessionExpired(sess.ExpiresAt) {
			errResp, _ := json.Marshal(map[string]string{
				"error":   "UNAUTHORIZED",
				"message": "invalid or expired session",
			})
			http.Error(w, string(errResp), http.StatusUnauthorized)
			return
		}
		sessionStillAuthorized := func() bool {
			current, currentErr := database.GetSessionByTokenHash(entry.tokenHash)
			if currentErr != nil || current == nil || auth.IsSessionExpired(current.ExpiresAt) {
				return false
			}
			user, userErr := database.GetUserByID(current.UserID)
			if userErr != nil || user == nil {
				return false
			}
			role, roleErr := database.GetRoleByID(user.RoleID)
			if roleErr != nil || role == nil {
				return false
			}
			return permissions.HasAdmin(role.Permissions)
		}
		if !sessionStillAuthorized() {
			errResp, _ := json.Marshal(map[string]string{
				"error":   "FORBIDDEN",
				"message": "administrator permission required",
			})
			http.Error(w, string(errResp), http.StatusForbidden)
			return
		}

		// Check that we can flush (required for SSE).
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		// Set SSE headers.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		// Send backfill.
		for _, entry := range ringBuf.Snapshot() {
			if !sessionStillAuthorized() {
				return
			}
			if data, err := json.Marshal(entry); err == nil {
				_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
			}
		}
		flusher.Flush()

		// Subscribe for new entries.
		ch, unsub := ringBuf.Subscribe()
		defer unsub()

		// Keepalive ticker to avoid WriteTimeout (30s).
		keepalive := time.NewTicker(15 * time.Second)
		defer keepalive.Stop()

		ctx := r.Context()
		for {
			select {
			case entry := <-ch:
				if !sessionStillAuthorized() {
					return
				}
				if data, err := json.Marshal(entry); err == nil {
					_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
					flusher.Flush()
				}
			case <-keepalive.C:
				if !sessionStillAuthorized() {
					return
				}
				_, _ = fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
			case <-ctx.Done():
				return
			}
		}
	}
}
