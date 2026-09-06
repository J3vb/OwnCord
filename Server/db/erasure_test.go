package db_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// eraseSubject is a member with a row in every class the erasure touches
// that a unit test can seed directly.
type eraseSubject struct {
	id, other, channel int64
	username           string
}

func seedEraseSubject(t *testing.T, database *db.DB) eraseSubject {
	t.Helper()
	ctx := context.Background()
	other := seedUser(t, database, "other-user")
	setRole(t, database, other, 2)
	third := seedUser(t, database, "third-user")
	uid := seedUser(t, database, "Subject_User")
	chID := seedChannel(t, database, "general-erase")
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	msg, err := database.CreateMessageWithMentions(ctx, chID, uid, "hello @other-user needleword", nil, []int64{other}, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	otherMsg, err := database.CreateMessageWithMentions(ctx, chID, other, "hi @Subject_User", nil, []int64{uid}, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions(other): %v", err)
	}
	dm, _, err := database.GetOrCreateDMChannel(ctx, uid, other)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	exec(`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`, uid, dm.ID)
	exec(`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`, other, dm.ID)
	exec(`INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'tok-subject', datetime('now', '+1 day'))`, uid)
	exec(`INSERT INTO api_tokens (user_id, token_hash, label) VALUES (?, 'hash-subject', 'ci')`, uid)
	exec(`UPDATE users SET totp_secret = 'SECRET', avatar = '/api/v1/files/avatar-subject' WHERE id = ?`, uid)
	exec(`INSERT INTO totp_recovery_codes (user_id, code_hash, created_at) VALUES (?, 'h', datetime('now'))`, uid)
	exec(`INSERT INTO totp_used_codes (user_id, code_hash, expires_at) VALUES (?, 'h', datetime('now', '+1 minute'))`, uid)
	exec(`INSERT INTO recovery_kits (user_id, verifier, created_at) VALUES (?, 'v', datetime('now'))`, uid)
	exec(`INSERT INTO recovery_assists (user_id, verifier, issued_by, verification, created_at, expires_at) VALUES (?, 'v', ?, 'voice_call', datetime('now'), datetime('now', '+15 minutes'))`, other, uid)
	exec(`INSERT INTO rate_lockouts (key, expires_at) VALUES ('delete_lock:' || ?, datetime('now', '+15 minutes'))`, uid)
	exec(`INSERT INTO rate_lockouts (key, expires_at) VALUES ('login_user_lock:subject_user', datetime('now', '+15 minutes'))`)
	exec(`INSERT INTO rate_lockouts (key, expires_at) VALUES ('login_user_lock:other-user', datetime('now', '+15 minutes'))`)
	exec(`INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, 'x')`, otherMsg.ID, uid)
	exec(`INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, 'y')`, msg.ID, other)
	exec(`INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES (?, ?, 0)`, uid, chID)
	exec(`INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id) VALUES ('att-1', ?, 'a.png', 'stored-a.png', 'image/png', 1, ?)`, msg.ID, uid)
	exec(`INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id) VALUES ('avatar-subject', 'me.png', 'stored-avatar.png', 'image/png', 1, ?)`, uid)
	exec(`INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id) VALUES ('att-other', ?, 'o.png', 'stored-other.png', 'image/png', 1, ?)`, otherMsg.ID, other)
	exec(`INSERT INTO user_storage (user_id, bytes_used) VALUES (?, 2)`, uid)
	exec(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_key_id) VALUES (?, 'https://push.example/subject', 'p', 'a', 'key1')`, uid)
	exec(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_key_id) VALUES (?, 'https://push.example/other', 'p', 'a', 'key1')`, other)
	exec(`INSERT INTO invites (code, created_by) VALUES ('subject-invite', ?)`, uid)
	exec(`INSERT INTO invites (code, created_by, redeemed_by) VALUES ('other-invite', ?, ?)`, other, uid)
	exec(`INSERT INTO emoji (shortcode, filename, uploaded_by) VALUES ('wave', 'emoji-wave', ?)`, uid)
	exec(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)`, uid, other)
	exec(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)`, other, uid)
	exec(`INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, 1, 0)`, chID, uid)
	exec(`INSERT INTO voice_states (user_id, channel_id, joined_at) VALUES (?, ?, datetime('now'))`, uid, chID)
	exec(`INSERT INTO channel_retention (channel_id, days, updated_by) VALUES (?, 30, ?)`, chID, uid)
	// Message requests and trusted senders (migration 046, B5-6, classes 14c
	// and 14d): one row of each naming the subject, plus one of each between
	// two OTHER users that must survive the subject's erasure untouched.
	exec(`INSERT INTO message_requests (sender_id, recipient_id, channel_id, state) VALUES (?, ?, ?, 'pending')`, uid, other, chID)
	exec(`INSERT INTO trusted_senders (recipient_id, sender_id, source) VALUES (?, ?, 'sent_first')`, other, uid)
	exec(`INSERT INTO message_requests (sender_id, recipient_id, channel_id, state) VALUES (?, ?, ?, 'pending')`, other, third, chID)
	exec(`INSERT INTO trusted_senders (recipient_id, sender_id, source) VALUES (?, ?, 'sent_first')`, third, other)
	// NSFW acknowledgements (migration 047, B5-7, class 18a): one row naming
	// the subject, plus one for another user on the same channel that must
	// survive the subject's erasure untouched.
	exec(`INSERT INTO nsfw_acknowledgements (user_id, channel_id) VALUES (?, ?)`, uid, chID)
	exec(`INSERT INTO nsfw_acknowledgements (user_id, channel_id) VALUES (?, ?)`, other, chID)
	// The wire envelope shape (ws.wrapWithSeq): the ids live under payload.
	exec(`INSERT INTO events (seq, event_type, payload, channel_id) VALUES (1, 'typing', ?, ?)`, fmt.Sprintf(`{"seq":1,"type":"typing","payload":{"user_id":%d}}`, uid), chID)
	exec(`INSERT INTO events (seq, event_type, payload, channel_id) VALUES (2, 'chat_message', ?, ?)`, fmt.Sprintf(`{"seq":2,"type":"chat_message","payload":{"user":{"id":%d}}}`, uid), chID)
	exec(`INSERT INTO events (seq, event_type, payload, channel_id) VALUES (3, 'typing', ?, ?)`, fmt.Sprintf(`{"seq":3,"type":"typing","payload":{"user_id":%d}}`, other), chID)
	// B5-8 report classes (migration 048): a report about the subject by
	// another user (22a), a report by the subject about another user (22b),
	// evidence and a note authored by the subject (22c/22d), and an
	// assignment to the subject (22e) — plus a report between two OTHER
	// users that must survive untouched.
	exec(`INSERT INTO reports (id, public_id, reporter_id, subject_id, target_type, target_ref, reason, detail) VALUES (900, 'pub-900', ?, ?, 'user', 'ref-about-subject', 'harassment', 'd')`, other, uid)
	exec(`INSERT INTO reports (id, public_id, reporter_id, subject_id, target_type, target_ref, reason, detail, assignee_id) VALUES (901, 'pub-901', ?, ?, 'message', 'ref-by-subject', 'spam', 'd', ?)`, uid, other, uid)
	exec(`INSERT INTO report_evidence (report_id, seq, author_id, content) VALUES (901, 0, ?, 'evidence text by subject')`, uid)
	exec(`INSERT INTO report_notes (report_id, author_id, body) VALUES (901, ?, 'note by subject')`, uid)
	// P2-10 (Codex review): a report ABOUT the subject with evidence
	// authored by someone ELSE -- the case seedEraseSubject was missing.
	// Without this row, the "DELETE FROM report_evidence WHERE report_id IN
	// (SELECT id FROM reports WHERE subject_id = ?)" branch could be deleted
	// entirely and every existing assertion would still pass, because
	// report 901's evidence (author_id = uid) is already caught by the
	// sibling "OR author_id = ?" branch.
	exec(`INSERT INTO report_evidence (report_id, seq, author_id, content) VALUES (900, 0, ?, 'context by another author about the subject')`, other)
	// 22f (second Codex review): a report_events row where the subject was
	// the ACTOR (they moderated report 900 at some point before erasure).
	exec(`INSERT INTO report_events (report_id, actor_id, action, detail) VALUES (900, ?, 'noted', '')`, uid)
	return eraseSubject{id: uid, other: other, channel: chID, username: "Subject_User"}
}

