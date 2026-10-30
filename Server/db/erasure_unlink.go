package db

import (
	"context"
	"database/sql"
	"fmt"
)

// The erasure transaction's "an erased user acted here" unlink steps, split out
// of erasure.go to keep that file under its size ceiling.

// erasureUnlinkPrincipalRows runs every "an erased user acted here" unlink
// (audit_log, reports, moderation_actions) in one call, so eraseAccountTx
// carries one branch for the group (cyclop budget). The three are independent
// and each reports its own wrapped error.
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

// erasureUnlinkAudit unlinks the integrity history: every audit row the
// subject appears in, as actor or user target, keeps its action, time and
// position but loses the id and free-text detail, and carries the deletion
// marker's token (NULL without a marker store) in actor_token where the subject
// acted or subject_token where they were the target, so a row naming two erased
// subjects keeps both. "An erasure happened, by this actor class, at this
// time" survives; "of whom" needs the erasure key.
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

// erasureUnlinkReports is the reports' half of erasure. A report names two
// principals (reporter and subject), each with a bare-id-plus-token column as
// in audit_log, so one erased principal must not overwrite the other's token.
//
// On the subject's erasure, every evidence row of every report about them, and
// every evidence row they authored as context in someone else's report, is
// hard-deleted so a restored backup cannot resurrect the content. The reports
// row itself survives, rewritten to id 0 plus the token with detail and
// target_ref cleared and, if still open, closed as subject_erased: an
// unlinkable outcome row of action, time, order and token. "No identity" means
// none of the erased subject; reporter_id and assignee_id stay, each unlinked
// by its own principal's erasure, and channel_id stays as a plain reference
// (TestReport_SubjectErasureKeepsExactlyTheOutcomeColumns). Deleting the row
// instead would pass a test that only checks the content is gone, and would
// let someone report a person, have them erase, and leave no trace the report
// existed.
//
// On the reporter's erasure only reporter_id/reporter_token change; the report
// and outcome are not the reporter's content
// (TestReport_ReporterErasureKeepsTheReport).
//
// Notes and evidence authored by an erased moderator, and assignments to them,
// are unlinked as an actor: id to 0, token filled.
func erasureUnlinkReports(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	// 22c: evidence authored by the subject anywhere (their own reports' seq 0, or
	// context rows in another's report) is content and is hard-deleted.
	if _, err := tx.ExecContext(ctx, `DELETE FROM report_evidence WHERE author_id = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report evidence authored: %w", err)
	}
	// 22a: every evidence row of a report about the subject is content too.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM report_evidence WHERE report_id IN (SELECT id FROM reports WHERE subject_id = ?)`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report evidence about subject: %w", err)
	}
	// The surviving outcome row must carry no content, and internal notes about
	// the subject are content the subject never saw, so they go too.
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
	// 22b: the reporter's own reports are not their content except the free-text
	// detail they wrote, which is cleared with the principal columns. The report
	// and its outcome (state/outcome/closed_at) are untouched.
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
	// 22f: report_events is metadata (action word, time, actor link), so
	// unlinking the actor is the whole job, as for audit_log.
	if _, err := tx.ExecContext(ctx,
		`UPDATE report_events SET actor_id = 0, actor_token = ? WHERE actor_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report events: %w", err)
	}
	return nil
}

// erasureUnlinkModerationActions is the moderation actions' half of erasure.
// The subject's own rows cascade with the users DELETE
// (moderation_actions.target_id is ON DELETE CASCADE; a warning or timeout row
// is deleted, unlike a report's outcome). It unlinks the erased user acting as
// a moderator elsewhere: actor_id/actor_token (the bare-id-plus-token pattern)
// and lifted_by (a bare id with no token column, like reports.assignee_id),
// inventory classes 23a and 23b.
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

// erasureUnlinkAppeals is the appeals' half of erasure. The appellant's own
// rows cascade with the users DELETE (appeals.appellant_id is ON DELETE
// CASCADE; the UNIQUE(action_id) memory forbidding re-appeal survives with the
// row gone, since no fresh appellant could exist either). It unlinks the erased
// user acting as a moderator elsewhere: decided_by/decided_by_token (the
// bare-id-plus-token pattern) and assignee_id (a bare id with no token column),
// inventory class 24b.
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
