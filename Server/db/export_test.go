package db

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// SetEventPruneStatementHookForTest installs (or, with nil, clears) the hook
// PruneEventsOlderThan calls once per DELETE statement it issues. Exported for
// db_test's batching test, which counts statements to prove a large backlog is
// deleted in chunks rather than one unbounded DELETE; production code never
// calls this.
func SetEventPruneStatementHookForTest(fn func()) {
	eventPruneStatementHookForTest = fn
}

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

// SetErasureChunkHookForTest installs (or, with nil, clears) the seam
// EraseAccountLock, Drain and Finish call after each committed transaction
// (stage "lock", "chunk" with a 1-based count, "finish", "checkpoint"); a
// non-nil error aborts the erasure there, and the hook may block to hold it
// between two stages. Exported for db_test; production code never calls this.
func SetErasureChunkHookForTest(d *DB, fn func(stage string, n int) error) {
	d.testErasureChunkHook = fn
}

// SetErasureChunkSizesForTest overrides the drain's row chunk and key-window
// sizes and returns a function that restores them. Exported for db_test.
func SetErasureChunkSizesForTest(chunk, window int) (restore func()) {
	prevChunk, prevWindow := erasureChunk, erasureScanWindow
	erasureChunk, erasureScanWindow = chunk, window
	return func() { erasureChunk, erasureScanWindow = prevChunk, prevWindow }
}

// TakeRestoreResult reads and then clears the staged-restore result, for tests
// that have nothing to do between the two.
func TakeRestoreResult(dbPath string) (res RestoreResult, found bool, err error) {
	res, found, err = ReadRestoreResult(dbPath)
	_ = ClearRestoreResult(dbPath)
	return res, found, err
}

// SetNicknamePreCheckHookForTest installs (or, with nil, clears) the barrier
// SetDisplayNameAsModerator runs inside its transaction before it re-reads the
// actor's authority. Exported for db_test; production code never calls this.
func SetNicknamePreCheckHookForTest(fn func()) {
	nicknamePreCheckHook = fn
}

// ManageNicknamesOrAdminForTest exposes the literal SetDisplayNameAsModerator
// masks role permissions with, so db_test can pin it to the permissions package.
const ManageNicknamesOrAdminForTest = manageNicknamesOrAdmin

// ChannelUnreadCountsSQLForTest is the unread-counts query, so db_test can
// check its query plan.
const ChannelUnreadCountsSQLForTest = channelUnreadCountsSQL

// ReadStmtCountForTest reports how many statements the read cache holds.
func ReadStmtCountForTest(d *DB) int {
	d.readStmts.mu.Lock()
	defer d.readStmts.mu.Unlock()
	return len(d.readStmts.stmts)
}
