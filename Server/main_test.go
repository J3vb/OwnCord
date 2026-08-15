package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"go.uber.org/goleak"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// TestRun_ServeErrorReturn_StopsHubDispatchGoroutine pins OC-0027:
// hub.GracefulStop() (the only caller of LiveKitProcess.Stop(), and what
// closes the hub's dispatch goroutine) is a plain statement reached only on
// the graceful-shutdown path. The serve-error branch — `case err :=
// <-serveErr: ... return fmt.Errorf(...)` — returns from run() before ever
// reaching it, so the hub's `go hub.Run()` dispatch goroutine (started by
// api.NewRouter) is left running, and in production the companion
// livekit-server process it owns is left running with it.
//
// An out-of-range port fails the first listen attempt with an error that
// isAddrInUse does not recognize, so run() takes the servErr branch
// immediately instead of retrying for ~10s.
func TestRun_ServeErrorReturn_StopsHubDispatchGoroutine(t *testing.T) {
	t.Chdir(t.TempDir())

	t.Setenv("OWNCORD_SERVER_PORT", "99999")                 // out of range: immediate, non-retryable listen error
	t.Setenv("OWNCORD_TLS_MODE", "off")                      // skip self-signed cert generation
	t.Setenv("OWNCORD_VOICE_AUTO_DOWNLOAD_LIVEKIT", "false") // the generated default config.yaml turns this on; keep the test offline

	logBuf := admin.NewRingBuffer(64)
	levelVar := new(slog.LevelVar)
	log := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: levelVar}))

	leakOpt := goleak.IgnoreCurrent()

	if err := run(log, logBuf, levelVar); err == nil {
		t.Fatal("expected run() to return an error for an out-of-range port")
	}

	// hub.Run's dispatch goroutine only exits once hub.stop is closed, which
	// only happens inside hub.GracefulStop(). If run() returned without
	// calling it, this goroutine is still alive here.
	if err := goleak.Find(leakOpt); err != nil {
		t.Fatalf("hub dispatch goroutine (and, in production, its LiveKit process) leaked after run() returned early: %v", err)
	}
}

// TestSeedHubReplayState_ForcesFullResyncForOfflineClient pins OC-0204:
// h.seq is persisted (events table) and restored at startup via SeedSeq, but
// its paired in-memory watermark (visibilityChangeSeq) always starts at 0 on
// a fresh process. mustFullResync short-circuits on `w > 0`, so without also
// forcing the watermark forward at startup, every client resuming from a
// last_seq at or before the just-restored max sails through mustFullResync
// and gets an ordinary tiered replay — even though a channel-visibility
// change made to it while offline (RefreshChannelVisibility,
// revokeUnreadableChannels) was sent only as a targeted, unsequenced message
// that was never persisted and can never be recovered by that replay.
//
// This seeds a DB with a contiguous run of persisted events (simulating a
// prior boot that reached seq 520), then calls seedHubReplayState exactly as
// run() does, then reconnects a client with last_seq=500 (<= the restored
// max) and asserts the resume is forced onto the full-ready tier. Before the
// fix, last_seq=500 converges via the ordinary DB cold-tier replay instead
// (the persisted run 501..520 is contiguous and complete), silently proving
// the bug: a resume that must be forced full sails through unforced.
func TestSeedHubReplayState_ForcesFullResyncForOfflineClient(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer database.Close() //nolint:errcheck
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	ctx := context.Background()

	// Simulate the prior boot: 20 persisted global (channel_id=0) events at
	// seqs 501..520, contiguous and complete — exactly the shape that lets
	// handleReconnect's DB-tier contiguity/tail checks succeed today.
	for seq := int64(501); seq <= 520; seq++ {
		payload := fmt.Appendf(nil, `{"seq":%d,"type":"broadcast"}`, seq)
		if err := database.PersistEvent(ctx, seq, "broadcast", 0, payload); err != nil {
			t.Fatalf("PersistEvent seq=%d: %v", seq, err)
		}
	}

	userID, err := database.CreateUser(ctx, "seed-replay-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter, nil)
	go hub.Run()
	defer hub.Stop()

	// The exact startup call run() makes once event persistence is enabled —
	// no ring-buffer events are pushed, so a resuming client's replay can
	// only be satisfied via the DB cold tier or forced full.
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	seedHubReplayState(ctx, hub, database, log)
	hub.SetEventStore(database)

	handler := ws.ServeWS(hub, database, []string{"*"}, 0)
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, dialResp, dialErr := websocket.Dial(dialCtx, wsURL, nil)
	if dialResp != nil && dialResp.Body != nil {
		_ = dialResp.Body.Close()
	}
	if dialErr != nil {
		t.Fatalf("websocket.Dial: %v", dialErr)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// last_seq=500 predates the restored max (520): a client whose sidebar
	// missed a targeted visibility change while offline must be forced onto
	// the full-ready path to converge.
	authMsg := map[string]any{
		"type": "auth",
		"payload": map[string]any{
			"token":    token,
			"last_seq": uint64(500),
		},
	}
	raw, _ := json.Marshal(authMsg)
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	if _, _, err := conn.Read(dialCtx); err != nil {
		t.Fatalf("read handshake response: %v", err)
	}

	bufTier, dbTier, fullTier := hub.ReconnectTierStats()
	if fullTier != 1 {
		t.Fatalf("reconnect tiers (buffer=%d db=%d full=%d): want full=1 — a client resuming from before a restart-restored seq must be forced onto the full-ready path, since an offline visibility change is never recoverable by replay",
			bufTier, dbTier, fullTier)
	}
}
