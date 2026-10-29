package service

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/permissions"
	"go.uber.org/goleak"
)

func newExpiryChannels(t *testing.T) (*ChannelService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	return NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database))), database
}

func storedExpiry(t *testing.T, database *db.DB, id int64) (text, expiresAt string) {
	t.Helper()
	u, err := database.GetUserByID(context.Background(), id)
	if err != nil || u == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.CustomStatus != nil {
		text = *u.CustomStatus
	}
	if u.CustomStatusExpiresAt != nil {
		expiresAt = *u.CustomStatusExpiresAt
	}
	return text, expiresAt
}

func TestHandlePresenceUpdate_StoresExpiry(t *testing.T) {
	svc, database := newExpiryChannels(t)
	fixed := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fixed }
	woke := 0
	svc.SetExpiryWake(func() { woke++ })
	text := "in a meeting"

	res, err := svc.HandlePresenceUpdate(context.Background(), 1, db.StatusDND, &text, new(int64(3600)), nil)
	if err != nil {
		t.Fatalf("HandlePresenceUpdate: %v", err)
	}
	const want = "2026-10-15T13:00:00Z"
	if res.CustomStatus == nil || *res.CustomStatus != text || res.ExpiresAt != want {
		t.Fatalf("result = %v / %q, want %q / %q", res.CustomStatus, res.ExpiresAt, text, want)
	}
	if got, exp := storedExpiry(t, database, 1); got != text || exp != want {
		t.Fatalf("stored = %q / %q, want %q / %q", got, exp, text, want)
	}
	if woke != 1 {
		t.Fatalf("expirer woken %d times, want 1", woke)
	}
}

func TestHandlePresenceUpdate_NewTextWithoutExpiryClearsOld(t *testing.T) {
	svc, database := newExpiryChannels(t)
	ctx := context.Background()
	first, second := "lunch", "back"
	if _, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, &first, new(int64(600)), nil); err != nil {
		t.Fatal(err)
	}
	res, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, &second, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.ExpiresAt != "" {
		t.Fatalf("ExpiresAt = %q, want none", res.ExpiresAt)
	}
	if got, exp := storedExpiry(t, database, 1); got != second || exp != "" {
		t.Fatalf("stored = %q / %q, want %q with no expiry", got, exp, second)
	}
	// An empty line clears both.
	if _, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, &first, new(int64(600)), nil); err != nil {
		t.Fatal(err)
	}
	empty := ""
	if _, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, &empty, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got, exp := storedExpiry(t, database, 1); got != "" || exp != "" {
		t.Fatalf("stored = %q / %q after clearing, want both empty", got, exp)
	}
}

func TestHandlePresenceUpdate_BareFlipKeepsExpiry(t *testing.T) {
	svc, database := newExpiryChannels(t)
	ctx := context.Background()
	text := "heads down"
	first, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, &text, new(int64(3600)), nil)
	if err != nil {
		t.Fatal(err)
	}
	flip, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusIdle, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if flip.CustomStatus == nil || *flip.CustomStatus != text || flip.ExpiresAt != first.ExpiresAt {
		t.Fatalf("bare flip = %v / %q, want the stored %q / %q", flip.CustomStatus, flip.ExpiresAt, text, first.ExpiresAt)
	}
	if got, exp := storedExpiry(t, database, 1); got != text || exp != first.ExpiresAt {
		t.Fatalf("stored = %q / %q, want %q / %q", got, exp, text, first.ExpiresAt)
	}
}

func TestHandlePresenceUpdate_RejectsBadExpiry(t *testing.T) {
	svc, _ := newExpiryChannels(t)
	ctx := context.Background()
	text, empty := "x", ""
	cases := []struct {
		name string
		text *string
		in   int64
	}{
		{"too short", &text, 59},
		{"too long", &text, 604801},
		{"no custom status", nil, 600},
		{"empty custom status", &empty, 600},
	}
	for _, tc := range cases {
		if _, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, tc.text, new(tc.in), nil); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", tc.name, err)
		}
	}
	for _, ok := range []int64{60, 604800} {
		if _, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, &text, new(ok), nil); err != nil {
			t.Errorf("expires_in %d: %v", ok, err)
		}
	}
}

func TestLogout_ClearsExpiry(t *testing.T) {
	svc, database := newExpiryChannels(t)
	ctx := context.Background()
	text := "away"
	if _, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, &text, new(int64(600)), nil); err != nil {
		t.Fatal(err)
	}
	user, err := database.GetUserByID(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	if err := a.Logout(ctx, Principal{User: user, Session: &db.Session{UserID: 1, TokenHash: "tok"}}); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if got, exp := storedExpiry(t, database, 1); got != "" || exp != "" {
		t.Fatalf("after logout stored = %q / %q, want both cleared", got, exp)
	}
}

// recordingNotifier collects CustomStatusExpired calls.
type recordingNotifier struct {
	mu    sync.Mutex
	calls []db.ExpiredCustomStatus
	ch    chan struct{}
}

func newRecordingNotifier() *recordingNotifier {
	return &recordingNotifier{ch: make(chan struct{}, 16)}
}

func (n *recordingNotifier) CustomStatusExpired(userID int64, expiresAt string) {
	n.mu.Lock()
	n.calls = append(n.calls, db.ExpiredCustomStatus{UserID: userID, ExpiresAt: expiresAt})
	n.mu.Unlock()
	n.ch <- struct{}{}
}

func (n *recordingNotifier) snapshot() []db.ExpiredCustomStatus {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]db.ExpiredCustomStatus(nil), n.calls...)
}

