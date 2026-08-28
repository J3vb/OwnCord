package ws

import (
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// TopicRateLimiter enforces per-topic throughput caps to prevent a single
// busy channel from saturating the broadcast loop and starving others.
type TopicRateLimiter struct {
	mu          syncutil.Mutex
	buckets     map[Topic]*tokenBucket
	defaultRate int           // messages per window
	window      time.Duration // window size
}

// tokenBucket is a simple sliding-window rate limiter per topic.
type tokenBucket struct {
	tokens    int
	lastReset time.Time
}

// NewTopicRateLimiter creates a rate limiter with the given default rate.
// rate is the maximum messages per window for any single topic.
func NewTopicRateLimiter(rate int, window time.Duration) *TopicRateLimiter {
	return &TopicRateLimiter{
		buckets:     make(map[Topic]*tokenBucket),
		defaultRate: rate,
		window:      window,
	}
}

// Allow checks whether a message to the given topic is within the rate limit.
// Returns true if allowed, false if the topic has exceeded its quota.
func (trl *TopicRateLimiter) Allow(topic Topic) bool {
	trl.mu.Lock()
	defer trl.mu.Unlock()

	now := time.Now()
	b, ok := trl.buckets[topic]
	if !ok {
		b = &tokenBucket{tokens: trl.defaultRate, lastReset: now}
		trl.buckets[topic] = b
	}

	// Reset bucket if window has elapsed.
	if now.Sub(b.lastReset) >= trl.window {
		b.tokens = trl.defaultRate
		b.lastReset = now
	}

	if b.tokens <= 0 {
		return false
	}
	b.tokens--
	return true
}

// Cleanup removes stale buckets that haven't been used recently.
// Call periodically to prevent unbounded memory growth.
func (trl *TopicRateLimiter) Cleanup(maxAge time.Duration) {
	trl.mu.Lock()
	defer trl.mu.Unlock()

	now := time.Now()
	for topic, b := range trl.buckets {
		if now.Sub(b.lastReset) > maxAge {
			delete(trl.buckets, topic)
		}
	}
}
