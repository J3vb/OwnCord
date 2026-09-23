package service

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

var errRetentionStore = errors.New("retention store unavailable")

// faultRetentionStore fails the named store calls and passes the rest to the
// real database, so each service error path is reached from a live policy.
type faultRetentionStore struct {
	RetentionStore
	fail map[string]bool
}

func (f *faultRetentionStore) RetentionPolicySnapshot(ctx context.Context) (*db.RetentionPolicySnapshot, error) {
	if f.fail["snapshot"] {
		return nil, errRetentionStore
	}
	return f.RetentionStore.RetentionPolicySnapshot(ctx)
}

func (f *faultRetentionStore) PreviewRetentionChange(ctx context.Context, c db.RetentionChange, revision string, observed time.Time) (*db.RetentionChangeEffect, error) {
	if f.fail["preview"] {
		return nil, errRetentionStore
	}
	return f.RetentionStore.PreviewRetentionChange(ctx, c, revision, observed)
}

func (f *faultRetentionStore) ApplyRetentionChange(ctx context.Context, actorID int64, c db.RetentionChange, revision string) (string, error) {
	if f.fail["apply"] {
		return "", errRetentionStore
	}
	return f.RetentionStore.ApplyRetentionChange(ctx, actorID, c, revision)
}

func (f *faultRetentionStore) GetChannelRetention(ctx context.Context, channelID int64) (*db.ChannelRetention, error) {
	if f.fail["get-channel"] {
		return nil, errRetentionStore
	}
	return f.RetentionStore.GetChannelRetention(ctx, channelID)
}

func (f *faultRetentionStore) SetChannelRetention(ctx context.Context, channelID int64, days int, actorID int64) error {
	if f.fail["set-channel"] {
		return errRetentionStore
	}
	return f.RetentionStore.SetChannelRetention(ctx, channelID, days, actorID)
}

func (f *faultRetentionStore) DeleteChannelRetention(ctx context.Context, channelID int64) (bool, error) {
	if f.fail["delete-channel"] {
		return false, errRetentionStore
	}
	return f.RetentionStore.DeleteChannelRetention(ctx, channelID)
}

func (f *faultRetentionStore) RetentionWindows(ctx context.Context) ([]db.RetentionWindow, error) {
	if f.fail["windows"] {
		return nil, errRetentionStore
	}
	return f.RetentionStore.RetentionWindows(ctx)
}

func (f *faultRetentionStore) ListUnfinishedRetentionRuns(ctx context.Context) ([]db.RetentionRun, error) {
	if f.fail["runs"] {
		return nil, errRetentionStore
	}
	return f.RetentionStore.ListUnfinishedRetentionRuns(ctx)
}

type retentionFixture struct {
	database *db.DB
	store    *faultRetentionStore
	svc      *RetentionService
	owner    int64
	channel  int64
}

func newRetentionFixture(t *testing.T) *retentionFixture {
	t.Helper()
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	owner, _ := database.CreateUser(ctx, "fault-owner", "hash", 1)
	channel, _ := seedRetentionChannel(t, database, "fault-chan", owner, dir, 1)
	if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "30"}); err != nil {
		t.Fatal(err)
	}
	if err := database.SetChannelRetention(ctx, channel, 7, owner); err != nil {
		t.Fatal(err)
	}
	store := &faultRetentionStore{RetentionStore: database, fail: map[string]bool{}}
	svc := NewRetentionService(store)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(newTestMarkers(t))
	svc.SetClock(func() time.Time { return retentionNow })
	return &retentionFixture{database: database, store: store, svc: svc, owner: owner, channel: channel}
}

func TestRetentionReadPaths(t *testing.T) {
	ctx := context.Background()
	f := newRetentionFixture(t)
	days, err := f.svc.ServerDays(ctx)
	if err != nil || days != 30 {
		t.Fatalf("ServerDays = %d, %v; want 30", days, err)
	}
	p, err := f.svc.ChannelPolicy(ctx, f.channel)
	if err != nil || p == nil || p.Days != 7 || p.UpdatedBy != f.owner {
		t.Fatalf("ChannelPolicy = %+v, %v; want the 7-day override by the owner", p, err)
	}
}

