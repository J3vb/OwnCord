package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

func setReplayPurgeBeforeDelete(t *testing.T, hook func()) {
	t.Helper()
	replayPurgeBeforeDelete = hook
	t.Cleanup(func() { replayPurgeBeforeDelete = nil })
}

// The persisted-row delete runs after the purge has released seqMu, so live
// delivery carries on while it runs; a cold-tier read during it fails fast,
// so a resume takes the full ready instead of reading rows the ring has
// dropped but the database still holds (2A-7).
func TestPurgeReplay_DeleteRunsOutsideSeqMuAndFailsColdReads(t *testing.T) {
	ctx := context.Background()
	database := newTeardownTestDB(t)
	h := newTestHubWith(t, HubOptions{DB: database})
	h.SetEventStore(database)
	store := *h.eventStore.Load()

	delivered := make(chan uint64, 1)
	setReplayPurgeBeforeDelete(t, func() {
		//nolint:contextcheck // deliverBroadcast runs on the dispatch goroutine and takes no context by design.
		go func() {
			delivered <- sequenceFiller(h)
		}()
		select {
		case seq := <-delivered:
			if seq != 1 {
				t.Error("a broadcast during the delete was not sequenced")
			}
		case <-time.After(5 * time.Second):
			t.Error("a broadcast could not be sequenced while the purge deleted rows: seqMu is still held")
		}
		// From another goroutine, as a resume would; the purge's own
		// goroutine holds the lock for writing.
		errs := make(chan [3]error, 1)
		go func() {
			var e [3]error
			_, e[0] = store.GetEventsSince(ctx, 0, 10)
			_, e[1] = store.GetEventsSinceForChannels(ctx, 0, []int64{1}, 10)
			_, e[2] = store.CountEventsInRange(ctx, 0, 10)
			errs <- e
		}()
		for i, err := range <-errs {
			if !errors.Is(err, errReplayPurgeInProgress) {
				t.Errorf("cold read %d during the purge: err = %v, want errReplayPurgeInProgress", i, err)
			}
		}
	})

	if err := h.PurgeUserFromReplay(ctx, 42); err != nil {
		t.Fatalf("PurgeUserFromReplay: %v", err)
	}
	if _, err := store.GetEventsSince(ctx, 0, 10); err != nil {
		t.Fatalf("GetEventsSince after the purge: %v", err)
	}
}

// sequenceFiller delivers one frame and returns how many seqs it took.
func sequenceFiller(h *Hub) uint64 {
	before := atomic.LoadUint64(&h.seq)
	h.deliverBroadcast(broadcastMsg{msg: []byte(`{"type":"server_filler"}`)})
	return atomic.LoadUint64(&h.seq) - before
}

func chatEditedFrame(messageID int64) []byte {
	b, _ := json.Marshal(map[string]any{
		"type":    MsgTypeChatEdited,
		"payload": map[string]any{"message_id": messageID, "channel_id": 5, "content": "late"},
	})
	return b
}

func droppedByTombstones(h *Hub, msg []byte) bool {
	h.seqMu.Lock()
	defer h.seqMu.Unlock()
	return h.dropsForTombstones(msg)
}

