package db

import (
	"context"
	"database/sql"
	"fmt"
)

// The erasure transaction's "an erased user acted here" unlink steps, split out of erasure.go.

// erasureUnlinkPrincipalRows runs the audit_log, reports and moderation_actions
// unlinks in one call; each is independent and reports its own wrapped error.
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

// erasureUnlinkAudit unlinks the integrity history: every audit row naming the
// subject as actor or user target keeps action, time and position but loses
// the id and free-text detail, and carries the deletion marker's token (NULL
// without a marker store) in actor_token or subject_token, so a row naming two
// erased subjects keeps both. "Of whom" needs the erasure key.
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

// erasureUnlinkReports is the reports' half of erasure. A report names two principals,
// each with a bare-id-plus-token column, so one erased principal must not overwrite
// the other's token.
// On the subject's erasure every evidence row of every report about them, and every
// evidence row they authored in another's report, is hard-deleted so a restored backup
// cannot resurrect it. The reports row survives, rewritten to id 0 plus the token with
// detail and target_ref cleared and, if open, closed as subject_erased: deleting it
// would leave no trace that a person was reported and erased. reporter_id and
// assignee_id stay (each unlinked by its own principal's erasure); channel_id stays a
// plain reference.
// On the reporter's erasure only reporter_id/reporter_token change. Notes, evidence
// and assignments by or to an erased moderator are unlinked as an actor: id 0, token
// filled.
func erasureUnlinkReports(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM report_evidence WHERE author_id = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report evidence authored: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM report_evidence WHERE report_id IN (SELECT id FROM reports WHERE subject_id = ?)`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report evidence about subject: %w", err)
	}
	// The surviving outcome row must carry no content, and internal notes about the subject go too.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM report_notes WHERE report_id IN (SELECT id FROM reports WHERE subject_id = ?)`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report notes about subject: %w", err)
	}
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
	// 22b: the reporter's free-text detail is cleared with the principal
	// columns; the report and its outcome are untouched.
	if _, err := tx.ExecContext(ctx,
		`UPDATE reports SET reporter_id = 0, reporter_token = ?, detail = '' WHERE reporter_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report reporter: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE report_notes SET author_id = 0, author_token = ? WHERE author_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report notes: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE reports SET assignee_id = 0 WHERE assignee_id = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report assignment: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE report_events SET actor_id = 0, actor_token = ? WHERE actor_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink report events: %w", err)
	}
	return nil
}

// erasureUnlinkModerationActions is the moderation actions' half of erasure. The
// subject's own rows cascade with the users DELETE; it unlinks the erased user acting
// as a moderator elsewhere: actor_id/actor_token and lifted_by (inventory classes 23a,
// 23b).
func erasureUnlinkModerationActions(ctx context.Context, tx *sql.Tx, userID int64, subjectToken string) error {
	var token any
	if subjectToken != "" {
		token = subjectToken
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE moderation_actions SET actor_id = 0, actor_token = ? WHERE actor_id = ?`, token, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink moderation action actor: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE moderation_actions SET lifted_by = 0 WHERE lifted_by = ?`, userID); err != nil {
		return fmt.Errorf("EraseAccount unlink moderation action lifter: %w", err)
	}
	return nil
}

// erasureUnlinkAppeals is the appeals' half of erasure. The appellant's own rows
// cascade with the users DELETE (the UNIQUE(action_id) bar on re-appeal survives). It
// unlinks the erased user as a moderator elsewhere: decided_by/decided_by_token and
// assignee_id, class 24b.
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