func TestEraseAccount_EveryInventoryClassIsZero(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	// A report between two OTHER users, naming neither the subject nor
	// carrying anything of theirs: it must be untouched by the subject's
	// erasure.
	witness := seedUser(t, database, "witness-user")
	if _, err := database.ExecContext(ctx,
		`INSERT INTO reports (id, public_id, reporter_id, subject_id, target_type, target_ref, reason, detail) VALUES (902, 'pub-902', ?, ?, 'user', 'ref-unrelated', 'other', 'untouched detail')`,
		witness, sub.other); err != nil {
		t.Fatalf("seed unrelated report: %v", err)
	}
	// P2-10 positive control: this report's evidence belongs to neither the
	// subject nor a report about them, and must survive untouched.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO report_evidence (report_id, seq, author_id, content) VALUES (902, 0, ?, 'unrelated context')`,
		witness); err != nil {
		t.Fatalf("seed unrelated evidence: %v", err)
	}
	before, err := database.TakeInventory(ctx, sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	for _, c := range db.SubjectInventory {
		if c.Key == "7 login attempts" || c.Key == "21 audit rows" {
			continue
		}
		if before[c.Key] == 0 {
			t.Errorf("fixture holds nothing in class %q; the checklist would prove nothing there", c.Key)
		}
	}

	job, err := database.EraseAccount(ctx, sub.id, "")
	if err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	after, err := database.TakeInventory(ctx, sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	for _, c := range db.SubjectInventory {
		if after[c.Key] != 0 {
			t.Errorf("%s after erasure = %d, want 0", c.Key, after[c.Key])
		}
	}
	wantFiles := map[string]bool{"stored-a.png": true, "stored-avatar.png": true}
	if len(job.Files) != len(wantFiles) {
		t.Errorf("job files = %v, want the subject's two", job.Files)
	}
	for _, f := range job.Files {
		if !wantFiles[f] {
			t.Errorf("job lists %q, which is not the subject's", f)
		}
	}

	// What must survive: the other user's message, reaction, attachment,
	// lockout key and event; the redeemed invite with its link cleared; the
	// assets, now the admin's; the assisted credential, issuer unlinked.
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := database.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	if n := count(`SELECT COUNT(*) FROM messages WHERE user_id = ?`, sub.other); n != 1 {
		t.Errorf("other user's messages = %d, want 1", n)
	}
	if n := count(`SELECT COUNT(*) FROM attachments WHERE id = 'att-other' AND message_id IS NOT NULL`); n != 1 {
		t.Errorf("other user's attachment rows = %d, want 1 still linked", n)
	}
	if n := count(`SELECT COUNT(*) FROM rate_lockouts`); n != 1 {
		t.Errorf("lockout keys left = %d, want 1 (the other user's)", n)
	}
	if n := count(`SELECT COUNT(*) FROM events`); n != 1 {
		t.Errorf("events left = %d, want 1 (the other user's)", n)
	}
	if n := count(`SELECT COUNT(*) FROM invites WHERE code = 'other-invite' AND redeemed_by IS NULL`); n != 1 {
		t.Errorf("redeemed invite: want the row kept with redeemed_by cleared")
	}
	if n := count(`SELECT COUNT(*) FROM invites WHERE code = 'subject-invite'`); n != 0 {
		t.Errorf("the subject's invite survived")
	}
	if n := count(`SELECT COUNT(*) FROM emoji WHERE shortcode = 'wave' AND uploaded_by = ?`, sub.other); n != 1 {
		t.Errorf("emoji not reassigned to the remaining admin")
	}
	if n := count(`SELECT COUNT(*) FROM recovery_assists WHERE user_id = ? AND issued_by = 0`, sub.other); n != 1 {
		t.Errorf("assisted credential issued by the subject: want kept with issued_by = 0")
	}
	if n := count(`SELECT COUNT(*) FROM channel_retention WHERE channel_id = ? AND days = 30 AND updated_by = 0`, sub.channel); n != 1 {
		t.Errorf("channel retention policy set by the subject: want kept in effect with updated_by = 0")
	}
	if n := count(`SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'needleword'`); n != 0 {
		t.Errorf("FTS still finds the subject's text")
	}
	// The other user's reaction on the subject's message cascaded with it.
	if n := count(`SELECT COUNT(*) FROM reactions`); n != 0 {
		t.Errorf("reactions left = %d, want 0", n)
	}

	// B5-8, decision 7: the report ABOUT the subject survives as an
	// unlinkable outcome row — the negative control. An implementation that
	// deletes the row instead of rewriting it passes every check above (the
	// generic inventory class is zero either way) and fails this one.
	var state, outcome, detail, targetRef, closedAt string
	var subjectID int64
	var subjectToken sql.NullString
	if err := database.QueryRowContext(ctx,
		`SELECT subject_id, subject_token, detail, target_ref, state, outcome, closed_at FROM reports WHERE id = 900`,
	).Scan(&subjectID, &subjectToken, &detail, &targetRef, &state, &outcome, &closedAt); err != nil {
		t.Fatalf("report 900 after erasure: %v", err)
	}
	if subjectID != 0 || detail != "" || targetRef != "" || state != "subject_erased" || outcome != "subject_erased" || closedAt == "" {
		t.Errorf("report 900 after subject erasure = subject_id=%d detail=%q target_ref=%q state=%q outcome=%q closed_at=%q, want id 0, empty detail/target_ref, subject_erased/subject_erased, closed_at set",
			subjectID, detail, targetRef, state, outcome, closedAt)
	}
	_ = subjectToken // this test erases with an empty token; the dedicated
	// token tests below (TestReport_SubjectErasureKeepsTheOutcomeRow etc.)
	// assert the token itself is carried when one is given.
	if n := count(`SELECT COUNT(*) FROM reports WHERE id = 900`); n != 1 {
		t.Errorf("report 900 row count after erasure = %d, want 1 (kept, not deleted)", n)
	}
	if n := count(`SELECT COUNT(*) FROM report_evidence WHERE report_id IN (900, 901)`); n != 0 {
		t.Errorf("report evidence after erasure = %d, want 0 (content hard-deleted)", n)
	}
	// P2-10: the positive control. Evidence on an unrelated report (902,
	// authored by a third party, about neither the subject nor a report of
	// theirs) must survive untouched — proving the DELETE above is scoped
	// to "about the subject", not every report_evidence row.
	if n := count(`SELECT COUNT(*) FROM report_evidence WHERE report_id = 902`); n != 1 {
		t.Errorf("unrelated report 902's evidence after erasure = %d, want 1 (untouched)", n)
	}

	// The report BY the subject (901) is not the subject's content: only the
	// reporter columns change, the report and its outcome stay as they are.
	var reporterID int64
	var reporterToken sql.NullString
	var assigneeID int64
	if err := database.QueryRowContext(ctx,
		`SELECT reporter_id, reporter_token, assignee_id FROM reports WHERE id = 901`,
	).Scan(&reporterID, &reporterToken, &assigneeID); err != nil {
		t.Fatalf("report 901 after erasure: %v", err)
	}
	_ = reporterToken
	if reporterID != 0 {
		t.Errorf("report 901 reporter after subject erasure = id=%d, want 0", reporterID)
	}
	if assigneeID != 0 {
		t.Errorf("report 901 assignee after subject erasure = %d, want 0 (unlinked)", assigneeID)
	}
	if n := count(`SELECT COUNT(*) FROM report_notes WHERE report_id = 901 AND author_id = 0`); n != 1 {
		t.Errorf("report 901 note after subject erasure: want 1 row with author_id 0")
	}

	// The unrelated report between two other users is untouched.
	var untouchedReporter, untouchedSubject int64
	var untouchedDetail string
	if err := database.QueryRowContext(ctx,
		`SELECT reporter_id, subject_id, detail FROM reports WHERE id = 902`,
	).Scan(&untouchedReporter, &untouchedSubject, &untouchedDetail); err != nil {
		t.Fatalf("report 902 after erasure: %v", err)
	}
	if untouchedReporter != witness || untouchedSubject != sub.other || untouchedDetail != "untouched detail" {
		t.Errorf("unrelated report 902 changed by the subject's erasure: reporter=%d subject=%d detail=%q",
			untouchedReporter, untouchedSubject, untouchedDetail)
	}
	if n := count(`SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?`, sub.other); n != 1 {
		t.Errorf("other user's push subscription left = %d, want 1", n)
	}
	if n := count(`SELECT COUNT(*) FROM message_requests`); n != 1 {
		t.Errorf("message requests left = %d, want 1 (the one between two other users)", n)
	}
	if n := count(`SELECT COUNT(*) FROM trusted_senders`); n != 1 {
		t.Errorf("trusted senders left = %d, want 1 (the one between two other users)", n)
	}
	if n := count(`SELECT COUNT(*) FROM nsfw_acknowledgements`); n != 1 {
		t.Errorf("nsfw acknowledgements left = %d, want 1 (the other user's)", n)
	}
}

// TestReport_SubjectErasureKeepsTheOutcomeRow is the negative control by
// itself, isolated from the rest of the inventory fixture: erase a user who
// is ONLY a report subject, and the report row must still exist, closed as
// subject_erased, with no content and no id naming them. An implementation
// that deletes the reports row on erasure — which would make every OTHER
// assertion in this file pass — fails exactly this one.
func TestReport_SubjectErasureKeepsTheOutcomeRow(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "reporter-only")
	subject := seedUser(t, database, "subject-only")
	moderator := seedUser(t, database, "mod-for-950")
	if _, err := database.ExecContext(ctx,
		`INSERT INTO reports (id, public_id, reporter_id, subject_id, target_type, target_ref, reason, detail) VALUES (950, 'pub-950', ?, ?, 'user', 'ref', 'spam', 'the detail')`,
		reporter, subject); err != nil {
		t.Fatalf("seed report: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO report_notes (report_id, author_id, body) VALUES (950, ?, 'a note about the subject')`, moderator); err != nil {
		t.Fatalf("seed note: %v", err)
	}
	if _, err := database.EraseAccount(ctx, subject, "marker-tok-subject"); err != nil {
		t.Fatalf("EraseAccount(subject): %v", err)
	}
	// HP-5 review widening: the surviving row carries no content of any
	// kind, including a note about the subject the subject never even saw.
	var notesLeft int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM report_notes WHERE report_id = 950`).Scan(&notesLeft); err != nil {
		t.Fatalf("count report_notes: %v", err)
	}
	if notesLeft != 0 {
		t.Errorf("report_notes about the erased subject = %d, want 0", notesLeft)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM reports WHERE subject_token = ?`, "marker-tok-subject").Scan(&n); err != nil {
		t.Fatalf("count by subject_token: %v", err)
	}
	if n != 1 {
		t.Fatalf("reports with subject_token = %d, want 1 -- the negative control: an implementation that deletes the row fails this", n)
	}
	var state, outcome, detail, createdAt, closedAt string
	if err := database.QueryRowContext(ctx,
		`SELECT state, outcome, detail, created_at, closed_at FROM reports WHERE subject_token = ?`, "marker-tok-subject",
	).Scan(&state, &outcome, &detail, &createdAt, &closedAt); err != nil {
		t.Fatalf("read survivor row: %v", err)
	}
	if state != "subject_erased" || outcome != "subject_erased" || detail != "" || createdAt == "" || closedAt == "" {
		t.Errorf("survivor row = state=%q outcome=%q detail=%q created_at=%q closed_at=%q, want subject_erased/subject_erased/empty/set/set",
			state, outcome, detail, createdAt, closedAt)
	}
}