func (n *recordingNotifier) wait(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case <-n.ch:
	case <-time.After(d):
		t.Fatal("CustomStatusExpired was not called in time")
	}
}

func fastExpirer(database *db.DB) *CustomStatusExpirer {
	e := NewCustomStatusExpirer(database)
	e.slack = 50 * time.Millisecond
	return e
}

func inSeconds(d time.Duration) *string {
	s := time.Now().UTC().Add(d).Format(dbtime.ISOLayout)
	return &s
}

func TestCustomStatusExpirer_ClearsAtDeadline(t *testing.T) {
	_, database := newExpiryChannels(t)
	ctx, cancel := context.WithCancel(context.Background())
	text := "short"
	if err := database.UpdateUserPresence(ctx, 1, db.StatusOnline, &text, inSeconds(time.Second)); err != nil {
		t.Fatal(err)
	}
	n := newRecordingNotifier()
	e := fastExpirer(database)
	e.SetNotifier(n)
	done := make(chan struct{})
	go func() { defer close(done); e.Run(ctx) }()
	defer func() { cancel(); <-done }()

	n.wait(t, 5*time.Second)
	if got, exp := storedExpiry(t, database, 1); got != "" || exp != "" {
		t.Fatalf("stored = %q / %q after the deadline, want cleared", got, exp)
	}
	if calls := n.snapshot(); len(calls) != 1 || calls[0].UserID != 1 {
		t.Fatalf("notifier calls = %+v, want one for user 1", calls)
	}
}

func TestCustomStatusExpirer_WakesOnEarlierSet(t *testing.T) {
	svc, database := newExpiryChannels(t)
	seedUser(t, database, &db.User{ID: 2, Username: "bob", PasswordHash: "h"})
	ctx, cancel := context.WithCancel(context.Background())
	e := fastExpirer(database)
	svc.SetExpiryWake(e.Wake)
	n := newRecordingNotifier()
	e.SetNotifier(n)
	done := make(chan struct{})
	go func() { defer close(done); e.Run(ctx) }()
	defer func() { cancel(); <-done }()

	// The loop is asleep on a far deadline; a nearer one set afterwards must
	// wake it rather than wait the old sleep out.
	far := "far"
	if err := database.UpdateUserPresence(ctx, 2, db.StatusOnline, &far, inSeconds(time.Hour)); err != nil {
		t.Fatal(err)
	}
	e.Wake()
	time.Sleep(100 * time.Millisecond)
	text := "soon"
	// Service validation enforces 60 s at the minimum, so write the near
	// deadline directly and wake through the same hook the service uses.
	if err := database.UpdateUserPresence(ctx, 1, db.StatusOnline, &text, inSeconds(time.Second)); err != nil {
		t.Fatal(err)
	}
	svc.wakeExpiry()

	n.wait(t, 5*time.Second)
	if calls := n.snapshot(); len(calls) != 1 || calls[0].UserID != 1 {
		t.Fatalf("notifier calls = %+v, want only user 1", calls)
	}
	if got, _ := storedExpiry(t, database, 2); got != "far" {
		t.Fatalf("the far status was cleared: %q", got)
	}
}

func TestCustomStatusExpirer_BootSweepClearsOfflineExpiry(t *testing.T) {
	_, database := newExpiryChannels(t)
	ctx := context.Background()
	text := "left a while ago"
	past := time.Now().UTC().Add(-time.Hour).Format(dbtime.ISOLayout)
	if err := database.UpdateUserPresence(ctx, 1, db.StatusOffline, &text, &past); err != nil {
		t.Fatal(err)
	}
	n := newRecordingNotifier()
	e := NewCustomStatusExpirer(database)
	e.SetNotifier(n)
	if err := e.Sweep(ctx); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if got, exp := storedExpiry(t, database, 1); got != "" || exp != "" {
		t.Fatalf("stored = %q / %q after the boot sweep, want cleared", got, exp)
	}
	if calls := n.snapshot(); len(calls) != 1 || calls[0].ExpiresAt != past {
		t.Fatalf("notifier calls = %+v, want one carrying %q", calls, past)
	}
}

func TestCustomStatusExpirer_ExitsOnCtxDone(t *testing.T) {
	_, database := newExpiryChannels(t)
	defer goleak.VerifyNone(t, goleak.IgnoreCurrent())
	ctx, cancel := context.WithCancel(context.Background())
	e := NewCustomStatusExpirer(database)
	done := make(chan struct{})
	go func() { defer close(done); e.Run(ctx) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after ctx was cancelled")
	}
}

// failingExpiryStore fails every read, to prove the loop survives and still
// exits on ctx.Done().
type failingExpiryStore struct{ reads chan struct{} }

func (f failingExpiryStore) NextCustomStatusExpiry(context.Context) (string, bool, error) {
	select {
	case f.reads <- struct{}{}:
	default:
	}
	return "", false, errors.New("injected read failure")
}

func (failingExpiryStore) ListExpiredCustomStatuses(context.Context, string, int) ([]db.ExpiredCustomStatus, error) {
	return nil, errors.New("unused")
}

func (failingExpiryStore) ClearCustomStatusIfExpiry(context.Context, int64, string) (bool, error) {
	return false, errors.New("unused")
}

func TestCustomStatusExpirer_ReadErrorRetriesAndStillExits(t *testing.T) {
	st := failingExpiryStore{reads: make(chan struct{}, 8)}
	e := NewCustomStatusExpirer(st)
	e.retryAfter = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); e.Run(ctx) }()
	for range 2 {
		select {
		case <-st.reads:
		case <-time.After(5 * time.Second):
			t.Fatal("the expirer did not retry after a read error")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after ctx was cancelled")
	}
}
