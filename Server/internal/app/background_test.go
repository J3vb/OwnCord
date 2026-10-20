package app

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"go.uber.org/goleak"
)

// runUntilHealthy boots a for real, waits for /health, and returns a cancel
// that ends Run plus the channel Run's result arrives on.
func runUntilHealthy(t *testing.T, a *App, port int) (cancel func(), runErr <-chan error) {
	t.Helper()
	ctx, cancelCtx := context.WithCancel(context.Background())
	t.Cleanup(cancelCtx)
	errc := make(chan error, 1)
	go func() { errc <- a.Run(ctx) }()
	waitForHealth(t, port, errc)
	return cancelCtx, errc
}

func awaitRun(t *testing.T, runErr <-chan error) {
	t.Helper()
	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run() = %v, want nil (clean drain)", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}
}

// The background-jobs step sits where the design puts it in the reverse walk:
// after the router has stopped taking requests, before the mention worker,
// the hub and the database (ARCH-034).
func TestClose_BackgroundJobsBeforeDatabase(t *testing.T) {
	port := freePort(t)
	a := bootTestApp(t, fmt.Sprint(port), "")
	var order []string
	a.onCloseStep = func(stage string) { order = append(order, stage) }

	cancel, runErr := runUntilHealthy(t, a, port)
	cancel()
	awaitRun(t, runErr)

	idx := func(stage string) int {
		i := slices.Index(order, stage)
		if i < 0 {
			t.Fatalf("close step %q never ran; order = %v", stage, order)
		}
		return i
	}
	chain := []string{"http", "hub-notice", "maintenance", "audit-writer", "event-persistence",
		"router", "background-jobs", "mention-worker", "hub", "conn-writes", "database"}
	for i := 1; i < len(chain); i++ {
		if idx(chain[i-1]) >= idx(chain[i]) {
			t.Errorf("close step %q did not run before %q; order = %v", chain[i-1], chain[i], order)
		}
	}
}

