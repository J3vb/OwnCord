package syncutil

import "time"

// TTLCache memoises one value for a fixed time. The zero value is ready to
// use. It is safe for concurrent callers: the mutex is held across the load,
// so concurrent misses share one query instead of each running it. A failed
// load is returned to its caller and never cached.
type TTLCache[T any] struct {
	// Now supplies the clock; nil means time.Now. Tests inject a fake.
	Now func() time.Time

	mu  Mutex
	val T
	at  time.Time
	set bool
}

// Get returns the cached value when it is younger than ttl, otherwise calls
// load, caches a successful result and returns it.
func (c *TTLCache[T]) Get(ttl time.Duration, load func() (T, error)) (T, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	if c.set && now().Sub(c.at) < ttl {
		return c.val, nil
	}
	v, err := load()
	if err != nil {
		var zero T
		return zero, err
	}
	c.val, c.at, c.set = v, now(), true
	return v, nil
}
