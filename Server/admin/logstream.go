package admin

import (
	"bytes"
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
	"sync"
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

// LogEntry holds a single structured log record for the ring buffer.
type LogEntry struct {
	Timestamp string `json:"ts"`
	Level     string `json:"level"`
	Message   string `json:"msg"`
	Source    string `json:"source"`
	Attrs     string `json:"attrs,omitempty"`
}

// RingBuffer is a bounded, thread-safe circular buffer of log entries with
// fan-out to SSE subscriber channels. It is a true ring (fixed backing array +
// write position, like ws.EventRingBuffer), so overwriting the oldest entry is
// a single slot store rather than an allocation + copy per write.
type RingBuffer struct {
	mu  syncutil.Mutex
	all logRing
	// warn holds the last supportEventsMax WARN-and-above entries, so an
	// INFO/DEBUG burst longer than all cannot evict a failure from the
	// support bundle.
	warn        logRing
	subscribers map[*chan LogEntry]struct{}
	streamsEnd  chan struct{} // closed by EndStreams
	endOnce     sync.Once
}

// NewRingBuffer creates a ring buffer with the given capacity (must be > 0).
func NewRingBuffer(capacity int) *RingBuffer {
	return &RingBuffer{
		all:         logRing{entries: make([]LogEntry, capacity)},
		warn:        logRing{entries: make([]LogEntry, supportEventsMax)},
		subscribers: make(map[*chan LogEntry]struct{}),
		streamsEnd:  make(chan struct{}),
	}
}

// EndStreams ends every open log stream, and any opened after it, for good.
// The server registers it with http.Server.RegisterOnShutdown: a stream never
// returns on its own and Shutdown waits for every active handler, so an open
// Logs tab would hold the drain for its whole budget. Safe to call more than
// once.
func (rb *RingBuffer) EndStreams() {
	rb.endOnce.Do(func() { close(rb.streamsEnd) })
}

// Write appends an entry, overwriting the oldest if full, and fans out
// to all subscribers (non-blocking to avoid slow clients blocking logging).
func (rb *RingBuffer) Write(entry LogEntry) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	rb.all.push(entry)
	if isWarnLevel(entry.Level) {
		rb.warn.push(entry)
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
	return rb.all.snapshot()
}

// supportSnapshot returns every entry, oldest first, preceded by any of the
// last supportEventsMax WARN-and-above entries the general ring has already
// evicted. The warn ring's newest entries are the WARN+ entries still in the
// general ring, so only its older surplus is prepended.
func (rb *RingBuffer) supportSnapshot() []LogEntry {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	all, warn := rb.all.snapshot(), rb.warn.snapshot()
	retained := 0
	for _, entry := range all {
		if isWarnLevel(entry.Level) {
			retained++
		}
	}
	if evicted := len(warn) - retained; evicted > 0 {
		return append(warn[:evicted:evicted], all...)
	}
	return all
}

// isWarnLevel reports whether a LogEntry level is WARN or above.
func isWarnLevel(level string) bool {
	return level == "WARN" || level == "ERROR"
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
// Two separate calls (Snapshot() then Subscribe()) leave a window where an
// entry written in between reaches neither the backfill nor the live feed,
// because Write's fan-out only reaches registered subscribers. The window is
// not instantaneous: handleLogStream runs a token-resolution DB round-trip per
// backfill chunk.
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

// logAttrValue converts an slog.Value to the value stored in the ring buffer's
// JSON attrs, matching slog's own JSONHandler for stdout:
//
//   - Resolve() first, so an slog.LogValuer (db.User, db.Session, config.Config
//     and its secret-bearing sections) is redacted before it reaches JSON.
//     Record.Attrs does not resolve on its own, so without this the ring
//     buffer would bypass redaction that stdout honors.
//   - error values marshal to "{}" (only unexported fields), so they are
//     rendered as their Error() string instead.
//   - a resolved group is walked into a map instead of json.Marshal-ed as-is:
//     a bare []slog.Attr marshals to "{}" per element. Resolve() only resolves
//     the outer LogValuer, so nested group members are resolved by the same
//     recursive call.
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
	return func(w http.ResponseWriter, r *http.Request) {
		principalStillAuthorized, ok := logStreamAuthorize(w, r, database)
		if !ok {
			return
		}
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
			case <-ringBuf.streamsEnd:
				return
			}
		}
	}
}
