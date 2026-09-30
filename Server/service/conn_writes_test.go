package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// connWriteSpy counts the writer statements ConnWrites issues, so a test can
// tell one batched statement from one statement per socket (P5-S07).
type connWriteSpy struct {
	Store
	touchCalls  int
	touched     []string
	stampCalls  int
	failStamps  bool
	failTouches bool
}

func (s *connWriteSpy) TouchSessions(ctx context.Context, tokenHashes []string) error {
	s.touchCalls++
	if s.failTouches {
		return errors.New("injected TouchSessions failure")
	}
	s.touched = append(s.touched, tokenHashes...)
	return s.Store.TouchSessions(ctx, tokenHashes)
}

func (s *connWriteSpy) StampConnections(ctx context.Context, connected, disconnected []int64) error {
	s.stampCalls++
	if s.failStamps {
		return errors.New("injected StampConnections failure")
	}
	return s.Store.StampConnections(ctx, connected, disconnected)
}

func newBatchedServices(t *testing.T) (*db.DB, *connWriteSpy, *ConnWrites, *SessionService, *UserService) {
	t.Helper()
	database := newTestDB(t)
	spy := &connWriteSpy{Store: database}
	w := NewConnWrites(spy)
	sessions := NewSessionService(spy)
	sessions.SetConnWrites(w)
	users := NewUserService(spy)
	users.SetConnWrites(w)
	return database, spy, w, sessions, users
}

// 1,000 sockets pinging inside one flush window cost the writer one
// statement, not 1,000: the touch is recorded in memory and flushed as a
// batch (P5-S07, B6).
func TestConnWrites_ThousandTouchesAreOneWriterStatement(t *testing.T) {
	_, spy, w, sessions, _ := newBatchedServices(t)
	ctx := context.Background()

	for i := range 1000 {
		if err := sessions.TouchSession(ctx, fmt.Sprintf("token-%d", i)); err != nil {
			t.Fatalf("TouchSession: %v", err)
		}
	}
	if spy.touchCalls != 0 {
		t.Fatalf("touches wrote %d statements before the flush, want 0", spy.touchCalls)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if spy.touchCalls != 1 || len(spy.touched) != 1000 {
		t.Fatalf("flush = %d statements over %d sessions, want 1 over 1000", spy.touchCalls, len(spy.touched))
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("second Flush: %v", err)
	}
	if spy.touchCalls != 1 {
		t.Fatalf("an empty flush wrote a statement (%d total), want none", spy.touchCalls)
	}
}

// After a flush the session's last_used is within the flush window of the
// last ping, and its expiry has slid (DP-05's sliding expiry, lagging by at
// most one window).
func TestConnWrites_FlushedTouchSlidesTheSession(t *testing.T) {
	database, _, w, sessions, _ := newBatchedServices(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 1, Username: "pinger"})
	if _, err := database.CreateSession(ctx, 1, "tok", "dev", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`UPDATE sessions SET last_used = datetime('now', '-2 days'), expires_at = ? WHERE token = 'tok'`,
		time.Now().UTC().Add(24*time.Hour).Format("2006-01-02T15:04:05Z")); err != nil {
		t.Fatalf("backdate: %v", err)
	}

	lastPing := time.Now()
	if err := sessions.TouchSession(ctx, "tok"); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	var lastUsed, expiresAt string
	if err := database.QueryRowContext(ctx,
		`SELECT last_used, expires_at FROM sessions WHERE token = 'tok'`).Scan(&lastUsed, &expiresAt); err != nil {
		t.Fatalf("read session: %v", err)
	}
	used, err := time.Parse("2006-01-02 15:04:05", lastUsed)
	if err != nil {
		t.Fatalf("parse last_used %q: %v", lastUsed, err)
	}
	if d := used.Sub(lastPing.UTC()); d < -2*time.Second || d > TouchFlushInterval {
		t.Fatalf("last_used = %v, want within %v of the last ping %v", used, TouchFlushInterval, lastPing.UTC())
	}
	exp, err := time.Parse("2006-01-02T15:04:05Z", expiresAt)
	if err != nil {
		t.Fatalf("parse expires_at %q: %v", expiresAt, err)
	}
	if d := time.Until(exp) - 30*24*time.Hour; d < -time.Minute || d > time.Minute {
		t.Fatalf("expires_at = %v, want about now + 30 days", exp)
	}
}

// The latest stamp per user wins inside a window, and each flush is one
// writer call however many users it covers.
func TestConnWrites_StampsCoalescePerUser(t *testing.T) {
	database, spy, w, _, users := newBatchedServices(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 1, Username: "flapper", Status: db.StatusOffline})
	seedUser(t, database, &db.User{ID: 2, Username: "leaver", Status: db.StatusOnline})
	seedUser(t, database, &db.User{ID: 3, Username: "chooser", Status: db.StatusDND})

	// 1 connects, drops and comes back; 2 connects then leaves; 3 comes back
	// with a saved choice.
	if got, err := users.StampConnect(ctx, 1, db.StatusOffline); err != nil || got != db.StatusOnline {
		t.Fatalf("StampConnect(1) = %q, %v; want online, nil", got, err)
	}
	_ = users.StampDisconnect(ctx, 1)
	_, _ = users.StampConnect(ctx, 1, db.StatusOffline)
	_, _ = users.StampConnect(ctx, 2, db.StatusOnline)
	_ = users.StampDisconnect(ctx, 2)
	if got, _ := users.StampConnect(ctx, 3, db.StatusDND); got != db.StatusDND {
		t.Fatalf("StampConnect(3) = %q, want the saved dnd", got)
	}
	if spy.stampCalls != 0 {
		t.Fatalf("stamps wrote %d statements before the flush, want 0", spy.stampCalls)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if spy.stampCalls != 1 {
		t.Fatalf("flush made %d stamp calls, want 1", spy.stampCalls)
	}
	for id, want := range map[int64]string{1: db.StatusOnline, 2: db.StatusOffline, 3: db.StatusDND} {
		u, err := database.GetUserByID(ctx, id)
		if err != nil || u == nil {
			t.Fatalf("GetUserByID(%d): %v", id, err)
		}
		if u.Status != want {
			t.Errorf("user %d status = %q, want %q", id, u.Status, want)
		}
	}
}

