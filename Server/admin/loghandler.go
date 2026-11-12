package admin

import (
	"context"
	"encoding/json"
	"log/slog"
	"runtime"
	"strings"
	"time"
)

// multiHandler tees records to the stdout handler and a ring buffer handler.
type multiHandler struct {
	stdout slog.Handler
	ring   *ringHandler
}

// ringHandler converts slog.Records into LogEntries for the RingBuffer.
type ringHandler struct {
	buf    *RingBuffer
	level  slog.Leveler
	attrs  []slog.Attr
	groups []string
}

// NewMultiHandler sends records to stdout and the ring buffer (all levels from minLevel; pass a
// *slog.LevelVar to retune at runtime). Enabled reports false below both thresholds, so gated Debug calls
// cost nothing.
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

// logAttrValue converts an slog.Value to the value stored in the ring buffer's JSON attrs, matching slog's
// JSONHandler for stdout. Resolve() runs first so an slog.LogValuer (db.User, db.Session, config.Config and
// its secret-bearing sections) is redacted: Record.Attrs does not resolve, so without it the ring buffer
// would bypass redaction stdout honors. Errors marshal to "{}" (only unexported fields), so they render as
// Error(). A resolved group is walked into a map, since a bare []slog.Attr marshals to "{}" per element;
// nested members resolve by the same recursive call.
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
	source := categorizeSource(r)

	attrs := make(map[string]any)
	for _, a := range rh.attrs {
		attrs[a.Key] = logAttrValue(a.Value)
	}
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

func categorizeSource(r slog.Record) string {
	if r.PC == 0 {
		return "server"
	}
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