func TestRetentionStoreFailuresAreInternal(t *testing.T) {
	ctx := context.Background()
	days := 14
	for _, tc := range []struct {
		fail string
		call func(f *retentionFixture) error
	}{
		{"snapshot", func(f *retentionFixture) error { _, err := f.svc.Policy(ctx); return err }},
		{"get-channel", func(f *retentionFixture) error { _, err := f.svc.ChannelPolicy(ctx, f.channel); return err }},
		{"get-channel", func(f *retentionFixture) error {
			_, err := f.svc.SetChannelPolicy(ctx, f.owner, f.channel, 14)
			return err
		}},
		{"set-channel", func(f *retentionFixture) error {
			_, err := f.svc.SetChannelPolicy(ctx, f.owner, f.channel, 14)
			return err
		}},
		{"get-channel", func(f *retentionFixture) error { return f.svc.ClearChannelPolicy(ctx, f.owner, f.channel) }},
		{"delete-channel", func(f *retentionFixture) error { return f.svc.ClearChannelPolicy(ctx, f.owner, f.channel) }},
		{"preview", func(f *retentionFixture) error {
			p, err := f.svc.Policy(ctx)
			if err != nil {
				return err
			}
			_, err = f.svc.PreviewChange(ctx, f.owner, RetentionChange{Scope: "server", Days: &days}, p.Revision)
			return err
		}},
		{"apply", func(f *retentionFixture) error {
			change := RetentionChange{Scope: "server", Days: &days}
			preview := previewChange(t, f.svc, f.owner, change)
			return f.svc.ApplyChange(ctx, f.owner, change, preview.Token)
		}},
	} {
		t.Run(tc.fail, func(t *testing.T) {
			f := newRetentionFixture(t)
			f.store.fail[tc.fail] = true
			if err := tc.call(f); !errors.Is(err, ErrInternal) || !errors.Is(err, errRetentionStore) {
				t.Fatalf("err = %v; want ErrInternal wrapping the store error", err)
			}
		})
	}
}

// A run journal that cannot be read must not stop the sweep: the tick logs it
// and still sweeps the live windows.
func TestRetentionTickSweepsWhenRunJournalFails(t *testing.T) {
	ctx := context.Background()
	f := newRetentionFixture(t)
	f.store.fail["runs"] = true
	rep, err := f.svc.Tick(ctx)
	if err != nil || rep.Messages != 1 {
		t.Fatalf("Tick = %+v, %v; want the one expired message swept", rep, err)
	}
}

func TestRetentionTickReportsWindowFailure(t *testing.T) {
	f := newRetentionFixture(t)
	f.store.fail["windows"] = true
	if rep, err := f.svc.Tick(context.Background()); !errors.Is(err, errRetentionStore) || rep.Messages != 0 {
		t.Fatalf("Tick = %+v, %v; want the store error and nothing swept", rep, err)
	}
}

func TestRetentionChangeErrorMapping(t *testing.T) {
	for _, tc := range []struct {
		store error
		want  error
	}{
		{db.ErrConflict, ErrConflict},
		{db.ErrNotFound, ErrNotFound},
		{db.ErrRetentionProtectedChannel, ErrBadRequest},
		{errRetentionStore, ErrInternal},
	} {
		if err := retentionChangeError(tc.store); !errors.Is(err, tc.want) {
			t.Errorf("retentionChangeError(%v) = %v; want %v", tc.store, err, tc.want)
		}
	}
}

func TestRetentionApplyRejectsMalformedTokens(t *testing.T) {
	ctx := context.Background()
	f := newRetentionFixture(t)
	days := 14
	change := RetentionChange{Scope: "server", Days: &days}
	notJSON := []byte("not a claim")
	for name, token := range map[string]string{
		"oversized":      strings.Repeat("a", 4097),
		"signed garbage": base64.RawURLEncoding.EncodeToString(notJSON) + "." + f.svc.signRetentionPreview(notJSON),
	} {
		if err := f.svc.ApplyChange(ctx, f.owner, change, token); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s token: err = %v; want ErrBadRequest", name, err)
		}
	}
	if got, _ := f.svc.ServerDays(ctx); got != 30 {
		t.Fatalf("server window = %d after rejected applies; want 30 unchanged", got)
	}
}
