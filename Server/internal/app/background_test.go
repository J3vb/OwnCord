package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync/atomic"
	"testing"
	"time"

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
