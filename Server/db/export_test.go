package db

// SetModerationActionPreInsertHookForTest installs (or, with nil, clears)
// the barrier moderationActionPreInsertHook runs inside recordModerationAction's
// transaction, after the rank check and before the insert. Exported for
// db_test's black-box contention test (P2-12, Codex review) — production
// code never calls this.
func SetModerationActionPreInsertHookForTest(fn func()) {
	moderationActionPreInsertHook = fn
}

// SetModerationActionPreBeginTxHookForTest installs (or, with nil, clears)
// the barrier moderationActionPreBeginTxHook runs at the top of
// BanUserWithAction, before BeginTx is called. Exported for db_test's
// black-box contention test (P2-12 PARTIAL, Codex review round 3) —
// production code never calls this.
func SetModerationActionPreBeginTxHookForTest(fn func()) {
	moderationActionPreBeginTxHook = fn
}
