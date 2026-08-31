package app

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

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// TestRun_ServeErrorReturn_StopsHubDispatchGoroutine pins OC-0027:
// hub.GracefulStop() (the only caller of LiveKitProcess.Stop(), and what
// closes the hub's dispatch goroutine) is a plain statement reached only on
// the graceful-shutdown path. The serve-error branch — `case err :=
// <-serveErr: ... return fmt.Errorf(...)` — returns from Run before ever
// reaching it, so the hub's `go hub.Run()` dispatch goroutine (started by
// api.NewRouter) is left running, and in production the companion
// livekit-server process it owns is left running with it.
//
// An out-of-range port fails the first listen attempt with an error that
// isAddrInUse does not recognize, so Run takes the servErr branch
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

	rc := NewRestartCoordinator(time.Hour, nil)
	if err := runApp(log, logBuf, levelVar, rc); err == nil {
		t.Fatal("expected Run to return an error for an out-of-range port")
	}
	if _, requested := rc.Requested(); requested {
		t.Error("no restart was requested, but the coordinator reports one")
	}

	// hub.Run's dispatch goroutine only exits once hub.stop is closed, which
	// only happens inside hub.GracefulStop(). If Run returned without
	// calling it, this goroutine is still alive here.
	if err := goleak.Find(leakOpt); err != nil {
		t.Fatalf("hub dispatch goroutine (and, in production, its LiveKit process) leaked after Run returned early: %v", err)
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
// Run does, then reconnects a client with last_seq=500 (<= the restored
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
	hub, hubErr := ws.NewHub(ws.HubOptions{DB: database, Limiter: limiter})
	if hubErr != nil {
		t.Fatalf("ws.NewHub: %v", hubErr)
	}
	go hub.Run()
	defer hub.Stop()

	// The exact startup call Run makes once event persistence is enabled —
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

// waitForFirstRingBufferEntry polls hub's ring buffer until it holds at
// least one entry and returns that entry's seq, or fails the test after a
// timeout. BroadcastToAll enqueues onto the hub's dispatch channel and
// returns before a seq is actually assigned, so tests that need to know a
// real assigned seq must synchronize on this instead of assuming one.
func waitForFirstRingBufferEntry(t *testing.T, hub *ws.Hub) uint64 {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if oldest := hub.ReplayBuffer().OldestSeq(); oldest != 0 {
			return oldest
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for the first ring buffer entry to land")
		}
		time.Sleep(time.Millisecond)
	}
}

// waitForRingBufferNewestAtLeast polls hub's ring buffer until its newest
// entry's seq is >= target, or fails the test after a timeout. See
// waitForFirstRingBufferEntry on why this can't be a fixed sleep.
func waitForRingBufferNewestAtLeast(t *testing.T, hub *ws.Hub, target uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if newest := hub.ReplayBuffer().NewestSeq(); newest >= target {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for hub ring buffer newest seq to reach >= %d (currently %d)",
				target, hub.ReplayBuffer().NewestSeq())
		}
		time.Sleep(time.Millisecond)
	}
}

