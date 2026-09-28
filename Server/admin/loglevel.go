package admin

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
)

// LogLevelController owns the runtime log-level override for a bounded window
// (SRE-07). An operator raises the level to debug to watch a problem live, and
// it reverts to the base level on its own — a boost that outlived its window
// would quietly grow disk use and log noise, and the base level is what the
// next restart returns to anyway.
type LogLevelController struct {
	level *slog.LevelVar
	// base is the level the server booted with and reverts to.
	base slog.Level

	mu       sync.Mutex
	timer    *time.Timer
	deadline time.Time
}

func NewLogLevelController(level *slog.LevelVar, base slog.Level) *LogLevelController {
	return &LogLevelController{level: level, base: base}
}

// Set applies name for the given window and returns the deadline it reverts
// at. durationSeconds of 0 or less means no timed revert is wanted for this
// override — but the API layer requires a positive window, so only tests pass
// zero.
func (c *LogLevelController) Set(name string, window time.Duration) (time.Time, error) {
	level, ok := config.ParseLevel(name)
	if !ok {
		return time.Time{}, fmt.Errorf("unknown log level %q", name)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	c.level.Set(level)
	c.deadline = time.Time{}
	if window <= 0 {
		return time.Time{}, nil
	}
	c.deadline = time.Now().Add(window)
	c.timer = time.AfterFunc(window, c.revert)
	return c.deadline, nil
}

// revert restores the base level when the window elapses.
func (c *LogLevelController) revert() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.timer = nil
	c.deadline = time.Time{}
	c.level.Set(c.base)
}

// Current reports the level in force and, when a timed boost is active, when
// it reverts. The name is the lower-case form the API and config share.
func (c *LogLevelController) Current() (string, *time.Time) {
	name := levelName(c.level.Level())
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deadline.IsZero() {
		return name, nil
	}
	deadline := c.deadline
	return name, &deadline
}

// Close stops a pending revert. The server is exiting with the level it is
// running; a timer firing against a dead process is pointless.
func (c *LogLevelController) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
}

func levelName(level slog.Level) string {
	switch {
	case level <= slog.LevelDebug:
		return "debug"
	case level < slog.LevelWarn:
		return "info"
	case level < slog.LevelError:
		return "warn"
	default:
		return "error"
	}
}

// logLevelRequest is PATCH /logs/level's body: a level name and a window in
// seconds. Both are required — a window-less override is the restart-only
// behaviour SRE-07 exists to replace.
type logLevelRequest struct {
	Level           string `json:"level"`
	DurationSeconds int    `json:"duration_seconds"`
}

// maxLogLevelWindow bounds a boost so one request cannot pin debug for days.
const maxLogLevelWindow = 24 * time.Hour

// logLevelResponse is GET/PATCH /logs/level: the level in force and, for a
// timed boost, when it reverts (empty for a level with no pending revert).
type logLevelResponse struct {
	Level     string `json:"level"`
	RevertsAt string `json:"reverts_at,omitempty"`
}

func handleGetLogLevel(c *LogLevelController) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if c == nil {
			writeErr(w, http.StatusServiceUnavailable, "CONFIG_UNAVAILABLE", "running configuration unavailable")
			return
		}
		level, deadline := c.Current()
		resp := logLevelResponse{Level: level}
		if deadline != nil {
			resp.RevertsAt = deadline.Format(time.RFC3339)
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func handleSetLogLevel(c *LogLevelController) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c == nil {
			writeErr(w, http.StatusServiceUnavailable, "CONFIG_UNAVAILABLE", "running configuration unavailable")
			return
		}
		var req logLevelRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
			return
		}
		req.Level = strings.TrimSpace(req.Level)
		if req.Level == "" {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "level is required")
			return
		}
		if req.DurationSeconds < 1 || time.Duration(req.DurationSeconds)*time.Second > maxLogLevelWindow {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "duration_seconds must be between 1 and 86400")
			return
		}
		deadline, err := c.Set(req.Level, time.Duration(req.DurationSeconds)*time.Second)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, logLevelResponse{Level: req.Level, RevertsAt: deadline.Format(time.RFC3339)})
	}
}
