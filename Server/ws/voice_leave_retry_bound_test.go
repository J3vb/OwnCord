package ws

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// wedgedLeaveVoiceStore is the real voice service whose LeaveIfMatch fails
// its first, synchronous attempt and then blocks every background retry until
// that retry's ctx ends, reporting how it ended — a wedged DB.
type wedgedLeaveVoiceStore struct {
	*service.VoiceService
	calls atomic.Int32
	ended chan error
}

func (s *wedgedLeaveVoiceStore) LeaveIfMatch(ctx context.Context, _, _ int64, _ string) (bool, error) {
	if s.calls.Add(1) == 1 {
		return false, errors.New("database is locked")
	}
	<-ctx.Done()
	s.ended <- ctx.Err()
	return false, ctx.Err()
}

// The retries run on a goroutine detached from the caller's ctx, so the hub's
// stop channel is checked only between attempts. Each attempt must still give
// up at its own deadline: a wedged DB otherwise parks the goroutine for good.
func TestLeaveVoiceChannelWithRetry_RetryAttemptsAreBounded(t *testing.T) {
	t.Parallel()
	old := voiceLeaveRetryTimeout.Load()
	voiceLeaveRetryTimeout.Store(int64(20 * time.Millisecond))
	t.Cleanup(func() { voiceLeaveRetryTimeout.Store(old) })

	database := newHarvestVoiceDB(t)
	voice := &wedgedLeaveVoiceStore{VoiceService: service.NewVoiceService(database), ended: make(chan error, 2)}
	h := newTestHubWith(t, HubOptions{DB: database, Voice: voice})

	if err := h.leaveVoiceChannelWithRetryTest(context.Background(), 1, 2, "tok"); err == nil {
		t.Fatal("leaveVoiceChannelWithRetry = nil, want the first attempt's error")
	}

	for attempt := 2; attempt <= 3; attempt++ {
		select {
		case err := <-voice.ended:
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Errorf("retry %d ended with %v, want context.DeadlineExceeded", attempt, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("retry %d never ended: its ctx has no deadline", attempt)
		}
	}
}
