package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

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
	mu          sync.Mutex
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
		rb.entries = rb.entries[1:]
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

func (h *multiHandler) Enabled(_ context.Context, level slog.Level) bool {
	return h.stdout.Enabled(context.Background(), level) || h.ring.Enabled(level)
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

// authenticateAdmin validates a raw token string and returns the user
// if they have ADMINISTRATOR permission. Used by both adminAuthMiddleware
// and the SSE log stream endpoint.
func authenticateAdmin(database *db.DB, rawToken string) (*db.User, error) {
	if rawToken == "" {
		return nil, fmt.Errorf("missing token")
	}
	hash := auth.HashToken(rawToken)
	sess, err := database.GetSessionByTokenHash(hash)
	if err != nil || sess == nil {
		return nil, fmt.Errorf("invalid session")
	}
	if auth.IsSessionExpired(sess.ExpiresAt) {
		return nil, fmt.Errorf("session expired")
	}
	user, err := database.GetUserByID(sess.UserID)
	if err != nil || user == nil {
		return nil, fmt.Errorf("user not found")
	}
	role, err := database.GetRoleByID(user.RoleID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("role not found")
	}
	if !permissions.HasAdmin(role.Permissions) {
		return nil, fmt.Errorf("administrator permission required")
	}
	return user, nil
}

// handleLogStream serves an SSE endpoint that streams log entries in real-time.
// Auth is via query param ?token= since EventSource cannot send headers.
func handleLogStream(ringBuf *RingBuffer, database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Authenticate via query param.
		rawToken := r.URL.Query().Get("token")
		if _, err := authenticateAdmin(database, rawToken); err != nil {
			errResp, _ := json.Marshal(map[string]string{
				"error":   "UNAUTHORIZED",
				"message": err.Error(),
			})
			http.Error(w, string(errResp), http.StatusUnauthorized)
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
				if data, err := json.Marshal(entry); err == nil {
					_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
					flusher.Flush()
				}
			case <-keepalive.C:
				_, _ = fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
			case <-ctx.Done():
				return
			}
		}
	}
}
