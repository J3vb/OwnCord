package ws

// voice_leave_join_test.go — the hub's voice-leave cleanup (the LiveKit
// participant removal and the voice-state delete retries) runs on the hub's
// background group, so stopping the hub cancels and joins it (ARCH-034,
// WP 4.5b). A cleanup spawned while the hub is stopping is either joined or
// refused, never left running after the join returns.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	lkproto "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
)

func TestRemoveParticipantAsync_JoinedByStopHub(t *testing.T) {
	database := newHarvestVoiceDB(t)

	// A LiveKit that never answers: the removal ends only when its ctx does.
	var entered atomic.Int32
	enteredCh := make(chan struct{}, 4)
	lkSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		entered.Add(1)
		enteredCh <- struct{}{}
		<-r.Context().Done()
		out, _ := proto.Marshal(&lkproto.RemoveParticipantResponse{})
		_, _ = w.Write(out)
	}))
	defer lkSrv.Close()

	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "testkeytestkeytest",
		LiveKitAPISecret: "testsecrettestsecrettestsecret",
		LiveKitURL:       "ws://" + lkSrv.Listener.Addr().String(),
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})

	h.removeLiveKitParticipantAsync(context.Background(), 1, 2, "tok", "test")
	select {
	case <-enteredCh:
	case <-time.After(5 * time.Second):
		t.Fatal("the removal never reached LiveKit")
	}

	// Stop alone does not cancel an in-flight removal (a mid-request cancel
	// leaves a ghost in the SFU). A short join must therefore report the job
	// still running, which also proves it is owned by the hub's group: on an
	// unowned group this would report 0.
	h.Stop()
	short, cancelShort := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancelShort()
	if n := h.JoinBackground(short); n != 1 {
		t.Fatalf("JoinBackground within the grace reported %d running jobs, want the removal still in flight", n)
	}
	// That join gave up and cancelled the group; a second one waits the
	// cancelled job out.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if n := h.JoinBackground(ctx); n != 0 {
		t.Fatalf("JoinBackground left %d jobs running, want the removal cancelled and joined", n)
	}

	// Edge: a removal requested once the hub is stopped is refused, so nothing
	// is running after the join returned and nothing reaches LiveKit.
	h.removeLiveKitParticipantAsync(context.Background(), 1, 2, "tok2", "test-late")
	if h.background.Go(context.Background(), func(context.Context) {}) {
		t.Error("the hub's group admitted a job after JoinBackground")
	}
	time.Sleep(100 * time.Millisecond)
	if got := entered.Load(); got != 1 {
		t.Errorf("LiveKit saw %d removals, want only the one spawned before the stop", got)
	}
}

// stopJoinLeaveStore is the voice service whose LeaveIfMatch fails calls 1 and
// 3 (each leave's synchronous attempt) and blocks every other call (a
// background retry) until its ctx ends, reporting how it ended. The call then
// returns only once release is closed: a cancelled retry otherwise exits in
// the microseconds between the group's cancel and its running count, and a
// short join that raced it read 0 (#2797, run 40097892996).
type stopJoinLeaveStore struct {
	*service.VoiceService
	calls   atomic.Int32
	ended   chan error
	release chan struct{}
}

func (s *stopJoinLeaveStore) LeaveIfMatch(ctx context.Context, _, _ int64, _ string) (bool, error) {
	if n := s.calls.Add(1); n == 1 || n == 3 {
		return false, errors.New("database is locked")
	}
	<-ctx.Done()
	s.ended <- ctx.Err()
	<-s.release
	return false, ctx.Err()
}

func TestVoiceLeaveRetry_JoinedByStopHub(t *testing.T) {
	t.Parallel()
	old := voiceLeaveRetryTimeout.Load()
	voiceLeaveRetryTimeout.Store(int64(time.Hour)) // only the hub stop may end the retry
	t.Cleanup(func() { voiceLeaveRetryTimeout.Store(old) })

	database := newHarvestVoiceDB(t)
	voice := &stopJoinLeaveStore{
		VoiceService: service.NewVoiceService(database),
		ended:        make(chan error, 4),
		release:      make(chan struct{}),
	}
	var releaseOnce sync.Once
	releaseRetry := func() { releaseOnce.Do(func() { close(voice.release) }) }
	t.Cleanup(releaseRetry)
	h := newTestHubWith(t, HubOptions{DB: database, Voice: voice})

	if err := leaveVoiceChannelWithRetry(context.Background(), h.heldTxn(1), 2, "tok"); err == nil {
		t.Fatal("leaveVoiceChannelWithRetry = nil, want the first attempt's error")
	}
	// Wait until the retry is parked inside the store (its first backoff is 200 ms).
	deadline := time.Now().Add(5 * time.Second)
	for voice.calls.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("the background retry never ran")
		}
		time.Sleep(10 * time.Millisecond)
	}

	h.Stop()
	short, cancelShort := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancelShort()
	if n := h.JoinBackground(short); n != 1 {
		t.Fatalf("JoinBackground within the grace reported %d running jobs, want the parked retry (owned by the hub group)", n)
	}
	releaseRetry()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if n := h.JoinBackground(ctx); n != 0 {
		t.Fatalf("JoinBackground left %d jobs running, want the retry cancelled and joined", n)
	}
	select {
	case err := <-voice.ended:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("retry ended with %v, want context.Canceled from the hub stop", err)
		}
	default:
		t.Error("the retry's store call was not interrupted")
	}

	// Edge: a leave that fails once the hub is stopped gets no retry. The
	// retry is refused rather than left running after the join.
	if err := leaveVoiceChannelWithRetry(context.Background(), h.heldTxn(1), 2, "tok2"); err == nil {
		t.Fatal("late leave = nil, want the synchronous attempt's error")
	}
	time.Sleep(400 * time.Millisecond) // longer than the first backoff
	if got := voice.calls.Load(); got != 3 {
		t.Errorf("store calls = %d, want 3: no retry for a leave that failed after the join", got)
	}
}
