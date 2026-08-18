package admin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
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
// POST /admin/api/logs/ticket — requires normal admin auth (header). The ticket
// is bound to the hash of whichever bearer credential authenticated the request
// (login session or API token), so both principal kinds can stream logs.
func handleLogTicket(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hash, ok := r.Context().Value(adminTokenHashKey).(string)
		if !ok || hash == "" {
			writeErr(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid or expired session")
			return
		}

		ticket, err := logTickets.issue(hash)
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
//
// It is a true ring (fixed backing array + write position), modelled on
// ws.EventRingBuffer: overwriting the oldest entry is a single slot store,
// not a fresh capacity-sized allocation + copy per write.
type RingBuffer struct {
	mu          syncutil.Mutex
	entries     []LogEntry // fixed backing array, len == capacity
	pos         int        // next write position
	count       int        // entries stored (up to len(entries))
	subscribers map[*chan LogEntry]struct{}
}

// NewRingBuffer creates a ring buffer with the given capacity (must be > 0).
func NewRingBuffer(capacity int) *RingBuffer {
	return &RingBuffer{
		entries:     make([]LogEntry, capacity),
		subscribers: make(map[*chan LogEntry]struct{}),
	}
}

// Write appends an entry, overwriting the oldest if full, and fans out
// to all subscribers (non-blocking to avoid slow clients blocking logging).
func (rb *RingBuffer) Write(entry LogEntry) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	rb.entries[rb.pos] = entry
	rb.pos = (rb.pos + 1) % len(rb.entries)
	if rb.count < len(rb.entries) {
		rb.count++
	}

	for chp := range rb.subscribers {
		select {
		case *chp <- entry:
		default:
			// Slow subscriber — drop to avoid blocking.
		}
	}
}

// Snapshot returns a copy of all current entries, oldest first, for backfill.
func (rb *RingBuffer) Snapshot() []LogEntry {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	return rb.snapshotLocked()
}

// snapshotLocked is Snapshot's body, callable by callers that already hold
// rb.mu (SnapshotAndSubscribe needs the copy and the subscription to happen
// under the same critical section).
func (rb *RingBuffer) snapshotLocked() []LogEntry {
	out := make([]LogEntry, rb.count)
	if rb.count < len(rb.entries) {
		// Not yet wrapped: entries [0, count) are already in order.
		copy(out, rb.entries[:rb.count])
		return out
	}
	// Wrapped: oldest entry sits at pos.
	n := copy(out, rb.entries[rb.pos:])
	copy(out[n:], rb.entries[:rb.pos])
	return out
}

// Subscribe creates a buffered channel for a new SSE client.
// Returns the channel and an unsubscribe function.
func (rb *RingBuffer) Subscribe() (<-chan LogEntry, func()) {
	rb.mu.Lock()
	ch, unsub := rb.subscribeLocked()
	rb.mu.Unlock()
	return ch, unsub
}

// subscribeLocked is Subscribe's body, callable by callers that already hold
// rb.mu.
func (rb *RingBuffer) subscribeLocked() (<-chan LogEntry, func()) {
	ch := make(chan LogEntry, 64)
	chp := &ch
	rb.subscribers[chp] = struct{}{}

	return ch, func() {
		rb.mu.Lock()
		delete(rb.subscribers, chp)
		rb.mu.Unlock()
	}
}

// SnapshotAndSubscribe atomically copies the current backfill entries and
// registers a new subscriber channel under a single lock acquisition.
//
// Doing this as two separate calls (Snapshot() then Subscribe()) leaves a
// window between them where Write's fan-out — which only reaches entries
// already in rb.subscribers — cannot deliver to a caller that has not
// subscribed yet, while the caller's snapshot was already taken and will
// never include it either. Any entry written in that window is lost from
// both the backfill and the live feed. handleLogStream's window is not
// instantaneous: a token-resolution DB round-trip runs per backfilled entry
// before the (formerly) separate Subscribe() call.
func (rb *RingBuffer) SnapshotAndSubscribe() ([]LogEntry, <-chan LogEntry, func()) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	out := rb.snapshotLocked()
	ch, unsub := rb.subscribeLocked()
	return out, ch, unsub
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
// and the ring buffer. The ring buffer captures all levels from minLevel;
// pass a *slog.LevelVar to retune the threshold at runtime. Enabled reports
// false below both thresholds, so gated Debug calls cost nothing.
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

// logAttrValue converts an slog.Value to the value stored in the ring
// buffer's JSON attrs, matching what slog's own JSONHandler does for stdout
// (see appendJSONValue in log/slog/json_handler.go):
//
//   - Resolve() first, so an slog.LogValuer (db.User, db.Session,
//     config.Config and its secret-bearing sections — see
//     Server/db/logvalue.go and Server/config/logvalue.go) is redacted before
//     it reaches JSON. Record.Attrs does not resolve on its own, so without
//     this the ring buffer bypasses that redaction even though stdout honors it.
//   - error values marshal to "{}" (errors.errorString / fmt.wrapError have
//     only unexported fields), so an error not otherwise handled by
//     json.Marshal is rendered as its Error() string instead.
//   - a resolved group (LogValue returning slog.GroupValue, as every type
//     above does) is walked into a map instead of json.Marshal-ed as-is: a
//     bare []slog.Attr marshals to "{}" per element, since slog.Value's
//     fields are unexported. Resolve() only resolves the outer LogValuer, not
//     nested ones (see its doc comment), so nested group members are resolved
//     by this same recursive call.
func logAttrValue(v slog.Value) any {
	v = v.Resolve()
	if v.Kind() == slog.KindGroup {
		group := v.Group()
		m := make(map[string]any, len(group))
		for _, a := range group {
			m[a.Key] = logAttrValue(a.Value)
		}
		return m
	}
	a := v.Any()
	if err, ok := a.(error); ok {
		if _, isJSONMarshaler := a.(json.Marshaler); !isJSONMarshaler {
			return err.Error()
		}
	}
	return a
}

func (rh *ringHandler) Handle(r slog.Record) {
	// Build source from file path.
	source := categorizeSource(r)

	// Collect attributes as a JSON object.
	attrs := make(map[string]any)
	// Add pre-set attrs from WithAttrs.
	for _, a := range rh.attrs {
		attrs[a.Key] = logAttrValue(a.Value)
	}
	// Add record attrs.
	r.Attrs(func(a slog.Attr) bool {
		key := a.Key
		if len(rh.groups) > 0 {
			key = strings.Join(rh.groups, ".") + "." + key
		}
		attrs[key] = logAttrValue(a.Value)
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

// logStreamAuthorize runs the log stream's authentication prologue: it redeems
// the single-use ticket, resolves the principal behind it, and returns the
// re-check closure the stream must call before every write. It writes the error
// response itself and reports false when the caller must stop.
func logStreamAuthorize(w http.ResponseWriter, r *http.Request, database *db.DB) (func() bool, bool) {
	// Authenticate via single-use ticket.
	ticket := r.URL.Query().Get("ticket")
	entry, ok := logTickets.redeem(ticket)
	if ticket == "" || !ok {
		errResp, _ := json.Marshal(map[string]string{
			"error":   "UNAUTHORIZED",
			"message": "invalid or expired ticket",
		})
		http.Error(w, string(errResp), http.StatusUnauthorized)
		return nil, false
	}
	// Stream lifetime == request lifetime, so all principal re-checks below
	// use the stream request's context. The ticket's hash is resolved the
	// same way adminAuthMiddleware resolves a bearer credential — login
	// session first, then API token — so revoking either kind mid-stream
	// cuts the stream.
	ctx := r.Context()
	user, role, _, err := auth.ResolveTokenHash(ctx, database, entry.tokenHash)
	if err != nil || user == nil || role == nil {
		errResp, _ := json.Marshal(map[string]string{
			"error":   "UNAUTHORIZED",
			"message": "invalid or expired session",
		})
		http.Error(w, string(errResp), http.StatusUnauthorized)
		return nil, false
	}
	principalStillAuthorized := func() bool {
		current, currentRole, _, resolveErr := auth.ResolveTokenHash(ctx, database, entry.tokenHash)
		if resolveErr != nil || current == nil || currentRole == nil {
			return false
		}
		// A ban mid-stream must cut the stream, same as adminAuthMiddleware
		// rejects a banned user on the request path.
		if auth.IsEffectivelyBanned(current) {
			return false
		}
		return permissions.HasAdmin(currentRole.Permissions)
	}
	if !principalStillAuthorized() {
		errResp, _ := json.Marshal(map[string]string{
			"error":   "FORBIDDEN",
			"message": "administrator permission required",
		})
		http.Error(w, string(errResp), http.StatusForbidden)
		return nil, false
	}
	return principalStillAuthorized, true
}

// handleLogStream serves an SSE endpoint that streams log entries in real-time.
// Auth is via query param ?ticket= — a short-lived single-use ticket obtained
// from POST /admin/api/logs/ticket (which requires normal admin auth).
func handleLogStream(database *db.DB, ringBuf *RingBuffer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principalStillAuthorized, ok := logStreamAuthorize(w, r, database)
		if !ok {
			return
		}
		ctx := r.Context()

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

		// This handler streams through the ordinary ResponseWriter (no
		// Hijack), so it is otherwise subject to http.Server.WriteTimeout:
		// net/http sets the connection's write deadline exactly once, when
		// request headers are read, and nothing about writing more data
		// later extends it. Without clearing it here, every write past that
		// deadline (including the keepalive ticks below) silently times out
		// — the caller discards write errors, per SSE convention, since a
		// client that vanishes is detected via ctx.Done() instead — so the
		// stream goes silently dead and the client eventually sees the
		// connection close, then reconnects and replays the full backfill.
		// SetWriteDeadline(zero) clears the deadline on HTTP/1 and cancels
		// the per-stream deadline timer on HTTP/2; ErrNotSupported means the
		// ResponseWriter doesn't sit over a real connection (e.g. in tests),
		// which is fine to ignore.
		if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
			slog.Warn("log stream: failed to clear write deadline; stream may be cut by WriteTimeout", "err", err)
		}

		// Snapshot the backfill and subscribe to new entries atomically: the
		// per-entry principalStillAuthorized() check below is a DB round-trip,
		// so the backfill loop is slow enough that a Snapshot()-then-Subscribe()
		// gap would silently drop any entry written in between (v059).
		backfill, ch, unsub := ringBuf.SnapshotAndSubscribe()
		defer unsub()

		// Send backfill.
		for _, entry := range backfill {
			if !principalStillAuthorized() {
				return
			}
			if data, err := json.Marshal(entry); err == nil {
				_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
			}
		}
		flusher.Flush()

		// Keepalive ticker against intermediary/proxy idle timeouts (the
		// connection's own WriteTimeout was already neutralized above).
		keepalive := time.NewTicker(15 * time.Second)
		defer keepalive.Stop()

		for {
			select {
			case entry := <-ch:
				if !principalStillAuthorized() {
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
			}
		}
	}
}
