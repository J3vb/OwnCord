package admin

// logRing is a fixed backing array plus write position: overwriting the
// oldest entry is a single slot store.
type logRing struct {
	entries []LogEntry // len == capacity
	pos     int        // next write position
	count   int        // entries stored (up to len(entries))
}

func (r *logRing) push(entry LogEntry) {
	r.entries[r.pos] = entry
	r.pos = (r.pos + 1) % len(r.entries)
	if r.count < len(r.entries) {
		r.count++
	}
}

func (r *logRing) snapshot() []LogEntry {
	out := make([]LogEntry, r.count)
	if r.count < len(r.entries) {
		// Not yet wrapped: entries [0, count) are already in order.
		copy(out, r.entries[:r.count])
		return out
	}
	// Wrapped: oldest entry sits at pos.
	n := copy(out, r.entries[r.pos:])
	copy(out[n:], r.entries[:r.pos])
	return out
}
