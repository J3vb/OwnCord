package livekitproc

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"time"
)

// Status is the supervisor's local state: running, restart count and whether it
// gave up. Reading it probes nothing.
type Status struct {
	Running  bool
	Restarts int
	GaveUp   bool
	// NextRetryAt is when the slow tier retries; zero unless waiting there.
	NextRetryAt time.Time
}

// Status reports the companion's local state. Nil-safe: a nil manager means LiveKit is externally managed
// ("don't check").
func (p *Process) Status() Status {
	if p == nil {
		return Status{}
	}
	p.mu.Lock()
	running := p.cmd != nil && p.cmd.Process != nil
	next := p.nextRetry
	p.mu.Unlock()
	return Status{
		Running:  running,
		Restarts: int(p.restarts.Load()),
		// A running slow-tier attempt is not given up (voice works); the flag stays until a run proves stable.
		GaveUp:      p.gaveUp.Load() && !running,
		NextRetryAt: next,
	}
}

// liveKitMaxLine caps one companion log line so a stream with no newline cannot grow the buffer.
const liveKitMaxLine = 8 << 10

// liveKitLogWriter routes the companion's output into slog line by line with
// component=livekit, so ICE, port and key errors reach the log views and
// support bundle. LiveKit's own level word is mapped where present.
type liveKitLogWriter struct {
	buf bytes.Buffer
}

func (w *liveKitLogWriter) Write(p []byte) (int, error) {
	w.buf.Write(p)
	for {
		i := bytes.IndexByte(w.buf.Bytes(), '\n')
		if i < 0 {
			break
		}
		line := string(w.buf.Next(i + 1))
		w.emit(strings.TrimRight(line, "\r\n"))
	}
	// Over the cap with no newline: emit the capped prefix.
	if w.buf.Len() > liveKitMaxLine {
		w.emit(strings.TrimRight(w.buf.String(), "\r\n"))
		w.buf.Reset()
	}
	return len(p), nil
}

// emit logs one line at the level its text names (default info), length-capped.
func (w *liveKitLogWriter) emit(line string) {
	if line == "" {
		return
	}
	if len(line) > liveKitMaxLine {
		line = line[:liveKitMaxLine] + "…(truncated)"
	}
	slog.Log(context.Background(), liveKitLineLevel(line), "livekit companion output", "line", line, "component", "livekit")
}

// liveKitLineLevel maps the level field LiveKit prints after its timestamp
// (zap's DEBUG/INFO/WARN/ERROR/DPANIC/PANIC/FATAL) to a slog level. Only that
// standalone field counts, so a message or "error" field cannot change it.
func liveKitLineLevel(line string) slog.Level {
	fields := strings.Fields(line)
	for _, f := range fields[:min(2, len(fields))] {
		switch f {
		case "DEBUG":
			return slog.LevelDebug
		case "INFO":
			return slog.LevelInfo
		case "WARN":
			return slog.LevelWarn
		case "ERROR", "DPANIC", "PANIC", "FATAL":
			return slog.LevelError
		}
	}
	return slog.LevelInfo
}
