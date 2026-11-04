// Package voicestate holds the hub's self-contained voice state: the
// per-user voice locks, the moderator rejoin blocks and the reconciler's
// missed-tick counters. Each type is usable as its zero value and owns its
// lock; none calls back into ws, so every lock here is taken last (see the
// rank table in ws/lock_order.go).
package voicestate
