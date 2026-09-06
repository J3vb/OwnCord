package db

// SetModerationActionPreInsertHookForTest installs (or, with nil, clears)
// the barrier moderationActionPreInsertHook runs inside recordModerationAction's
// transaction, after the rank check and before the insert. Exported for
// db_test's black-box contention test (P2-12, Codex review) — production
// code never calls this.
func SetModerationActionPreInsertHookForTest(fn func()) {
	moderationActionPreInsertHook = fn
}

// SetAppealReversalHookForTest installs (or, with nil, clears) the seam
// applyAppealReversalTx checks before running any kind's reversal. F1's own
// revert-proof test forces a non-nil error here to prove a failed reversal
// aborts the whole DecideAppealTx transaction — nothing commits, including
// the decision itself. Exported for db_test; production code never calls
// this.
func SetAppealReversalHookForTest(fn func() error) {
	appealReversalHookForTest = fn
}