// TestRunStartEventPersistence_DisabledMode_StaleLastSeqForcesFullResync pins
// OC-0210: with event_persistence.enabled=false ("ring-buffer-only
// behaviour", config.go's EventPersistenceConfig.Enabled doc), every boot's
// h.seq previously started at 0 with an empty ring buffer, with nothing to
// distinguish this boot's own watermarks from a PRIOR boot's. A reconnecting
// client carrying a last_seq from a prior process's epoch was checked only
// against whatever the new epoch's ring buffer happened to hold; if the new
// epoch's traffic (e.g. other clients reconnecting first) had pushed seq past
// that stale value, EventsSinceFiltered reported it as an ordinary in-window
// replay instead of refusing it, silently handing back a different epoch's
// events as if they were a contiguous resume.
//
// This simulates exactly the repro: hub "A" (a prior boot) runs with
// persistence disabled and a client observes 40 broadcasts go by (its
// last_seq is whatever the 40th one's seq turns out to be — captured
// dynamically here rather than hardcoded, since the fix changes what that
// number actually is). Hub A is then stopped (restart) and a fresh hub "B" is
// booted with the same disabled config; other clients' traffic pushes hub B's
// own (unrelated) epoch's seq past that same watermark, then the client
// reconnects against hub B with its old last_seq — a watermark that has never
// existed in hub B's epoch. That resume must be forced onto the full-ready
// path; before the fix it silently resolves via the ordinary buffer tier
// instead.
func TestRunStartEventPersistence_DisabledMode_StaleLastSeqForcesFullResync(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer database.Close() //nolint:errcheck
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := &config.Config{EventPersistence: config.EventPersistenceConfig{Enabled: false}}

	userID, err := database.CreateUser(ctx, "oc-0210-user", "hash", 1)
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

	// --- Prior boot: hub A runs with persistence disabled. A client's
	// last_seq ends up as whatever the 40th broadcast's real seq turns out to
	// be — captured dynamically so this test holds regardless of what value
	// scheme is in effect (raw 1..N pre-fix, or a seeded floor post-fix). ---
	hubOld, hubErr := ws.NewHub(ws.HubOptions{DB: database, Limiter: limiter})
	if hubErr != nil {
		t.Fatalf("ws.NewHub: %v", hubErr)
	}
	go hubOld.Run()
	if persister, prunerDone := startEventPersister(ctx, log, cfg, hubOld, database); persister != nil || prunerDone != nil {
		t.Fatalf("startEventPersister with Enabled=false: want (nil, nil), got (%v, %v)", persister, prunerDone)
	}
	for range 40 {
		hubOld.BroadcastToAll([]byte(`{"type":"broadcast"}`))
	}
	oldFirstSeq := waitForFirstRingBufferEntry(t, hubOld)
	staleLastSeq := oldFirstSeq + 39 // the 40th broadcast's seq: what a real client's lastSeq tracker would hold
	waitForRingBufferNewestAtLeast(t, hubOld, staleLastSeq)
	hubOld.Stop()

	// --- Restart: hub B is a brand-new process-equivalent hub, same disabled
	// config, same (in-memory but never touched by persistence) database. ---
	hubNew, hubErr := ws.NewHub(ws.HubOptions{DB: database, Limiter: limiter})
	if hubErr != nil {
		t.Fatalf("ws.NewHub: %v", hubErr)
	}
	go hubNew.Run()
	defer hubNew.Stop()
	if persister, prunerDone := startEventPersister(ctx, log, cfg, hubNew, database); persister != nil || prunerDone != nil {
		t.Fatalf("startEventPersister with Enabled=false: want (nil, nil), got (%v, %v)", persister, prunerDone)
	}

	// Other clients reconnect first and push hub B's own new epoch forward by
	// 60 broadcasts — enough to overtake staleLastSeq pre-fix (repro's 1..60
	// window covering 40) and trivially so post-fix (the seeded floor alone
	// already exceeds it).
	for range 60 {
		hubNew.BroadcastToAll([]byte(`{"type":"broadcast"}`))
	}
	newFirstSeq := waitForFirstRingBufferEntry(t, hubNew)
	newTargetSeq := newFirstSeq + 59
	waitForRingBufferNewestAtLeast(t, hubNew, newTargetSeq)
	if newTargetSeq <= staleLastSeq {
		t.Fatalf("test setup invariant broken: hub B's epoch (reached %d) never overtook the stale watermark (%d)", newTargetSeq, staleLastSeq)
	}

	handler := ws.ServeWS(hubNew, database, []string{"*"}, 0)
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

	// staleLastSeq is a watermark from hub A's epoch. It sits inside hub B's
	// own live ring window, but nothing about it describes hub B's history —
	// it must not be served by ordinary replay.
	authMsg := map[string]any{
		"type": "auth",
		"payload": map[string]any{
			"token":    token,
			"last_seq": staleLastSeq,
		},
	}
	raw, _ := json.Marshal(authMsg)
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	if _, _, err := conn.Read(dialCtx); err != nil {
		t.Fatalf("read handshake response: %v", err)
	}

	bufTier, dbTier, fullTier := hubNew.ReconnectTierStats()
	if fullTier != 1 {
		t.Fatalf("reconnect tiers (buffer=%d db=%d full=%d): want full=1 — a last_seq from a prior epoch must never be served by ring-buffer replay in ring-buffer-only mode, since the server has no way to tell it apart from an in-epoch watermark",
			bufTier, dbTier, fullTier)
	}
}