// TestReport_ReporterErasureKeepsTheReport pins that erasing the REPORTER
// leaves the report and its outcome exactly as they were: only the reporter
// columns are unlinked. Decision 7 is about the subject's content; the
// reporter's own report is not that content.
func TestReport_ReporterErasureKeepsTheReport(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "reporter-erases")
	subject := seedUser(t, database, "subject-stays")
	if _, err := database.ExecContext(ctx,
		`INSERT INTO reports (id, public_id, reporter_id, subject_id, target_type, target_ref, reason, detail, state, outcome, closed_at) VALUES (960, 'pub-960', ?, ?, 'user', 'ref', 'spam', 'kept detail', 'resolved', 'actioned', datetime('now'))`,
		reporter, subject); err != nil {
		t.Fatalf("seed report: %v", err)
	}
	if _, err := database.EraseAccount(ctx, reporter, "marker-tok-reporter"); err != nil {
		t.Fatalf("EraseAccount(reporter): %v", err)
	}
	var reporterID, subjectID int64
	var reporterToken sql.NullString
	var state, outcome, detail string
	if err := database.QueryRowContext(ctx,
		`SELECT reporter_id, reporter_token, subject_id, state, outcome, detail FROM reports WHERE id = 960`,
	).Scan(&reporterID, &reporterToken, &subjectID, &state, &outcome, &detail); err != nil {
		t.Fatalf("read report 960: %v", err)
	}
	if reporterID != 0 || !reporterToken.Valid || reporterToken.String != "marker-tok-reporter" {
		t.Errorf("reporter columns = id=%d token=%v, want id 0 and the marker token", reporterID, reporterToken)
	}
	if subjectID != subject || state != "resolved" || outcome != "actioned" {
		t.Errorf("report 960 after reporter erasure = subject=%d state=%q outcome=%q, want unchanged",
			subjectID, state, outcome)
	}
	// HP-5 review widening: the reporter's free text is their own content
	// and is cleared, even though the report and its outcome are not theirs.
	if detail != "" {
		t.Errorf("report 960 detail after reporter erasure = %q, want empty (the reporter's free text is their content)", detail)
	}
}

