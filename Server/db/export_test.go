package db

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

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

// SetAppealDecideInTxHookForTest installs (or, with nil, clears) the
// barrier DecideAppealTx runs INSIDE its own transaction, right after
// BeginTx — round 4's seam (replacing round 3's bare func() one) for
// proving the decider's authority is re-read fresh via THIS transaction's
// own connection, not merely at some point after an external mutation.
// Exported for db_test; production code never calls this.
func SetAppealDecideInTxHookForTest(fn func(ctx context.Context, q *dbgen.Queries) error) {
	appealDecideInTxHook = fn
}

// SetAppealAssignInTxHookForTest is AssignAppealTx's twin of
// SetAppealDecideInTxHookForTest, for the plain (non-forced) assign path.
func SetAppealAssignInTxHookForTest(fn func(ctx context.Context, q *dbgen.Queries) error) {
	appealAssignInTxHook = fn
}

// SetForceReassignInTxHookForTest is forceReassignGuarded's twin, shared by
// reports' and appeals' force-reassign paths.
func SetForceReassignInTxHookForTest(fn func(ctx context.Context, q *dbgen.Queries) error) {
	forceReassignInTxHook = fn
}

// SetAppealInsertPreHookForTest installs (or, with nil, clears) the barrier
// InsertAppeal runs immediately before its own INSERT — the seam a
// concurrent-submit contention test uses to force two goroutines to
// genuinely both reach the write together. Exported for db_test only;
// production code never calls this.
func SetAppealInsertPreHookForTest(fn func()) {
	appealInsertPreHookForTest = fn
}

// SetModerationActionPreRankCheckHookForTest installs (or, with nil, clears)
// the barrier moderationActionPreRankCheckHook runs inside
// recordModerationAction's transaction, before either rolePosition call —
// one step earlier than SetModerationActionPreInsertHookForTest's own
// barrier. Exported for db_test's black-box contention test — production
// code never calls this.
func SetModerationActionPreRankCheckHookForTest(fn func()) {
	moderationActionPreRankCheckHook = fn
}

// SetModerationActionPreBeginTxHookForTest installs (or, with nil, clears)
// the barrier moderationActionPreBeginTxHook runs at the top of
// BanUserWithAction, before BeginTx is called. Exported for db_test's
// black-box contention test (P2-12 PARTIAL, Codex review round 3) —
// production code never calls this.
func SetModerationActionPreBeginTxHookForTest(fn func()) {
	moderationActionPreBeginTxHook = fn
}
