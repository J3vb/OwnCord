package ws

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
)

// LiveKitProcessStatus is the supervisor's local state: whether a companion is
// running, how many times it restarted after an unexpected exit, and whether
// it gave up. Reading it probes nothing. Split from livekit_process.go to keep
// that file within the repository's size limit.
type LiveKitProcessStatus struct {
	Running  bool
	Restarts int
	GaveUp   bool
}

// Status reports the companion's local state. Nil-safe: a nil manager means
// LiveKit is externally managed, which callers read as "don't check".
func (p *LiveKitProcess) Status() LiveKitProcessStatus {
	if p == nil {
		return LiveKitProcessStatus{}
	}
	return LiveKitProcessStatus{
		Running:  p.IsRunning(),
		Restarts: int(p.restarts.Load()),
		GaveUp:   p.gaveUp.Load(),
	}
}

// liveKitLogPrefix identifies lines the supervisor writes on the companion's
// behalf, so a reader can tell them from LiveKit's own output.
const liveKitLogPrefix = "livekit: "

// liveKitMaxLine caps one companion log line routed into slog, so a binary
// that never emits a newline cannot grow the buffer without bound. LiveKit
// lines are far shorter; the cap only ever truncates a misbehaving stream.
const liveKitMaxLine = 8 << 10

// liveKitLogWriter routes the companion's stdout and stderr into slog, line by
// line, with component=livekit — so ICE, port and key errors reach the ring
// buffer, the admin live log and the support bundle instead of only the
// process's own stdout. LiveKit's own log level word is mapped where present.
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
	// No newline yet and the partial line is over the cap: emit the capped
	// prefix so a stream with no newlines cannot grow without bound.
	if w.buf.Len() > liveKitMaxLine {
		w.emit(strings.TrimRight(w.buf.String(), "\r\n"))
		w.buf.Reset()
	}
	return len(p), nil
}

// emit logs one companion line at the level its own text names, defaulting to
// info, with the line length capped.
func (w *liveKitLogWriter) emit(line string) {
	if line == "" {
		return
	}
	if len(line) > liveKitMaxLine {
		line = line[:liveKitMaxLine] + "…(truncated)"
	}
	slog.Log(context.Background(), liveKitLineLevel(line), liveKitLogPrefix+line, "component", "livekit")
}

// liveKitLineLevel maps the level field LiveKit prints after its timestamp
// (zap's capitalised "DEBUG", "INFO", "WARN", "ERROR", "DPANIC", "PANIC" or
// "FATAL") to a slog level. Only that standalone field counts, so a message
// or an "error" field on a WARN line cannot change the level; a line without
// one is info.
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