// TestReport_ModeratorErasureUnlinksNotesAndAssignment covers the third
// principal a report can name: a moderator who wrote a note or holds the
// assignment. Their erasure unlinks both, and touches neither the reporter
// nor the subject columns.
func TestReport_ModeratorErasureUnlinksNotesAndAssignment(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reporter := seedUser(t, database, "reporter-mod-case")
	subject := seedUser(t, database, "subject-mod-case")
	moderator := seedUser(t, database, "moderator-erases")
	if _, err := database.ExecContext(ctx,
		`INSERT INTO reports (id, public_id, reporter_id, subject_id, target_type, target_ref, reason, detail, assignee_id) VALUES (970, 'pub-970', ?, ?, 'user', 'ref', 'spam', 'd', ?)`,
		reporter, subject, moderator); err != nil {
		t.Fatalf("seed report: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO report_notes (report_id, author_id, body) VALUES (970, ?, 'note body')`, moderator); err != nil {
		t.Fatalf("seed note: %v", err)
	}
	if _, err := database.EraseAccount(ctx, moderator, "marker-tok-mod"); err != nil {
		t.Fatalf("EraseAccount(moderator): %v", err)
	}
	var assigneeID int64
	if err := database.QueryRowContext(ctx, `SELECT assignee_id FROM reports WHERE id = 970`).Scan(&assigneeID); err != nil {
		t.Fatalf("read assignee: %v", err)
	}
	if assigneeID != 0 {
		t.Errorf("assignee_id after moderator erasure = %d, want 0", assigneeID)
	}
	var authorID int64
	var authorToken sql.NullString
	if err := database.QueryRowContext(ctx, `SELECT author_id, author_token FROM report_notes WHERE report_id = 970`).Scan(&authorID, &authorToken); err != nil {
		t.Fatalf("read note author: %v", err)
	}
	if authorID != 0 || !authorToken.Valid || authorToken.String != "marker-tok-mod" {
		t.Errorf("note author after moderator erasure = id=%d token=%v, want id 0 and the marker token", authorID, authorToken)
	}
	var reporterID, subjectID int64
	if err := database.QueryRowContext(ctx, `SELECT reporter_id, subject_id FROM reports WHERE id = 970`).Scan(&reporterID, &subjectID); err != nil {
		t.Fatalf("read report principals: %v", err)
	}
	if reporterID != reporter || subjectID != subject {
		t.Errorf("reporter/subject changed by an unrelated moderator's erasure: reporter=%d (want %d) subject=%d (want %d)",
			reporterID, reporter, subjectID, subject)
	}
}

func TestEraseAccount_JobIsListedUntilCompleted(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	job, err := database.EraseAccount(ctx, sub.id, "")
	if err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}

	jobs, err := database.ListUnfinishedErasureJobs(ctx)
	if err != nil {
		t.Fatalf("ListUnfinishedErasureJobs: %v", err)
	}
	if len(jobs) != 1 || jobs[0].ID != job.ID || jobs[0].State != db.ErasureStateDBDone || len(jobs[0].Files) != 2 {
		t.Fatalf("unfinished jobs = %+v, want the one just written with 2 files", jobs)
	}

	if err := database.RecordErasureJobAttempt(ctx, job.ID, 1, "remove stored-a.png: EIO"); err != nil {
		t.Fatalf("RecordErasureJobAttempt: %v", err)
	}
	got, err := database.GetErasureJob(ctx, job.ID)
	if err != nil {
		t.Fatalf("GetErasureJob: %v", err)
	}
	if got.Attempts != 1 || got.FilesRemoved != 1 || got.LastError == "" || got.State != db.ErasureStateDBDone {
		t.Errorf("after a failed attempt: %+v", got)
	}

	if err := database.CompleteErasureJob(ctx, job.ID, 2); err != nil {
		t.Fatalf("CompleteErasureJob: %v", err)
	}
	got, err = database.GetErasureJob(ctx, job.ID)
	if err != nil {
		t.Fatalf("GetErasureJob: %v", err)
	}
	if got.State != db.ErasureStateDone || got.FilesRemoved != 2 || got.LastError != "" || got.Attempts != 2 {
		t.Errorf("after completion: %+v", got)
	}
	// Files done, purge still outstanding: listed until it is recorded.
	if jobs, err := database.ListUnfinishedErasureJobs(ctx); err != nil || len(jobs) != 1 {
		t.Errorf("unfinished jobs with the purge outstanding = %v, %v; want the job", jobs, err)
	}
	if err := database.MarkErasureJobReplayPurged(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	jobs, err = database.ListUnfinishedErasureJobs(ctx)
	if err != nil || len(jobs) != 0 {
		t.Errorf("unfinished jobs after completion and purge = %v, %v; want none", jobs, err)
	}
	if _, err := database.GetErasureJob(ctx, job.ID+100); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("GetErasureJob(missing) = %v, want ErrNotFound", err)
	}
}

