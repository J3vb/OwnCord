package service

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/safefetch"
)

// seedGeneralChannel creates channel 10 and gives users 1 and 2 the
// fixture's member role, the audience nearly every dispatch test starts from.
func (f *pushDispatchFixture) seedGeneralChannel(t *testing.T) {
	t.Helper()
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
}

// newDispatcher wires a dispatcher to the fixture with no online users.
func (f *pushDispatchFixture) newDispatcher(fetch PushFetcher) *PushDispatcher {
	return NewPushDispatcher(f.database, f.perms, f.push, nil, fetch)
}

// newRetryDispatcher is newDispatcher with the retry backoff stubbed out.
func (f *pushDispatchFixture) newRetryDispatcher(fetch PushFetcher) *PushDispatcher {
	d := f.newDispatcher(fetch)
	d.sleep = noSleep
	return d
}

// requireCounters fails the test unless the dispatcher's delivered, failed
// and pruned counters match; note explains a non-obvious expectation.
func requireCounters(t *testing.T, d *PushDispatcher, delivered, failed, pruned uint64, note string) {
	t.Helper()
	gd, gf, gp := d.Counters()
	if gd != delivered || gf != failed || gp != pruned {
		t.Errorf("counters = %d/%d/%d, want %d/%d/%d %s", gd, gf, gp, delivered, failed, pruned, note)
	}
}

// failFirstAttempt answers endpoint's first push attempt with a transient 503
// after running afterFirst, the state change a retry must notice, and fails
// the test if a second attempt ever reaches the fetcher. It returns the
// attempt counter.
func failFirstAttempt(t *testing.T, fetch *recordingPushFetcher, endpoint, because string, afterFirst func(ctx context.Context)) *atomic.Int32 {
	t.Helper()
	var calls atomic.Int32
	fetch.onFetch(endpoint, func(ctx context.Context) (*safefetch.Response, error) {
		if calls.Add(1) > 1 {
			t.Error("a second attempt reached the fetcher " + because)
			return &safefetch.Response{StatusCode: 201}, nil
		}
		afterFirst(ctx)
		return &safefetch.Response{StatusCode: 503}, nil
	})
	return &calls
}

// requireRetryRefused fails unless exactly one attempt was made: the retry
// has to be refused before it fetches.
func requireRetryRefused(t *testing.T, calls *atomic.Int32) {
	t.Helper()
	if got := calls.Load(); got != 1 {
		t.Errorf("fetch was called %d times, want exactly 1 (the retry must be refused before it fetches)", got)
	}
}

// seedLabelledChannel creates channel 10 as an age-labelled channel, which
// only recipients who acknowledged the label may read.
func (f *pushDispatchFixture) seedLabelledChannel(t *testing.T) {
	t.Helper()
	seedChannel(t, f.database, &db.Channel{ID: 10, Name: "nsfw-general", Type: "text"})
	_, err := f.database.ExecContext(context.Background(), `UPDATE channels SET nsfw = 1 WHERE id = ?`, int64(10))
	mustDo(t, "label channel", err)
}

// seedDirectMessage creates the one-to-one DM channel 20 between users 1 and
// 2, both holding the fixture's member role.
func (f *pushDispatchFixture) seedDirectMessage(t *testing.T) {
	t.Helper()
	seedChannel(t, f.database, &db.Channel{ID: 20, Type: "dm"})
	seedUserRole(t, f.database, 1, 4)
	seedUserRole(t, f.database, 2, 4)
	seedDMParticipant(t, f.database, 20, 1)
	seedDMParticipant(t, f.database, 20, 2)
}
