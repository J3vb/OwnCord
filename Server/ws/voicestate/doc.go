// Package voicestate holds the hub's self-contained voice state: per-user voice locks,
// moderator rejoin blocks and the reconciler's missed-tick counters. Each type is usable as
// its zero value and owns its lock; none calls back into ws, so every lock here is taken
// last (rank table: ws/lock_order.go).
package voicestate
