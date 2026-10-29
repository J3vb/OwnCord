package db

import (
	"context"
	"database/sql"
	"fmt"
)

// The erasure transaction's "an erased user acted here" unlink steps, split
// out of erasure.go to keep that file under its size ceiling.

// erasureUnlinkPrincipalRows runs every "an erased user acted here" unlink in
// one call — audit_log, reports, and moderation_actions — so eraseAccountTx
// carries one branch for the group instead of one per table (kept under the
// cyclop budget; the three are independent and each already reports its own
// wrapped error).
func erasureUnlinkPrincipalRows(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	if err := erasureUnlinkAudit(ctx, tx, userID, subjectToken); err != nil {
		return err
	}
	if err := erasureUnlinkReports(ctx, tx, userID, subjectToken); err != nil {
		return err
	}
	if err := erasureUnlinkModerationActions(ctx, tx, userID, subjectToken); err != nil {
		return err
	}
	return erasureUnlinkAppeals(ctx, tx, userID, subjectToken)
}

// erasureUnlinkAudit is the unlinkable integrity history:
// every audit row the subject appears in — as actor, or as a user target —
// keeps its action, time and position but loses the id and its free-text
// detail, and carries the deletion marker's token instead (NULL when the
// erasure ran without a marker store): in actor_token where the subject
// acted, in subject_token where they were the target, so a row naming two
// erased subjects keeps both (migration 041). "An erasure happened, by this
// actor class, at this time" survives; "of whom" needs the erasure key.
func erasureUnlinkAudit(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE audit_log SET actor_id = 0, detail = '', actor_token = ? WHERE actor_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink audit actor: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE audit_log SET target_id = 0, detail = '', subject_token = ? WHERE target_type = 'user' AND target_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink audit target: %w", err)
	}
	return nil
}

