package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
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
	// gen identifies the latest Boost, so a revert whose timer fired while a
	// newer Boost or Revert held mu cannot undo it.
	gen uint64
}

func NewLogLevelController(level *slog.LevelVar, base slog.Level) *LogLevelController {
	return &LogLevelController{level: level, base: base}
}

// Boost raises the level to debug for window and returns the deadline it
// reverts at. Every boost is timed: a non-positive window is refused.
func (c *LogLevelController) Boost(window time.Duration) (time.Time, error) {
	if window <= 0 {
		return time.Time{}, fmt.Errorf("log level window must be positive, got %s", window)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	c.level.Set(slog.LevelDebug)
	c.gen++
	gen := c.gen
	c.deadline = time.Now().Add(window)
	c.timer = time.AfterFunc(window, func() { c.revert(gen) })
	return c.deadline, nil
}

// Revert restores the base level at once and cancels a pending timed revert.
func (c *LogLevelController) Revert() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	c.resetLocked()
}

// revert restores the base level when window gen elapses. A stale gen is a
// superseded window and does nothing.
func (c *LogLevelController) revert(gen uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if gen != c.gen {
		return
	}
	// Logged before the level drops, so the line survives a warn or error base.
	slog.Info("server log level window elapsed, reverting", "level", levelName(c.base))
	c.resetLocked()
}

func (c *LogLevelController) resetLocked() {
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
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
	c.gen++
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

// logLevelRequest is PATCH /logs/level's body. The only boost on offer is
// debug for logLevelBoostWindow; both fields are required and must match, so
// the endpoint cannot quieten the server or pin a level for longer.
type logLevelRequest struct {
	Level           string `json:"level"`
	DurationSeconds int    `json:"duration_seconds"`
}

const logLevelBoostWindow = 15 * time.Minute

// logLevelResponse is GET/PATCH/DELETE /logs/level: the level in force, the base
// level it reverts to, and, for a timed boost, when it reverts (empty for a
// level with no pending revert).
type logLevelResponse struct {
	Level     string `json:"level"`
	BaseLevel string `json:"base_level"`
	RevertsAt string `json:"reverts_at,omitempty"`
}

func writeLogLevel(w http.ResponseWriter, c *LogLevelController) {
	level, deadline := c.Current()
	resp := logLevelResponse{Level: level, BaseLevel: levelName(c.base)}
	if deadline != nil {
		resp.RevertsAt = deadline.Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, resp)
}

func handleGetLogLevel(c *LogLevelController) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if c == nil {
			writeErr(w, http.StatusServiceUnavailable, "CONFIG_UNAVAILABLE", "running configuration unavailable")
			return
		}
		writeLogLevel(w, c)
	}
}

func handleSetLogLevel(database *db.DB, c *LogLevelController) http.HandlerFunc {
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
		if req.Level != "debug" || req.DurationSeconds != int(logLevelBoostWindow/time.Second) {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", `only {"level":"debug","duration_seconds":900} is accepted`)
			return
		}
		if _, err := c.Boost(logLevelBoostWindow); err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
			return
		}
		actor := actorFromContext(r)
		slog.Info("server log level raised to debug", "actor_id", actor, "window", logLevelBoostWindow.String())
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "log_level_debug_on", "server", 0,
			"debug logging on for 15 minutes")
		writeLogLevel(w, c)
	}
}

func handleRevertLogLevel(database *db.DB, c *LogLevelController) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c == nil {
			writeErr(w, http.StatusServiceUnavailable, "CONFIG_UNAVAILABLE", "running configuration unavailable")
			return
		}
		actor := actorFromContext(r)
		base := levelName(c.base)
		// Logged before the revert, so the line survives a warn or error base.
		slog.Info("server log level reverted", "actor_id", actor, "level", base)
		c.Revert()
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "log_level_reverted", "server", 0,
			"log level reverted to "+base)
		writeLogLevel(w, c)
	}
}