// A statement failing late in the transaction — the shape a full disk takes
// (data-lifecycle O1 A2) — rolls everything back: the account, its rows and
// its files' journal are exactly as before, and the erasure is retryable.
func TestEraseAccount_FailingStatementRollsBackEverything(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	before, err := database.TakeInventory(ctx, sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`CREATE TRIGGER fault_full BEFORE INSERT ON erasure_jobs BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END`); err != nil {
		t.Fatalf("install fault: %v", err)
	}

	_, err = database.EraseAccount(ctx, sub.id, "")
	if err == nil {
		t.Fatal("EraseAccount succeeded through the fault")
	}
	if errors.Is(err, db.ErrLastAdmin) || errors.Is(err, db.ErrNotFound) {
		t.Fatalf("EraseAccount error = %v, want the store fault", err)
	}

	after, err := database.TakeInventory(ctx, sub.id, sub.username)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	for _, c := range db.SubjectInventory {
		if after[c.Key] != before[c.Key] {
			t.Errorf("%s: %d before, %d after the rolled-back erasure", c.Key, before[c.Key], after[c.Key])
		}
	}
	var jobs int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM erasure_jobs`).Scan(&jobs); err != nil || jobs != 0 {
		t.Errorf("erasure_jobs rows = %d (%v), want 0", jobs, err)
	}
	var secureDelete int
	if err := database.QueryRowContext(ctx, `PRAGMA secure_delete`).Scan(&secureDelete); err != nil || secureDelete != 0 {
		t.Errorf("secure_delete after the failed erasure = %d (%v), want restored to 0", secureDelete, err)
	}

	if _, err := database.ExecContext(ctx, `DROP TRIGGER fault_full`); err != nil {
		t.Fatalf("drop fault: %v", err)
	}
	if _, err := database.EraseAccount(ctx, sub.id, ""); err != nil {
		t.Fatalf("retry after the fault cleared: %v", err)
	}
}

// With nobody left to own them, the sole account's emoji are deleted and
// their files join the job. (The last-admin guard blocks the
// last admin-class account, so the sole survivor here is a Member on a
// server whose admin roles hold nobody — the guard skips that case.)
func TestEraseAccount_SoleAccountAssetsAreDeleted(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "lonely")
	if _, err := database.ExecContext(ctx, `INSERT INTO emoji (shortcode, filename, uploaded_by) VALUES ('solo', 'emoji-solo', ?)`, uid); err != nil {
		t.Fatalf("seed emoji: %v", err)
	}
	job, err := database.EraseAccount(ctx, uid, "")
	if err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	var left int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM emoji`).Scan(&left); err != nil || left != 0 {
		t.Errorf("assets left = %d (%v), want 0", left, err)
	}
	if len(job.Files) != 1 || job.Files[0] != "emoji-solo" {
		t.Errorf("job files = %v, want the emoji file", job.Files)
	}
}