// A presence_update written while the user's connect stamp is still pending
// is a newer choice: the flush must not overwrite it with online.
func TestConnWrites_PendingConnectKeepsANewerChoice(t *testing.T) {
	database, _, w, _, users := newBatchedServices(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 1, Username: "quick", Status: db.StatusOffline})

	_, _ = users.StampConnect(ctx, 1, db.StatusOffline)
	if err := database.UpdateUserStatus(ctx, 1, db.StatusDND); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	u, _ := database.GetUserByID(ctx, 1)
	if u.Status != db.StatusDND {
		t.Fatalf("status = %q, want the dnd chosen after the connect", u.Status)
	}
}

// A crash loses the pending stamps. What it leaves behind is an "online" row
// for someone no longer connected, which the boot-time ResetAllUserStatuses
// corrects, while a chosen status survives.
func TestConnWrites_CrashLeftoversAreResetOnBoot(t *testing.T) {
	database, _, w, _, users := newBatchedServices(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 1, Username: "plain", Status: db.StatusOffline})
	seedUser(t, database, &db.User{ID: 2, Username: "busy", Status: db.StatusDND})

	_, _ = users.StampConnect(ctx, 1, db.StatusOffline)
	_, _ = users.StampConnect(ctx, 2, db.StatusDND)
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	// Both disconnect, then the process dies before the next flush.
	_ = users.StampDisconnect(ctx, 1)
	_ = users.StampDisconnect(ctx, 2)

	if u, _ := database.GetUserByID(ctx, 1); u.Status != db.StatusOnline {
		t.Fatalf("status before boot = %q, want the stale online the crash left", u.Status)
	}
	if err := database.ResetAllUserStatuses(ctx); err != nil {
		t.Fatalf("ResetAllUserStatuses: %v", err)
	}
	for id, want := range map[int64]string{1: db.StatusOffline, 2: db.StatusDND} {
		if u, _ := database.GetUserByID(ctx, id); u.Status != want {
			t.Errorf("user %d status after boot = %q, want %q", id, u.Status, want)
		}
	}
}

// A failed flush keeps its entries for the next one, without overwriting a
// stamp that was queued in the meantime.
func TestConnWrites_FailedFlushRetriesAndKeepsNewerStamps(t *testing.T) {
	database, spy, w, sessions, users := newBatchedServices(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 1, Username: "retry", Status: db.StatusOffline})
	seedUser(t, database, &db.User{ID: 2, Username: "newer", Status: db.StatusOffline})
	if _, err := database.CreateSession(ctx, 1, "tok", "dev", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	_, _ = users.StampConnect(ctx, 1, db.StatusOffline)
	_, _ = users.StampConnect(ctx, 2, db.StatusOffline)
	_ = sessions.TouchSession(ctx, "tok")
	spy.failStamps, spy.failTouches = true, true
	if err := w.Flush(ctx); !errors.Is(err, ErrInternal) {
		t.Fatalf("failed Flush err = %v, want ErrInternal", err)
	}
	// User 2 left while the write was failing: that stamp is newer.
	_ = users.StampDisconnect(ctx, 2)

	spy.failStamps, spy.failTouches = false, false
	spy.touched = nil
	if err := w.Flush(ctx); err != nil {
		t.Fatalf("retry Flush: %v", err)
	}
	if u, _ := database.GetUserByID(ctx, 1); u.Status != db.StatusOnline {
		t.Errorf("user 1 status = %q, want the retried online", u.Status)
	}
	if u, _ := database.GetUserByID(ctx, 2); u.Status != db.StatusOffline {
		t.Errorf("user 2 status = %q, want the newer disconnect", u.Status)
	}
	if len(spy.touched) != 1 || spy.touched[0] != "tok" {
		t.Errorf("retried touches = %v, want [tok]", spy.touched)
	}
}

// Run flushes on its own: a stamp lands within a few StampFlushInterval ticks
// without anyone calling Flush.
func TestConnWrites_RunFlushesOnTheInterval(t *testing.T) {
	database, _, w, _, users := newBatchedServices(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ticker", Status: db.StatusOffline})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); w.Run(ctx) }()
	defer func() { cancel(); <-done }()

	_, _ = users.StampConnect(ctx, 1, db.StatusOffline)
	deadline := time.Now().Add(5 * StampFlushInterval)
	for time.Now().Before(deadline) {
		if u, _ := database.GetUserByID(ctx, 1); u.Status == db.StatusOnline {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("Run did not flush a pending connect stamp")
}
