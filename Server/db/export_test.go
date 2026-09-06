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

// SetAppealDecidePreBeginTxHookForTest installs (or, with nil, clears) the
// barrier DecideAppealTx runs immediately before its own BeginTx — round 3's
// seam for proving the decider's authority is re-read fresh INSIDE the
// transaction, not trusted from before it began. Exported for db_test;
// production code never calls this.
func SetAppealDecidePreBeginTxHookForTest(fn func()) {
	appealDecidePreBeginTxHook = fn
}

// SetAppealAssignPreBeginTxHookForTest is AssignAppealTx's twin of
// SetAppealDecidePreBeginTxHookForTest, for the plain (non-forced) assign
// path.
func SetAppealAssignPreBeginTxHookForTest(fn func()) {
	appealAssignPreBeginTxHook = fn
}

// SetForceReassignPreBeginTxHookForTest is forceReassignGuarded's twin,
// shared by reports' and appeals' force-reassign paths.
func SetForceReassignPreBeginTxHookForTest(fn func()) {
	forceReassignPreBeginTxHook = fn
}

// SetAppealInsertPreHookForTest installs (or, with nil, clears) the barrier
// InsertAppeal runs immediately before its own INSERT — the seam a
// concurrent-submit contention test uses to force two goroutines to
// genuinely both reach the write together. Exported for db_test only;
// production code never calls this.
func SetAppealInsertPreHookForTest(fn func()) {
	appealInsertPreHookForTest = fn
}