func TestEraseAccount_LockoutSuffixIsExact(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "ab")
	// A key whose value merely ends with the id or the name must survive:
	// user 1 vs "…:11", "ab" vs "…:cab".
	for _, k := range []string{"login_user_lock:cab", fmt.Sprintf("delete_lock:1%d", uid), fmt.Sprintf("delete_lock:%d", uid), "login_user_lock:AB"} {
		if _, err := database.ExecContext(ctx, `INSERT INTO rate_lockouts (key, expires_at) VALUES (?, datetime('now', '+15 minutes'))`, k); err != nil {
			t.Fatalf("seed %s: %v", k, err)
		}
	}
	if _, err := database.EraseAccount(ctx, uid, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	rows, err := database.QueryContext(ctx, `SELECT key FROM rate_lockouts ORDER BY key`)
	if err != nil {
		t.Fatalf("list lockouts: %v", err)
	}
	defer rows.Close()
	var left []string
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		left = append(left, k)
	}
	want := fmt.Sprintf("[delete_lock:1%d login_user_lock:cab]", uid)
	if got := fmt.Sprint(left); got != want {
		t.Errorf("lockout keys left = %s, want %s", got, want)
	}
}

func TestReferencedStoredFiles(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "ref")
	if _, err := database.ExecContext(ctx, `INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id) VALUES ('a', 'a', 'stored-att', 'image/png', 1, ?)`, uid); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO emoji (shortcode, filename, uploaded_by) VALUES ('e', 'stored-emoji', ?)`, uid); err != nil {
		t.Fatalf("seed emoji: %v", err)
	}
	names := make([]string, 0, 453)
	names = append(names, "stored-att", "stored-emoji", "stranded")
	// Past one chunk, so the batching runs more than once.
	for i := range 450 {
		names = append(names, fmt.Sprintf("unknown-%d", i))
	}
	got, err := database.ReferencedStoredFiles(ctx, names)
	if err != nil {
		t.Fatalf("ReferencedStoredFiles: %v", err)
	}
	if len(got) != 2 || !got["stored-att"] || !got["stored-emoji"] {
		t.Errorf("referenced = %v, want the two named by rows", got)
	}
	if empty, err := database.ReferencedStoredFiles(ctx, nil); err != nil || len(empty) != 0 {
		t.Errorf("ReferencedStoredFiles(nil) = %v, %v", empty, err)
	}
}

// The predicate reads the envelope the hub persists — the ids sit under
// payload — in each shape a frame can name a user; a flattened payload,
// which no production path writes, must not match, or the checklist would
// pass on a shape the store never holds.
func TestDeleteEventsForUser_MatchesEveryEnvelopeShape(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	const uid, other = 42, 43
	rows := []struct {
		payload string
		names   bool
	}{
		{fmt.Sprintf(`{"seq":1,"type":"presence","payload":{"user_id":%d,"status":"online"}}`, uid), true},
		{fmt.Sprintf(`{"seq":2,"type":"chat_message","payload":{"id":9,"user":{"id":%d,"username":"x"},"content":"hi","mentions":[]}}`, uid), true},
		{fmt.Sprintf(`{"seq":3,"type":"chat_message","payload":{"id":10,"user":{"id":%d},"content":"@you","mentions":[%d,%d]}}`, other, other, uid), true},
		{fmt.Sprintf(`{"seq":4,"type":"voice_e2ee_offer","payload":{"from_user_id":%d,"encrypted_key":"k"}}`, uid), true},
		{fmt.Sprintf(`{"seq":5,"type":"member_ban","payload":{"user_id":%d}}`, uid), true},
		{fmt.Sprintf(`{"seq":6,"type":"typing","payload":{"user_id":%d}}`, other), false},
		{fmt.Sprintf(`{"seq":7,"type":"chat_message","payload":{"user":{"id":%d},"mentions":[%d]}}`, other, other), false},
		{fmt.Sprintf(`{"seq":8,"type":"typing","user_id":%d}`, uid), false}, // flattened: not a persisted shape
		{`{"seq":9,"type":"roles_update","payload":{"roles":[]}}`, false},
	}
	for i, r := range rows {
		if _, err := database.ExecContext(ctx, `INSERT INTO events (seq, event_type, payload, channel_id) VALUES (?, 'x', ?, 0)`, i+1, r.payload); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	var before int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE `+db.EventNamesUserPredicate, uid).Scan(&before); err != nil {
		t.Fatalf("count: %v", err)
	}
	if before != 5 {
		t.Errorf("predicate matched %d rows, want 5", before)
	}
	n, err := database.DeleteEventsForUser(ctx, uid)
	if err != nil {
		t.Fatalf("DeleteEventsForUser: %v", err)
	}
	if n != 5 {
		t.Errorf("deleted %d rows, want 5", n)
	}
	var left int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM events`).Scan(&left); err != nil || left != 4 {
		t.Errorf("rows left = %d (%v), want the 4 naming nobody or someone else", left, err)
	}
}

// B4-10: the audit rows the subject appears in survive with their action,
// time and order, lose the id and the free text, and carry the marker's
// token — while rows about other people keep everything.
func TestEraseAccount_UnlinksAuditHistory(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	rows := []db.AuditEntry{
		{ActorID: sub.id, Action: "user_login", TargetType: "user", TargetID: sub.id, Detail: "from 203.0.113.9"},
		{ActorID: sub.other, Action: "user_ban", TargetType: "user", TargetID: sub.id, Detail: "spam by Subject_User"},
		{ActorID: sub.id, Action: "channel_create", TargetType: "channel", TargetID: 5, Detail: "named by the subject"},
		{ActorID: sub.other, Action: "setting_change", TargetType: "server", TargetID: 0, Detail: "motd"},
		{ActorID: sub.other, Action: "user_login", TargetType: "user", TargetID: sub.other, Detail: "from 198.51.100.7"},
	}
	for _, r := range rows {
		if err := database.LogAuditEntry(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := database.EraseAccount(ctx, sub.id, token); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	got, err := database.GetAuditLog(ctx, 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	byAction := map[string][]db.AuditEntry{}
	for _, e := range got {
		byAction[e.Action] = append(byAction[e.Action], e)
	}
	if len(got) < len(rows) {
		t.Fatalf("audit rows = %d, want at least the %d seeded (unlinked, never deleted)", len(got), len(rows))
	}
	check := func(e db.AuditEntry, actor, target int64, detail, actorTok, subjectTok string) {
		t.Helper()
		if e.ActorID != actor || e.TargetID != target || e.Detail != detail || e.ActorToken != actorTok || e.SubjectToken != subjectTok {
			t.Errorf("%s: actor %d target %d detail %q actor token %q subject token %q; want %d %d %q %q %q",
				e.Action, e.ActorID, e.TargetID, e.Detail, e.ActorToken, e.SubjectToken, actor, target, detail, actorTok, subjectTok)
		}
	}
	// The subject's own login: both ids gone, detail (an IP) gone, the token
	// on both sides.
	for _, e := range byAction["user_login"] {
		if e.Detail == "from 198.51.100.7" || e.ActorID == sub.other {
			check(e, sub.other, sub.other, "from 198.51.100.7", "", "")
		} else {
			check(e, 0, 0, "", token, token)
		}
	}
	// Banned by another: the actor stays, the target is the token.
	check(byAction["user_ban"][0], sub.other, 0, "", "", token)
	// Acting on a channel: the actor is the token, the channel target stays.
	check(byAction["channel_create"][0], 0, 5, "", token, "")
	// Nothing to do with the subject: untouched.
	check(byAction["setting_change"][0], sub.other, 0, "motd", "", "")
	// Order and time survive: ids still descend, created_at is set.
	for i := 1; i < len(got); i++ {
		if got[i-1].ID <= got[i].ID {
			t.Errorf("audit order broken at %d", i)
		}
	}
	// Erasing without a marker store unlinks without a token.
	other2 := seedUser(t, database, "second-subject")
	if err := database.LogAuditEntry(ctx, db.AuditEntry{ActorID: other2, Action: "user_login", TargetType: "user", TargetID: other2, Detail: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.EraseAccount(ctx, other2, ""); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE actor_id = ? OR target_id = ?`, other2, other2).Scan(&n); err != nil || n != 0 {
		t.Errorf("rows still naming the second subject = %d (%v)", n, err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE subject_token IS NULL AND actor_token IS NULL AND actor_id = 0 AND target_id = 0 AND action = 'user_login'`).Scan(&n); err != nil || n != 1 {
		t.Errorf("token-less unlinked rows = %d (%v), want 1", n, err)
	}
}

// A row naming two subjects — one acted on the other — keeps both tokens
// when both are erased, whichever goes first (migration 041; Codex's review
// of #1520 found the draft's single column kept only the last).
func TestEraseAccount_TwoErasedPrincipalsKeepBothTokens(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	owner := seedUser(t, database, "principals-owner")
	setRole(t, database, owner, 1)
	a := seedUser(t, database, "principal-a")
	b := seedUser(t, database, "principal-b")
	for _, r := range []db.AuditEntry{
		{ActorID: a, Action: "user_ban", TargetType: "user", TargetID: b, Detail: "spam by principal-b"},
		{ActorID: b, Action: "user_kick", TargetType: "user", TargetID: a, Detail: "retaliation"},
	} {
		if err := database.LogAuditEntry(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	const tokA, tokB = "aaaa", "bbbb"
	if _, err := database.EraseAccount(ctx, b, tokB); err != nil {
		t.Fatalf("EraseAccount(b): %v", err)
	}
	if _, err := database.EraseAccount(ctx, a, tokA); err != nil {
		t.Fatalf("EraseAccount(a): %v", err)
	}
	got, err := database.GetAuditLog(ctx, 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, e := range got {
		switch e.Action {
		case "user_ban": // a banned b
			seen++
			if e.ActorID != 0 || e.TargetID != 0 || e.Detail != "" || e.ActorToken != tokA || e.SubjectToken != tokB {
				t.Errorf("user_ban row = %+v, want actor token %q and subject token %q", e, tokA, tokB)
			}
		case "user_kick": // b kicked a
			seen++
			if e.ActorID != 0 || e.TargetID != 0 || e.Detail != "" || e.ActorToken != tokB || e.SubjectToken != tokA {
				t.Errorf("user_kick row = %+v, want actor token %q and subject token %q", e, tokB, tokA)
			}
		}
	}
	if seen != 2 {
		t.Errorf("rows naming the two subjects = %d, want 2", seen)
	}
	// Both trails are still whole: every row about a subject is reachable by
	// their token, on either side.
	for _, tok := range []string{tokA, tokB} {
		var n int
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE subject_token = ? OR actor_token = ?`, tok, tok).Scan(&n); err != nil || n != 2 {
			t.Errorf("rows carrying %q = %d (%v), want 2", tok, n, err)
		}
	}
}