// With event persistence off nothing cancels bgCtx before the background-context
// step, which runs after the database step. The maintenance stop must cancel
// its own tick, or the tick would still be using the database at that point.
func TestClose_MaintenanceTickCancelledBeforeDatabase_PersistenceOff(t *testing.T) {
	var stepCancelled, stepStarted atomic.Bool
	stepDone := make(chan struct{})
	m := &maintenance{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	m.stepsOverride = []maintenanceStep{
		{job: "Account erasure", failLog: "erasure jobs still pending", run: func(ctx context.Context) error {
			stepStarted.Store(true)
			<-ctx.Done()
			stepCancelled.Store(true)
			close(stepDone)
			return ctx.Err()
		}},
		{job: "Storage recount", failLog: "storage recount failed", run: func(context.Context) error { return nil }},
		{job: "Push subscriptions", failLog: "push subscription sweep failed", run: func(context.Context) error { return nil }},
	}

	a := newTestApp()
	bgCtx, bgCancel := context.WithCancel(context.Background())
	a.bgCtx, a.bgCancel = bgCtx, bgCancel
	a.onClose("background-context", func(context.Context) error { bgCancel(); return nil })
	var sawCancelled, sawBgCancelled bool
	a.onClose("database", func(context.Context) error {
		sawCancelled = stepCancelled.Load()
		sawBgCancelled = bgCtx.Err() != nil
		return nil
	})
	stop := runMaintenanceLoop(bgCtx, a.log, m)
	a.onClose("maintenance", func(context.Context) error { stop(); return nil })

	deadline := time.Now().Add(5 * time.Second)
	for !stepStarted.Load() {
		if time.Now().After(deadline) {
			t.Fatal("the blocking maintenance step never started")
		}
		time.Sleep(time.Millisecond)
	}

	begin := time.Now()
	if err := a.Close(context.Background()); err != nil {
		t.Fatalf("Close() = %v", err)
	}
	if !sawCancelled {
		t.Error("the maintenance tick was still running, uncancelled, when the database step ran")
	}
	if sawBgCancelled {
		t.Error("bgCtx was already cancelled at the database step: the test no longer models persistence off")
	}
	if elapsed := time.Since(begin); elapsed >= 4*time.Second {
		t.Errorf("Close took %v: the stop waited out its join instead of cancelling the tick", elapsed)
	}
	<-stepDone
}

// A push still in flight when Close runs is cancelled by the background-jobs
// step and joined: Run returns cleanly and leaves no goroutine behind.
func TestRun_NoLeakAfterCloseWithPushInFlight(t *testing.T) {
	leakOpt := goleak.IgnoreCurrent()
	port := freePort(t)
	a := bootTestApp(t, fmt.Sprint(port), "")
	a.cfg.Push.Enabled, a.cfg.Push.DispatchEnabled = true, true

	cancel, runErr := runUntilHealthy(t, a, port)

	notifier := &inFlightNotifier{started: make(chan struct{}), ended: make(chan error, 1)}
	msgs := a.runtime.Services.Messages
	msgs.SetPushNotifier(notifier)
	ctx := context.Background()
	uid, err := a.database.CreateUser(ctx, "pusher", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	channelID, err := a.database.CreateChannel(ctx, "push-room", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if _, err := msgs.SendMessage(ctx, service.SendMessageParams{
		ChannelID: channelID, UserID: uid, Username: "pusher", RoleName: "member", Content: "hello",
	}); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	select {
	case <-notifier.started:
	case <-time.After(10 * time.Second):
		t.Fatal("the push never started")
	}

	cancel()
	awaitRun(t, runErr)

	select {
	case err := <-notifier.ended:
		if err == nil {
			t.Error("Notify's ctx was not cancelled by the shutdown")
		}
	default:
		t.Error("Run returned while the push was still in flight: it was not joined")
	}
	assertReleased(t, a, port, leakOpt)
}

type inFlightNotifier struct {
	started chan struct{}
	ended   chan error
}

func (n *inFlightNotifier) Notify(ctx context.Context, _, _ int64, _ []int64) {
	close(n.started)
	<-ctx.Done()
	n.ended <- ctx.Err()
}

// Once the loop's context is cancelled, tick stops walking its steps: a later
// step (Storage reconciliation lists the whole upload store) must not start,
// and none is recorded as a failure.
func TestMaintenanceTick_StopsWalkingOnceCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var laterRan atomic.Bool
	m := &maintenance{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	m.stepsOverride = []maintenanceStep{
		{job: "first", failLog: "first failed", run: func(context.Context) error {
			cancel() // the shutdown arrives mid-tick
			return nil
		}},
		{job: "later", failLog: "later failed", run: func(context.Context) error {
			laterRan.Store(true)
			return nil
		}},
	}
	if failed := m.tick(ctx); failed {
		t.Error("tick reported a failure for a step skipped by cancellation")
	}
	if laterRan.Load() {
		t.Error("a step ran after the loop context was cancelled")
	}
}

// A token touch and an expired-session discard queued just before Close are
// on disk once Run returns: the conn-writes final flush runs before the
// database closes.
func TestRun_QueuedTouchAndDiscardAreFlushedAtClose(t *testing.T) {
	port := freePort(t)
	a := bootTestApp(t, fmt.Sprint(port), "")
	cancel, runErr := runUntilHealthy(t, a, port)

	ctx := context.Background()
	uid, err := a.database.CreateUser(ctx, "flusher", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	apiHash := "api-token-hash-flush"
	if _, err := a.database.CreateAPIToken(ctx, uid, apiHash, "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}
	sessHash := "expired-session-hash-flush"
	past := time.Now().Add(-time.Hour).UTC().Format("2006-01-02 15:04:05")
	if _, err := a.database.ExecContext(ctx,
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)`,
		uid, sessHash, "test", "127.0.0.1", past); err != nil {
		t.Fatalf("insert expired session: %v", err)
	}

	sessions := a.runtime.Services.Sessions
	if err := sessions.TouchAPIToken(ctx, apiHash); err != nil {
		t.Fatalf("TouchAPIToken: %v", err)
	}
	if err := sessions.DiscardSession(ctx, sessHash); err != nil {
		t.Fatalf("DiscardSession: %v", err)
	}

	cancel()
	awaitRun(t, runErr)

	reopened, err := db.Open(a.cfg.Database.Path)
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	defer func() { _ = reopened.Close() }()
	var lastUsed sql.NullString
	if err := reopened.QueryRowContext(ctx, `SELECT last_used_at FROM api_tokens WHERE token_hash = ?`, apiHash).Scan(&lastUsed); err != nil {
		t.Fatalf("read last_used_at: %v", err)
	}
	if !lastUsed.Valid {
		t.Error("the queued API-token touch was lost at shutdown: last_used_at is NULL")
	}
	var rows int
	if err := reopened.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions WHERE token = ?`, sessHash).Scan(&rows); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if rows != 0 {
		t.Errorf("the queued expired-session discard was lost at shutdown: %d row(s) remain", rows)
	}
}

// The shutdown signal closes before the first close step, so the update
// countdown stops while the HTTP drain and the hub-notice wait are still
// ahead of it; the background group is not stopped that early. The runtime
// handed to the router carries both.
func TestClose_ShutdownSignalClosesBeforeHTTPStep(t *testing.T) {
	port := freePort(t)
	a := bootTestApp(t, fmt.Sprint(port), "")
	var atHTTP, atBackground, runtimeShutdown, appShutdown any
	closed := func(ch <-chan struct{}) bool {
		select {
		case <-ch:
			return true
		default:
			return false
		}
	}
	a.onCloseStep = func(stage string) {
		if stage == "http" {
			atHTTP = closed(a.runtime.Shutdown)
			atBackground = closed(a.background.Draining())
		}
	}
	cancel, runErr := runUntilHealthy(t, a, port)
	if closed(a.runtime.Shutdown) {
		t.Fatal("shutdown signal closed while the server was running")
	}
	runtimeShutdown, appShutdown = a.runtime.Shutdown, (<-chan struct{})(a.shutdown)
	cancel()
	awaitRun(t, runErr)

	if atHTTP != true {
		t.Error("the shutdown signal was not closed when the http close step began")
	}
	if atBackground != false {
		t.Error("the background group was already draining at the http step; it must stay open for handlers still running")
	}
	if runtimeShutdown != appShutdown || a.runtime.Background != a.background {
		t.Error("api.Runtime does not carry the app's shutdown signal and background group")
	}
}
