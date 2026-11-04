package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// The mention emit lock is per channel: while one channel's lock is held (as the
// worker holds it across a write), a read-pointer move and a delete reversal on
// another channel go through, and the same channel still waits.
func TestMentionEmitLocks_OtherChannelDoesNotWait(t *testing.T) {
	svc, _, database := newMentionFixture(t)
	seedChannel(t, database, &db.Channel{ID: 11, Name: "other", Type: "text"})
	if svc.mentionEmitLocks.forChannel(10) == svc.mentionEmitLocks.forChannel(11) {
		t.Fatal("channels 10 and 11 share a stripe; pick channels that do not")
	}

	locked := make(chan struct{})
	release := make(chan struct{})
	held := make(chan struct{})
	go func() {
		defer close(held)
		mu := svc.mentionEmitLocks.forChannel(10)
		mu.Lock()
		close(locked)
		<-release
		mu.Unlock()
	}()
	<-locked
	defer func() {
		close(release)
		<-held
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := svc.MoveReadPointer(ctx, 2, 11, db.ReadAtLatest, 0); err != nil {
		t.Fatalf("MoveReadPointer on another channel: %v", err)
	}
	if err := svc.reverseMentionCounts(ctx, 11, []int64{1}); err != nil {
		t.Fatalf("reverseMentionCounts on another channel: %v", err)
	}

	short, cancelShort := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancelShort()
	if _, err := svc.MoveReadPointer(short, 2, 10, db.ReadAtLatest, 0); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("MoveReadPointer on the held channel: err = %v, want context.DeadlineExceeded", err)
	}
}

// A negative or large id picks a valid stripe (no out-of-range panic), and ids
// a stripe count apart share one.
func TestMentionEmitLocks_ForChannelStaysInRange(t *testing.T) {
	var l mentionEmitLocks
	for _, id := range []int64{0, 1, 63, 64, -1, -64, 1 << 62, -(1 << 62), -1 << 63} {
		if l.forChannel(id) == nil {
			t.Fatalf("channel %d has no stripe", id)
		}
	}
	if l.forChannel(5) != l.forChannel(5+mentionEmitStripes) {
		t.Fatal("ids a stripe count apart map to different stripes")
	}
	if l.forChannel(1) == l.forChannel(2) {
		t.Fatal("neighbouring channels share a stripe")
	}
}
