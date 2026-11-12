package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// countingRetentionStore counts the writer-side calls a tick makes.
type countingRetentionStore struct {
	RetentionStore
	sweeps, swept int
	failProbe     bool
}

func (c *countingRetentionStore) HasRetentionCandidates(ctx context.Context, channelID int64, cutoff time.Time) (bool, error) {
	if c.failProbe {
		return false, errors.New("probe down")
	}
	return c.RetentionStore.HasRetentionCandidates(ctx, channelID, cutoff)
}

func (c *countingRetentionStore) SweepRetentionJournaled(ctx context.Context, runID, channelID int64, cutoff time.Time, limit int, countChannel bool) (int64, []int64, []string, error) {
	c.sweeps++
	return c.RetentionStore.SweepRetentionJournaled(ctx, runID, channelID, cutoff, limit, countChannel)
}

func (c *countingRetentionStore) RecordRetentionSwept(ctx context.Context, channelID int64, sweep string) error {
	c.swept++
	return c.RetentionStore.RecordRetentionSwept(ctx, channelID, sweep)
}

func newCountingRetention(t *testing.T, database *db.DB, dir string) (*RetentionService, *countingRetentionStore, *db.MarkerStore) {
	t.Helper()
	store := &countingRetentionStore{RetentionStore: database}
	markers := newTestMarkers(t)
	svc := NewRetentionService(store)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	svc.SetClock(func() time.Time { return retentionNow })
	return svc, store, markers
}

// A channel with nothing older than the window costs no marker write, writer transaction or swept
// record, whether it is empty or holds only pinned old messages; a channel with old messages still
// sweeps in the same tick.
func TestRetention_TickSkipsChannelsWithNothingDue(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-idle", "hash", 1)
	idle, _ := seedRetentionChannel(t, database, "idle", uid, dir, 0)
	pinned, _ := seedRetentionChannel(t, database, "pinned-only", uid, dir, 1)
	mustDo(t, "pin", func() error {
		_, err := database.ExecContext(ctx, `UPDATE messages SET pinned = 1 WHERE channel_id = ? AND content LIKE 'old%'`, pinned)
		return err
	}())
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}))
	svc, store, markers := newCountingRetention(t, database, dir)

	rep, err := svc.Tick(ctx)
	mustDo(t, "Tick", err)
	if store.sweeps != 0 || store.swept != 0 || rep.Messages != 0 {
		t.Fatalf("idle tick: sweeps=%d swept=%d report=%+v, want none", store.sweeps, store.swept, rep)
	}
	for _, ch := range []int64{idle, pinned} {
		if id, _ := markers.MessagesSweepID(ctx, ch); id != "" {
			t.Errorf("channel %d got a marker %q with nothing due", ch, id)
		}
	}
	if countMessages(t, database, pinned) != 2 {
		t.Fatal("a pinned message was removed")
	}

	due, files := seedRetentionChannel(t, database, "due", uid, dir, 2)
	rep, err = svc.Tick(ctx)
	mustDo(t, "Tick", err)
	if rep.Messages != 2 || rep.Channels != 1 || countMessages(t, database, due) != 1 || len(files) != 2 {
		t.Fatalf("due tick = %+v, messages left %d", rep, countMessages(t, database, due))
	}
	if id, _ := markers.MessagesSweepID(ctx, due); id == "" || store.swept != 1 {
		t.Fatalf("due channel marker=%q swept=%d, want a marker and one swept record", id, store.swept)
	}
	if id, _ := markers.MessagesSweepID(ctx, idle); id != "" {
		t.Error("the idle channel got a marker on the later tick")
	}
}

// A failing probe stops the tick with an error and deletes nothing.
func TestRetention_TickProbeFailureDeletesNothing(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-probe", "hash", 1)
	ch, _ := seedRetentionChannel(t, database, "probe-fail", uid, dir, 2)
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}))
	svc, store, _ := newCountingRetention(t, database, dir)
	store.failProbe = true
	if _, err := svc.Tick(ctx); err == nil {
		t.Fatal("Tick succeeded with a failing probe")
	}
	if store.sweeps != 0 || countMessages(t, database, ch) != 3 {
		t.Fatalf("sweeps=%d messages=%d after a probe failure", store.sweeps, countMessages(t, database, ch))
	}
}
