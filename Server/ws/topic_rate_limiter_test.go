package ws

import (
	"testing"
	"time"
)

// TopicRateLimiter.Cleanup is the only thing bounding the bucket map: a busy
// server sees a bucket per topic, and topics include per-channel and per-DM
// values, so without the sweep the map grows for the life of the process.
// It had no coverage. This test lives in package ws so it can read the
// unexported bucket map directly rather than inferring size from behaviour.

func (trl *TopicRateLimiter) bucketCount() int {
	trl.mu.Lock()
	defer trl.mu.Unlock()
	return len(trl.buckets)
}

func TestTopicRateLimiter_Cleanup_RemovesStaleBuckets(t *testing.T) {
	trl := NewTopicRateLimiter(10, time.Second)

	trl.Allow(Topic("channel:1"))
	trl.Allow(Topic("channel:2"))
	if got := trl.bucketCount(); got != 2 {
		t.Fatalf("bucketCount = %d after two topics, want 2", got)
	}

	// Backdate one bucket so it falls outside the max age.
	trl.mu.Lock()
	trl.buckets[Topic("channel:1")].lastReset = time.Now().Add(-time.Hour)
	trl.mu.Unlock()

	trl.Cleanup(30 * time.Minute)

	if got := trl.bucketCount(); got != 1 {
		t.Fatalf("bucketCount = %d after cleanup, want 1", got)
	}
	trl.mu.Lock()
	_, staleSurvives := trl.buckets[Topic("channel:1")]
	_, freshSurvives := trl.buckets[Topic("channel:2")]
	trl.mu.Unlock()
	if staleSurvives {
		t.Error("the stale bucket survived Cleanup")
	}
	if !freshSurvives {
		t.Error("Cleanup removed a bucket that was still within maxAge")
	}
}

func TestTopicRateLimiter_Cleanup_KeepsFreshBuckets(t *testing.T) {
	trl := NewTopicRateLimiter(10, time.Second)
	trl.Allow(Topic("channel:1"))

	trl.Cleanup(time.Hour)

	if got := trl.bucketCount(); got != 1 {
		t.Errorf("bucketCount = %d, want the fresh bucket to survive", got)
	}
}

func TestTopicRateLimiter_Cleanup_EmptyMap(t *testing.T) {
	trl := NewTopicRateLimiter(10, time.Second)

	trl.Cleanup(time.Minute) // must not panic on an empty map

	if got := trl.bucketCount(); got != 0 {
		t.Errorf("bucketCount = %d, want 0", got)
	}
}

func TestTopicRateLimiter_Allow_EnforcesQuotaThenRefills(t *testing.T) {
	trl := NewTopicRateLimiter(2, 50*time.Millisecond)
	topic := Topic("channel:1")

	// Kept as two statements rather than `a || b`: `||` short-circuits, so a
	// failing first call would skip the second and leave a token unspent —
	// the third Allow below would then be within quota and the test would
	// report the wrong thing.
	if !trl.Allow(topic) {
		t.Fatal("the first message was rejected despite a quota of 2")
	}
	if !trl.Allow(topic) {
		t.Fatal("the second message was rejected despite a quota of 2")
	}
	if trl.Allow(topic) {
		t.Error("a third message was allowed within the same window")
	}

	// A separate topic has its own bucket — one busy channel must not starve
	// the others, which is the whole point of the per-topic limiter.
	if !trl.Allow(Topic("channel:2")) {
		t.Error("a different topic was rate limited by channel:1's usage")
	}

	// After the window elapses the bucket refills.
	trl.mu.Lock()
	trl.buckets[topic].lastReset = time.Now().Add(-time.Second)
	trl.mu.Unlock()
	if !trl.Allow(topic) {
		t.Error("the bucket did not refill after its window elapsed")
	}
}
