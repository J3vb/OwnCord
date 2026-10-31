package metrics

import (
	"sort"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// SlowRoutes keeps the last hour of request times per route pattern, for the
// admin Dashboard's slow requests card. Each route has twelve five-minute
// slots in a ring; a slot whose period has passed is cleared by the next
// write or skipped by the next read, so nothing runs in the background.
//
// The key is the router's pattern (GET /api/v1/channels/{id}/messages), never
// the raw path, so ids and tokens never reach the card, and the set of keys is
// bounded by the routes the server mounts. maxSlowRoutes is a backstop.

const (
	// SlowRouteSlot is one slot's length; SlowRouteWindow is what the card reads.
	SlowRouteSlot   = 5 * time.Minute
	SlowRouteWindow = slowRouteSlots * SlowRouteSlot
	slowRouteSlots  = 12
	maxSlowRoutes   = 512
)

// RouteTiming is one route's figures over the window. P50 and P95 are bucket
// upper bounds capped at Max, like Summary; Max is exact.
type RouteTiming struct {
	Method string  `json:"method"`
	Route  string  `json:"route"`
	Count  uint64  `json:"count"`
	P50    float64 `json:"p50_ms"`
	P95    float64 `json:"p95_ms"`
	Max    float64 `json:"max_ms"`
}

type routeSlot struct {
	period    int64 // unix time / slot length; 0 is never a live period
	buckets   [numBuckets]uint64
	count     uint64
	maxMicros uint64
}

// routeRing is one route's slots. mu is a leaf lock held only for arithmetic,
// so a request pays one uncontended lock per route it hits; a slot reset has
// to clear several fields together, which atomics alone cannot do in one step.
type routeRing struct {
	mu    syncutil.Mutex
	slots [slowRouteSlots]routeSlot
}

// SlowRoutes is safe for concurrent use. Build it with NewSlowRoutes.
type SlowRoutes struct {
	now func() time.Time

	// mu guards routes (the map, not the rings). Leaf lock, taken before a
	// ring's own lock and released before the ring is written.
	mu     syncutil.RWMutex
	routes map[string]*routeRing
}

// NewSlowRoutes returns an empty tracker. now is time.Now outside tests.
func NewSlowRoutes(now func() time.Time) *SlowRoutes {
	return &SlowRoutes{now: now, routes: make(map[string]*routeRing)}
}

func slowRouteKey(method, pattern string) string { return method + " " + pattern }

func slowRoutePeriod(t time.Time) int64 { return t.Unix() / int64(SlowRouteSlot/time.Second) }

// Observe records one request. A nil tracker and an empty pattern (a request
// no route matched) are ignored. Allocation-free once the route is known.
func (s *SlowRoutes) Observe(method, pattern string, d time.Duration) {
	if s == nil || pattern == "" {
		return
	}
	ring := s.ring(method, pattern)
	if ring == nil {
		return
	}
	period := slowRoutePeriod(s.now())
	micros := uint64(max(d, 0) / time.Microsecond)
	ms := float64(micros) / 1000
	i := len(latencyBoundsMs)
	for j, bound := range latencyBoundsMs {
		if ms <= bound {
			i = j
			break
		}
	}
	ring.mu.Lock()
	slot := &ring.slots[period%slowRouteSlots]
	if slot.period != period {
		*slot = routeSlot{period: period}
	}
	slot.buckets[i]++
	slot.count++
	slot.maxMicros = max(slot.maxMicros, micros)
	ring.mu.Unlock()
}

// ring returns the route's ring, creating it while under maxSlowRoutes.
func (s *SlowRoutes) ring(method, pattern string) *routeRing {
	key := slowRouteKey(method, pattern)
	s.mu.RLock()
	ring := s.routes[key]
	s.mu.RUnlock()
	if ring != nil {
		return ring
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing := s.routes[key]; existing != nil {
		return existing
	}
	if len(s.routes) >= maxSlowRoutes {
		return nil
	}
	ring = &routeRing{}
	s.routes[key] = ring
	return ring
}

// Slowest returns up to n routes seen in the last SlowRouteWindow, slowest
// first: by P95, then Max, then route name so equal figures keep a stable
// order. Each route is read under its own lock, so its figures are one
// consistent copy even while requests and a slot rollover race the read.
func (s *SlowRoutes) Slowest(n int) []RouteTiming {
	out := []RouteTiming{}
	if s == nil || n <= 0 {
		return out
	}
	s.mu.RLock()
	keys := make([]string, 0, len(s.routes))
	rings := make([]*routeRing, 0, len(s.routes))
	for k, r := range s.routes {
		keys = append(keys, k)
		rings = append(rings, r)
	}
	s.mu.RUnlock()

	oldest := slowRoutePeriod(s.now()) - slowRouteSlots + 1
	for i, ring := range rings {
		var buckets [numBuckets]uint64
		var count, maxMicros uint64
		ring.mu.Lock()
		for j := range ring.slots {
			slot := &ring.slots[j]
			if slot.period < oldest {
				continue
			}
			for b := range buckets {
				buckets[b] += slot.buckets[b]
			}
			count += slot.count
			maxMicros = max(maxMicros, slot.maxMicros)
		}
		ring.mu.Unlock()
		if count == 0 {
			continue
		}
		method, route, _ := strings.Cut(keys[i], " ")
		out = append(out, RouteTiming{
			Method: method,
			Route:  route,
			Count:  count,
			P50:    quantile(&buckets, count, maxMicros, 0.50),
			P95:    quantile(&buckets, count, maxMicros, 0.95),
			Max:    float64(maxMicros) / 1000,
		})
	}
	sort.Slice(out, func(a, b int) bool {
		x, y := out[a], out[b]
		if x.P95 != y.P95 {
			return x.P95 > y.P95
		}
		if x.Max != y.Max {
			return x.Max > y.Max
		}
		return slowRouteKey(x.Method, x.Route) < slowRouteKey(y.Method, y.Route)
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}