// Each retention batch adds to the message tombstones instead of replacing
// them: a late frame about a message from an earlier batch is still dropped.
func TestTombstones_MessageBatchesAccumulate(t *testing.T) {
	ctx := context.Background()
	h := newTestHubWith(t, HubOptions{DB: newTeardownTestDB(t)})
	if err := h.PurgeMessagesFromReplay(ctx, []int64{101}); err != nil {
		t.Fatal(err)
	}
	if err := h.PurgeMessagesFromReplay(ctx, []int64{202}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{101, 202} {
		if !droppedByTombstones(h, chatEditedFrame(id)) {
			t.Errorf("a late chat_edited for swept message %d was not dropped", id)
		}
	}
	if droppedByTombstones(h, chatEditedFrame(303)) {
		t.Error("a frame about a message no sweep removed was dropped")
	}
}

// A tombstone expires only once it is both older than tombstoneMinAge and
// further behind the current seq than the ring and cold tier can replay.
func TestTombstones_ExpireOnlyPastAgeAndReplayHorizon(t *testing.T) {
	ctx := context.Background()
	h := newTestHubWith(t, HubOptions{DB: newTeardownTestDB(t)})
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	h.tombstones.now = func() time.Time { return now }
	if err := h.PurgeUserFromReplay(ctx, 7); err != nil {
		t.Fatal(err)
	}
	if err := h.PurgeMessagesFromReplay(ctx, []int64{9}); err != nil {
		t.Fatal(err)
	}
	horizon := uint64(h.replayBuf.size + h.maxColdReplayLimit())
	base := atomic.LoadUint64(&h.seq)
	kept := func(label string) {
		t.Helper()
		if !h.tombstones.erased(7) || len(h.tombstones.messages) != 1 {
			t.Fatalf("%s: tombstones expired too early", label)
		}
	}

	now = now.Add(2 * tombstoneMinAge)
	h.expireReplayTombstones()
	kept("old but within the replay horizon")

	now = now.Add(-2 * tombstoneMinAge)
	atomic.StoreUint64(&h.seq, base+horizon+1)
	h.expireReplayTombstones()
	kept("past the horizon but young")

	now = now.Add(2 * tombstoneMinAge)
	h.expireReplayTombstones()
	if h.tombstones.erased(7) || len(h.tombstones.messages) != 0 {
		t.Fatal("tombstones past both the age and the replay horizon were kept")
	}
}

// Expiring an old batch keeps an id a later batch installed again.
func TestTombstones_ExpireKeepsReinstalledIDs(t *testing.T) {
	var ts replayPurgeState
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	ts.now = func() time.Time { return now }
	ts.add(&ts.messages, 1, 5, 6)
	now = now.Add(2 * tombstoneMinAge)
	ts.add(&ts.messages, 100, 6)
	if n := ts.expire(50, 10); n != 1 {
		t.Fatalf("expired %d ids, want 1", n)
	}
	if _, ok := ts.messages[6]; !ok {
		t.Fatal("an id a later batch reinstalled was expired with the older batch")
	}
	if _, ok := ts.messages[5]; ok {
		t.Fatal("an id only the expired batch held was kept")
	}
	if len(ts.batches) != 1 || ts.batches[0].seq != 100 {
		t.Fatalf("batches = %+v, want only the seq-100 batch", ts.batches)
	}
}

// A field of an unexpected JSON type does not hide the ids in other fields.
func TestParseFrameRefs_TolerantOfOddFieldTypes(t *testing.T) {
	users := map[int64]uint64{7: 0}
	for _, tc := range []struct {
		name  string
		frame string
		want  bool
	}{
		{"clean", `{"type":"chat_message","payload":{"id":1,"user":{"id":7}}}`, true},
		{"string mentions", `{"type":"chat_message","payload":{"id":1,"mentions":"x","user":{"id":7}}}`, true},
		{"string id", `{"type":"chat_message","payload":{"id":"1","user_id":7}}`, true},
		{"not json", `{"type":`, false},
		{"other user", `{"type":"chat_message","payload":{"id":1,"user":{"id":8}}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			refs, ok := parseFrameRefs([]byte(tc.frame))
			_, hit := refs.userIn(users)
			if got := ok && hit; got != tc.want {
				t.Fatalf("names erased user = %v, want %v", got, tc.want)
			}
		})
	}
}

// One frame is parsed once, so its cost does not grow with the number of
// erased users.
func BenchmarkDeliverBroadcast_ErasedUsers(b *testing.B) {
	frame := []byte(`{"type":"chat_message","payload":{"id":1,"channel_id":5,"user":{"id":3},"content":"hi","mentions":[4,5]}}`)
	for _, n := range []int{0, 10, 100} {
		b.Run(fmt.Sprintf("erased=%d", n), func(b *testing.B) {
			h := newEmitTestHub()
			for i := range n {
				h.tombstones.add(&h.tombstones.users, 0, int64(1000+i))
			}
			b.ResetTimer()
			for b.Loop() {
				h.deliverBroadcast(broadcastMsg{channelID: 5, msg: frame})
			}
		})
	}
}