// erasureUnlinkReports is the reports' half of erasure: a report names two principals — the reporter and the subject —
// each with its own bare-id-plus-token column, the same two-token shape
// erasureUnlinkAudit applies to audit_log (migrations 038/041), for the same
// reason: one erased principal must not overwrite the other's token.
//
// On the SUBJECT's erasure: every evidence row of every report about them,
// and every evidence row they authored as context in someone else's report,
// is hard-deleted — this is the half that keeps the erasure exit condition
// true, a restored backup cannot resurrect the content. The reports row
// itself SURVIVES, rewritten to id 0 plus the token, detail and target_ref
// cleared, and — if still open — closed as subject_erased: an unlinkable
// outcome row, action/time/order and the token, nothing else of the
// subject's (S5-d). Correction: "no identity" means no identity of the erased
// SUBJECT; reporter_id and assignee_id stay, each unlinked by its own
// principal's erasure, and channel_id stays as a plain reference (a channel has
// no erasure right) (TestReport_SubjectErasureKeepsExactlyTheOutcomeColumns). An
// implementation that deletes the row instead of rewriting it passes a test
// that only checks the content is gone and fails the negative control that
// checks the row (and its state) survives — this is the abuse path decision
// 7 was strengthened to close: report someone, they erase, no trace the
// report ever existed.
//
// On the REPORTER's erasure: only reporter_id/reporter_token change. The
// report and its outcome are not the reporter's content and must not be
// touched otherwise (TestReport_ReporterErasureKeepsTheReport).
//
// Notes and evidence authored by an erased MODERATOR, and assignments to
// them, are unlinked the same way everywhere else in this file unlinks an
// actor: id to 0, token filled.
func erasureUnlinkReports(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	// 22c: evidence authored by the subject anywhere (their own reports' seq
	// 0, or context rows in someone else's report) is content and is
	// hard-deleted, not unlinked.
	if _, err := tx.ExecContext(ctx, `DELETE FROM report_evidence WHERE author_id = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report evidence authored: %w", err)
	}
	// 22a: every evidence row of a report ABOUT the subject is content too.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM report_evidence WHERE report_id IN (SELECT id FROM reports WHERE subject_id = ?)`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report evidence about subject: %w", err)
	}
	// The surviving outcome row must carry no content
	// of any kind, and internal notes about the subject are content the
	// subject never even saw — they do not get to keep the moderator's own
	// account of them either.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM report_notes WHERE report_id IN (SELECT id FROM reports WHERE subject_id = ?)`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report notes about subject: %w", err)
	}
	// 22a: the reports row about the subject survives, rewritten.
	if _, err := tx.ExecContext(ctx,
		`UPDATE reports
		    SET subject_id = 0,
		        subject_token = ?,
		        detail = '',
		        target_ref = '',
		        state = CASE WHEN closed_at IS NULL THEN 'subject_erased' ELSE state END,
		        outcome = CASE WHEN closed_at IS NULL THEN 'subject_erased' ELSE outcome END,
		        closed_at = COALESCE(closed_at, datetime('now')),
		        updated_at = datetime('now')
		  WHERE subject_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report subject: %w", err)
	}
	// 22b: the reporter's own reports are not their content, EXCEPT the
	// free-text detail they personally wrote — that is the reporter's
	// content just as much as the evidence snapshot is the subject's, so it
	// is cleared alongside the principal columns.
	// The report and its outcome (state/outcome/closed_at) are untouched.
	if _, err := tx.ExecContext(ctx,
		`UPDATE reports SET reporter_id = 0, reporter_token = ?, detail = '' WHERE reporter_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report reporter: %w", err)
	}
	// 22d: notes authored by an erased moderator.
	if _, err := tx.ExecContext(ctx,
		`UPDATE report_notes SET author_id = 0, author_token = ? WHERE author_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report notes: %w", err)
	}
	// 22e: assignments to an erased moderator.
	if _, err := tx.ExecContext(ctx,
		`UPDATE reports SET assignee_id = 0 WHERE assignee_id = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report assignment: %w", err)
	}
	// 22f: report_events is metadata, not content — an
	// action word, a time, an actor link — so unlinking the actor is the
	// whole job, the same shape audit_log gets, and there is no row to
	// delete or rewrite otherwise.
	if _, err := tx.ExecContext(ctx,
		`UPDATE report_events SET actor_id = 0, actor_token = ? WHERE actor_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report events: %w", err)
	}
	return nil
}

// erasureUnlinkModerationActions is the moderation actions' half of erasure, beside
// erasureUnlinkReports: the SUBJECT's own rows cascade with the users DELETE
// below (moderation_actions.target_id is ON DELETE CASCADE — S6 says a
// warning or timeout row is deleted, not kept, unlike a report's outcome),
// so there is nothing for this function to do on that side. What it unlinks
// is the erased user acting as a MODERATOR elsewhere: actor_id/actor_token
// (the bare-id-plus-token pattern erasureUnlinkAudit and erasureUnlinkReports
// both use) and lifted_by (a bare id with no token column, mirroring
// reports.assignee_id — inventory classes 23a and 23b, SubjectInventory).
func erasureUnlinkModerationActions(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	// 23b: actions taken BY the subject as a moderator.
	if _, err := tx.ExecContext(ctx,
		`UPDATE moderation_actions SET actor_id = 0, actor_token = ? WHERE actor_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink moderation action actor: %w", err)
	}
	// A timeout lifted by the erased moderator.
	if _, err := tx.ExecContext(ctx,
		`UPDATE moderation_actions SET lifted_by = 0 WHERE lifted_by = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink moderation action lifter: %w", err)
	}
	return nil
}

// erasureUnlinkAppeals is the appeals' half of erasure, beside
// erasureUnlinkModerationActions: the APPELLANT's own appeal rows cascade
// with the users DELETE below (appeals.appellant_id is ON DELETE CASCADE —
// S6-d says an appeal is deleted for the appellant, not kept, unlike a
// report's outcome row: the UNIQUE(action_id) memory that forbids re-appeal
// survives with the row gone, because the action itself still exists and a
// fresh appeal against it would need a fresh appellant who no longer
// exists either), so there is nothing for this function to do on that side.
// What it unlinks is the erased user acting as a MODERATOR elsewhere:
// decided_by/decided_by_token (the bare-id-plus-token pattern every other
// unlinker in this file uses) and assignee_id (a bare id with no token
// column, mirroring reports.assignee_id and moderation_actions.lifted_by —
// inventory class 24b, SubjectInventory).
func erasureUnlinkAppeals(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE appeals SET decided_by = 0, decided_by_token = ? WHERE decided_by = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink appeal decider: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE appeals SET assignee_id = 0 WHERE assignee_id = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink appeal assignment: %w", err)
	}
	return nil
}