// Migration 040: a job is listed until its replay purge is recorded, even
// once its files are gone; rows from before the column count as purged.
func TestErasureJob_ListedUntilReplayPurged(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	sub := seedEraseSubject(t, database)
	job, err := database.EraseAccount(ctx, sub.id, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.CompleteErasureJob(ctx, job.ID, len(job.Files)); err != nil {
		t.Fatal(err)
	}
	jobs, err := database.ListUnfinishedErasureJobs(ctx)
	if err != nil || len(jobs) != 1 || jobs[0].ReplayPurged || jobs[0].State != db.ErasureStateDone {
		t.Fatalf("a done but unpurged job is not listed: %+v, %v", jobs, err)
	}
	if err := database.MarkErasureJobReplayPurged(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if jobs, _ := database.ListUnfinishedErasureJobs(ctx); len(jobs) != 0 {
		t.Errorf("a purged, done job is still listed: %+v", jobs)
	}
	got, err := database.GetErasureJob(ctx, job.ID)
	if err != nil || !got.ReplayPurged {
		t.Errorf("GetErasureJob = %+v, %v; want purged", got, err)
	}
	// A pre-040 row: inserted with the column's default.
	if _, err := database.ExecContext(ctx, `INSERT INTO erasure_jobs (user_id, state, files) VALUES (12345, 'db_done', '[]')`); err != nil {
		t.Fatal(err)
	}
	jobs, _ = database.ListUnfinishedErasureJobs(ctx)
	if len(jobs) != 1 || !jobs[0].ReplayPurged {
		t.Errorf("a legacy row = %+v, want listed for its files with the purge counted as done", jobs)
	}
	var idx int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_reply_to'`).Scan(&idx); err != nil || idx != 1 {
		t.Errorf("idx_messages_reply_to present = %d (%v), want 1", idx, err)
	}
}
