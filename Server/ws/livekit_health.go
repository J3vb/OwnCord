package ws

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// liveKitHealthTTL is how long one LiveKit health verdict is reused. Voice joins,
// metrics scrapes, diagnostics and /health all read the same verdict, so a burst of
// joins or a scraper costs at most one room listing per window.
const liveKitHealthTTL = 5 * time.Second

// liveKitHealthCache holds the last verdict and coalesces concurrent probes into
// one. The zero value is ready to use.
type liveKitHealthCache struct {
	mu    syncutil.Ranked[lockRankLeaf]
	at    time.Time
	ok    bool
	err   error
	group singleflight.Group
	now   func() time.Time // test seam; nil means time.Now
}

func (h *liveKitHealthCache) clock() time.Time {
	if h.now != nil {
		return h.now()
	}
	return time.Now()
}

func (h *liveKitHealthCache) fresh() (ok bool, err error, hit bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.at.IsZero() || h.clock().Sub(h.at) >= liveKitHealthTTL {
		return false, nil, false
	}
	return h.ok, h.err, true
}

func (h *liveKitHealthCache) store(ok bool, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.at, h.ok, h.err = h.clock(), ok, err
}

// CachedHealthCheck is HealthCheck behind a liveKitHealthTTL cache with one probe in
// flight: callers that find the cache cold while a probe runs wait for that probe
// instead of starting their own. The probe is detached from the first caller's
// cancellation (HealthCheck bounds it at 3 s), so a caller that gives up does not
// fail the verdict for the others; a caller whose own ctx ends stops waiting.
func (c *LiveKitClient) CachedHealthCheck(ctx context.Context) (bool, error) {
	if ok, err, hit := c.health.fresh(); hit {
		return ok, err
	}
	probeCtx := context.WithoutCancel(ctx)
	ch := c.health.group.DoChan("probe", func() (any, error) {
		ok, err := c.HealthCheck(probeCtx)
		c.health.store(ok, err)
		return ok, err
	})
	select {
	case r := <-ch:
		ok, _ := r.Val.(bool)
		return ok, r.Err
	case <-ctx.Done():
		return false, fmt.Errorf("livekit health check: %w", ctx.Err())
	}
}
