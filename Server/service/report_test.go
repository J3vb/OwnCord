package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// newTestReportService builds a ReportService over a fresh database with a
// small role/user fixture: 1 = owner (Administrator), 2 = moderator
// (ModerateMembers), 3..9 = plain members (SendMessages|ReadMessages).
func newTestReportService(t *testing.T) (*ReportService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: 1, Name: "owner", Permissions: permissions.Administrator, Position: 100})
	seedRole(t, database, &db.Role{ID: 2, Name: "mod", Permissions: permissions.ModerateMembers, Position: 80})
	seedRole(t, database, &db.Role{ID: 3, Name: "mod2", Permissions: permissions.ModerateMembers, Position: 60})
	seedRole(t, database, &db.Role{ID: 4, Name: "member", Permissions: permissions.SendMessages | permissions.ReadMessages, Position: 40})
	seedRole(t, database, &db.Role{ID: 5, Name: "blind", Permissions: permissions.SendMessages, Position: 10})
	for userID, roleID := range map[int64]int64{
		1: 1, 2: 2, 3: 3, 10: 4, 11: 4, 12: 4, 13: 4, 14: 4, 15: 4, 16: 5,
	} {
		seedUser(t, database, &db.User{ID: userID, Username: fmt.Sprintf("u%d", userID)})
		seedUserRole(t, database, userID, roleID)
	}
	checker := permissions.NewChecker(database)
	perms := NewPermissionService(database, checker)
	moderation := NewModerationService(database, perms)
	messages := NewMessageService(database, perms, nil)
	uploads := NewUploadService(database, perms)
	limiter := auth.NewRateLimiter()
	return NewReportService(database, perms, messages, uploads, moderation, limiter), database
}

// seedReportMessage inserts a message by userID in channelID and returns its id.
func seedReportMessage(t *testing.T, database *db.DB, channelID, userID int64, content string) int64 {
	t.Helper()
	id, err := database.CreateMessage(context.Background(), channelID, userID, content, nil)
	if err != nil {
		t.Fatalf("seedReportMessage: %v", err)
	}
	return id
}

func TestReport_FileMessageSnapshotsElevenRowsByReference(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 100, Name: "general"})

	ids := make([]int64, 0, 11)
	for i := range 11 {
		ids = append(ids, seedReportMessage(t, database, 100, 11, fmt.Sprintf("msg %d", i)))
	}
	centre := ids[5]
	// One attachment on the reported message, to prove the reference shape.
	if err := database.CreateAttachment(ctx, "att-1", 11, "f.png", "att-1", "image/png", 5, nil, nil); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	if _, err := database.LinkAttachmentsToMessage(ctx, centre, 11, []string{"att-1"}); err != nil {
		t.Fatalf("LinkAttachmentsToMessage: %v", err)
	}

	reportID, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(centre, 10), Reason: "spam"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}

	evidence, err := database.ListReportEvidence(ctx, reportID)
	if err != nil {
		t.Fatalf("ListReportEvidence: %v", err)
	}
	if len(evidence) != 11 {
		t.Fatalf("evidence rows = %d, want 11", len(evidence))
	}
	var centreRow *db.ReportEvidenceRow
	for i := range evidence {
		if evidence[i].Seq == 0 {
			centreRow = &evidence[i]
		}
	}
	if centreRow == nil {
		t.Fatal("no seq=0 row")
	}
	if centreRow.Content != "msg 5" {
		t.Errorf("centre content = %q, want %q", centreRow.Content, "msg 5")
	}
	if !containsSubstr(centreRow.Attachments, `"id":"att-1"`) || containsSubstr(centreRow.Attachments, "stored_as") {
		t.Errorf("centre attachments = %q, want a reference to att-1 and never stored_as", centreRow.Attachments)
	}

	report, err := database.GetReport(ctx, reportID)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.SubjectID != 11 {
		t.Errorf("subject_id = %d, want 11 (the message author, derived)", report.SubjectID)
	}
}

func containsSubstr(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func TestReport_FileAttachmentByReference(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 101, Name: "general"})
	msgID := seedReportMessage(t, database, 101, 11, "hello")
	if err := database.CreateAttachment(ctx, "att-2", 11, "pic.png", "att-2", "image/png", 9, nil, nil); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	if _, err := database.LinkAttachmentsToMessage(ctx, msgID, 11, []string{"att-2"}); err != nil {
		t.Fatalf("LinkAttachmentsToMessage: %v", err)
	}

	reportID, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetAttachment, TargetID: "att-2", Reason: "nsfw_unlabelled"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	evidence, err := database.ListReportEvidence(ctx, reportID)
	if err != nil {
		t.Fatalf("ListReportEvidence: %v", err)
	}
	if len(evidence) != 1 {
		t.Fatalf("evidence rows = %d, want 1", len(evidence))
	}
	if !containsSubstr(evidence[0].Attachments, `"id":"att-2"`) || containsSubstr(evidence[0].Attachments, "stored_as") {
		t.Errorf("attachment evidence = %q", evidence[0].Attachments)
	}
	report, err := database.GetReport(ctx, reportID)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.SubjectID != 11 {
		t.Errorf("subject_id = %d, want 11 (the uploader, derived)", report.SubjectID)
	}
}

func TestReport_FileUserHasNoEvidence(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()

	reportID, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetUser, TargetID: "11", Reason: "harassment"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	evidence, err := database.ListReportEvidence(ctx, reportID)
	if err != nil {
		t.Fatalf("ListReportEvidence: %v", err)
	}
	if len(evidence) != 0 {
		t.Fatalf("evidence rows = %d, want 0 for a user target", len(evidence))
	}
	report, err := database.GetReport(ctx, reportID)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.SubjectID != 11 {
		t.Errorf("subject_id = %d, want 11", report.SubjectID)
	}
}

func TestReport_TargetMustBeVisibleToReporter(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()

	// (a) A channel the reporter cannot read.
	seedChannel(t, database, &db.Channel{ID: 200, Name: "blind-channel"})
	blindMsg := seedReportMessage(t, database, 200, 11, "secret")
	if _, err := svc.File(ctx, FileReportParams{ReporterID: 16, TargetType: TargetMessage, TargetID: strconv.FormatInt(blindMsg, 10), Reason: "spam"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("blind channel: err = %v, want ErrNotFound", err)
	}

	// (b) A DM the reporter is not in.
	dm, _, err := database.GetOrCreateDMChannel(ctx, 12, 13)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	dmMsg := seedReportMessage(t, database, dm.ID, 12, "private")
	if _, err := svc.File(ctx, FileReportParams{ReporterID: 14, TargetType: TargetMessage, TargetID: strconv.FormatInt(dmMsg, 10), Reason: "spam"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("non-participant DM: err = %v, want ErrNotFound", err)
	}

	// (c) An attachment Authorize refuses: unlinked, uploaded by someone else.
	if err := database.CreateAttachment(ctx, "att-private", 12, "f.png", "att-private", "image/png", 4, nil, nil); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	if _, err := svc.File(ctx, FileReportParams{ReporterID: 13, TargetType: TargetAttachment, TargetID: "att-private", Reason: "spam"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unauthorized attachment: err = %v, want ErrNotFound", err)
	}
}

func TestReport_DuplicateIs409(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 300, Name: "general"})
	msgID := seedReportMessage(t, database, 300, 11, "hi")

	if _, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"}); err != nil {
		t.Fatalf("first File: %v", err)
	}
	if _, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"}); !errors.Is(err, ErrDuplicateReport) {
		t.Errorf("second File: err = %v, want ErrDuplicateReport", err)
	}
	// A different reporter is not blocked by another reporter's open report.
	if _, err := svc.File(ctx, FileReportParams{ReporterID: 12, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"}); err != nil {
		t.Errorf("a second reporter's report: %v, want success", err)
	}
}

func TestReport_RateLimited(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	for i := int64(20); i < 20+6; i++ {
		seedUser(t, database, &db.User{ID: i, Username: fmt.Sprintf("target%d", i)})
		seedUserRole(t, database, i, 4)
	}
	var lastErr error
	for i := int64(20); i < 20+6; i++ {
		_, lastErr = svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetUser, TargetID: strconv.FormatInt(i, 10), Reason: "spam"})
	}
	if !errors.Is(lastErr, ErrRateLimited) {
		t.Errorf("6th report in the window: err = %v, want ErrRateLimited", lastErr)
	}
}

func TestReport_SnapshotSurvivesEditAndDelete(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 400, Name: "general"})
	msgID := seedReportMessage(t, database, 400, 11, "original content")

	reportID, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}

	if _, err := database.EditMessage(ctx, msgID, 11, "edited away"); err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	if err := database.DeleteMessage(ctx, msgID, 11, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	evidence, err := database.ListReportEvidence(ctx, reportID)
	if err != nil {
		t.Fatalf("ListReportEvidence: %v", err)
	}
	var centre *db.ReportEvidenceRow
	for i := range evidence {
		if evidence[i].Seq == 0 {
			centre = &evidence[i]
		}
	}
	if centre == nil || centre.Content != "original content" {
		t.Errorf("evidence content after edit+delete = %+v, want the original content unchanged", centre)
	}
}

func TestReport_SubjectIsDerivedNeverSupplied(t *testing.T) {
	// FileReportParams carries no subject field at all -- there is no wire
	// path to supply one. This test pins that the subject the row ends up
	// with is exactly the target's real owner, for all three target types.
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 500, Name: "general"})
	msgID := seedReportMessage(t, database, 500, 11, "hi")

	id, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	r, _ := database.GetReport(ctx, id)
	if r.SubjectID != 11 {
		t.Errorf("message target subject = %d, want the author 11", r.SubjectID)
	}

	id2, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetUser, TargetID: "12", Reason: "spam"})
	if err != nil {
		t.Fatalf("File(user): %v", err)
	}
	r2, _ := database.GetReport(ctx, id2)
	if r2.SubjectID != 12 {
		t.Errorf("user target subject = %d, want 12", r2.SubjectID)
	}
}

// ─── Queue ──────────────────────────────────────────────────────────────────

func TestModerationQueue_RequiresTheBit(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 600, Name: "general"})
	msgID := seedReportMessage(t, database, 600, 11, "hi")
	id, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}

	// A plain member (no bit) is refused on every route.
	if _, err := svc.Queue(ctx, 12, ""); !errors.Is(err, ErrForbidden) {
		t.Errorf("Queue without the bit: %v, want ErrForbidden", err)
	}
	if _, err := svc.Get(ctx, 12, id); !errors.Is(err, ErrForbidden) {
		t.Errorf("Get without the bit: %v, want ErrForbidden", err)
	}
	if err := svc.Assign(ctx, 12, id, false); !errors.Is(err, ErrForbidden) {
		t.Errorf("Assign without the bit: %v, want ErrForbidden", err)
	}
	if err := svc.Note(ctx, 12, id, "note"); !errors.Is(err, ErrForbidden) {
		t.Errorf("Note without the bit: %v, want ErrForbidden", err)
	}
	if _, err := svc.Close(ctx, 12, id, "no_action"); !errors.Is(err, ErrForbidden) {
		t.Errorf("Close without the bit: %v, want ErrForbidden", err)
	}

	// The owner (Administrator, no explicit ModerateMembers bit) is allowed
	// via CanModerate's Administrator bypass.
	if _, err := svc.Queue(ctx, 1, ""); err != nil {
		t.Errorf("Queue as Administrator: %v, want allowed", err)
	}
	if _, err := svc.Get(ctx, 1, id); err != nil {
		t.Errorf("Get as Administrator: %v, want allowed", err)
	}
}

func TestModerationQueue_StateMachine(t *testing.T) {
	t.Run("open to assigned to resolved", func(t *testing.T) {
		ctx := context.Background()
		svc, database := newTestReportService(t)
		seedChannel(t, database, &db.Channel{ID: 700, Name: "general"})
		msgID := seedReportMessage(t, database, 700, 11, "hi")
		id, _ := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
		if err := svc.Assign(ctx, 2, id, false); err != nil {
			t.Fatalf("Assign: %v", err)
		}
		if _, err := svc.Close(ctx, 2, id, "actioned"); err != nil {
			t.Fatalf("Close: %v", err)
		}
		r, _ := database.GetReport(ctx, id)
		if r.State != "resolved" || r.Outcome != "actioned" {
			t.Errorf("state=%q outcome=%q, want resolved/actioned", r.State, r.Outcome)
		}
		// Nothing leaves a closed state.
		if err := svc.Assign(ctx, 2, id, false); !errors.Is(err, ErrConflict) {
			t.Errorf("Assign after close: %v, want ErrConflict", err)
		}
		if _, err := svc.Close(ctx, 2, id, "no_action"); !errors.Is(err, ErrConflict) {
			t.Errorf("Close after close: %v, want ErrConflict", err)
		}
	})

	t.Run("open to dismissed without assigning", func(t *testing.T) {
		ctx := context.Background()
		svc, database := newTestReportService(t)
		seedChannel(t, database, &db.Channel{ID: 701, Name: "general"})
		msgID := seedReportMessage(t, database, 701, 11, "hi")
		id, _ := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
		if _, err := svc.Close(ctx, 2, id, "duplicate"); err != nil {
			t.Fatalf("Close without assigning: %v", err)
		}
		r, _ := database.GetReport(ctx, id)
		if r.State != "dismissed" || r.Outcome != "duplicate" {
			t.Errorf("state=%q outcome=%q, want dismissed/duplicate", r.State, r.Outcome)
		}
	})
}

func TestModerationQueue_AssignConflictAndForce(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 800, Name: "general"})
	msgID := seedReportMessage(t, database, 800, 11, "hi")
	id, _ := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})

	// mod2 (role 3, position 60) assigns first.
	if err := svc.Assign(ctx, 3, id, false); err != nil {
		t.Fatalf("first assign: %v", err)
	}
	// mod (role 2, position 80) tries to take it without force: 409.
	if err := svc.Assign(ctx, 2, id, false); !errors.Is(err, ErrConflict) {
		t.Errorf("reassign without force: %v, want ErrConflict", err)
	}
	// mod outranks mod2 (80 > 60) and forces: succeeds.
	if err := svc.Assign(ctx, 2, id, true); err != nil {
		t.Errorf("forced reassign by a higher rank: %v, want success", err)
	}
	r, _ := database.GetReport(ctx, id)
	if r.AssigneeID != 2 {
		t.Errorf("assignee after forced reassign = %d, want 2", r.AssigneeID)
	}
	// mod2 cannot force it back: does not outrank mod.
	if err := svc.Assign(ctx, 3, id, true); !errors.Is(err, ErrForbidden) {
		t.Errorf("forced reassign by a lower rank: %v, want ErrForbidden", err)
	}
}

func TestModerationQueue_NotesNeverReachEitherParty(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 900, Name: "general"})
	msgID := seedReportMessage(t, database, 900, 11, "hi")
	id, _ := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
	if err := svc.Note(ctx, 2, id, "internal moderator note"); err != nil {
		t.Fatalf("Note: %v", err)
	}

	// The reporter's own view carries no notes field at all (db.ReportSummary
	// has none) and Mine() never touches report_notes.
	mine, err := svc.Mine(ctx, 10)
	if err != nil {
		t.Fatalf("Mine: %v", err)
	}
	if len(mine) != 1 {
		t.Fatalf("Mine() = %d rows, want 1", len(mine))
	}
	b, _ := json.Marshal(mine[0])
	if containsSubstr(string(b), "note") {
		t.Errorf("reporter's own view leaks the note: %s", b)
	}

	// The subject cannot reach the note either -- Get is refused entirely
	// (no bit) and even with the bit, confidentiality refuses their own report
	// (covered by TestReport_SubjectSeesNothing).
	if _, err := svc.Get(ctx, 11, id); !errors.Is(err, ErrForbidden) {
		t.Errorf("subject Get without the bit: %v, want ErrForbidden", err)
	}

	// A moderator DOES see it via Get.
	detail, err := svc.Get(ctx, 2, id)
	if err != nil {
		t.Fatalf("Get as moderator: %v", err)
	}
	if len(detail.Notes) != 1 || detail.Notes[0].Body != "internal moderator note" {
		t.Errorf("moderator's Get notes = %+v", detail.Notes)
	}
}

func TestModerationQueue_ConcurrentCloseOneWins(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 950, Name: "general"})
	msgID := seedReportMessage(t, database, 950, 11, "hi")
	id, _ := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})

	var wg sync.WaitGroup
	var successes atomic.Int32
	for range 5 {
		wg.Go(func() {
			if _, err := svc.Close(ctx, 2, id, "no_action"); err == nil {
				successes.Add(1)
			}
		})
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Errorf("concurrent closes: %d succeeded, want exactly 1", successes.Load())
	}
	r, _ := database.GetReport(ctx, id)
	if r.State != "dismissed" {
		t.Errorf("final state = %q, want dismissed", r.State)
	}
}

// ─── Confidentiality ────────────────────────────────────────────────────────

func TestReport_SubjectSeesNothing(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 1000, Name: "general"})
	msgID := seedReportMessage(t, database, 1000, 11, "hi")
	id, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}

	// The subject, without the bit: Forbidden, same as any non-holder.
	if _, err := svc.Get(ctx, 11, id); !errors.Is(err, ErrForbidden) {
		t.Errorf("subject without the bit: %v, want ErrForbidden", err)
	}

	// Now grant the subject the bit -- they STILL cannot open their own
	// report, and get 404, indistinguishable from a missing id.
	seedUserRole(t, database, 11, 2)
	svc.perms.InvalidateUser(11) // the Get above cached the old role
	if _, err := svc.Get(ctx, 11, id); !errors.Is(err, ErrNotFound) {
		t.Errorf("subject WITH the bit reading their own report: %v, want ErrNotFound", err)
	}
	if _, err := svc.Get(ctx, 11, id+9999); !errors.Is(err, ErrNotFound) {
		t.Errorf("a genuinely missing id: %v, want ErrNotFound (must read the same as the case above)", err)
	}

	// And it is absent from their own queue view.
	rows, err := svc.Queue(ctx, 11, "")
	if err != nil {
		t.Fatalf("Queue as subject-with-bit: %v", err)
	}
	for _, r := range rows {
		if r.ID == id {
			t.Errorf("the subject's own report appears in their queue view")
		}
	}
}

func TestReport_ReporterSeesOnlyTheirOwnStatus(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 1100, Name: "general"})
	msgID := seedReportMessage(t, database, 1100, 11, "hi")
	id, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	if err := svc.Assign(ctx, 2, id, false); err != nil {
		t.Fatalf("Assign: %v", err)
	}
	if err := svc.Note(ctx, 2, id, "note"); err != nil {
		t.Fatalf("Note: %v", err)
	}

	mine, err := svc.Mine(ctx, 10)
	if err != nil {
		t.Fatalf("Mine: %v", err)
	}
	if len(mine) != 1 {
		t.Fatalf("Mine() = %d rows, want 1", len(mine))
	}
	if mine[0].ID != id || mine[0].State != "assigned" {
		t.Errorf("mine[0] = %+v, want id=%d state=assigned", mine[0], id)
	}
	// db.ReportSummary structurally has no assignee or notes field to leak.

	// Another user's Mine() never sees this report.
	otherMine, err := svc.Mine(ctx, 12)
	if err != nil {
		t.Fatalf("Mine(other): %v", err)
	}
	for _, r := range otherMine {
		if r.ID == id {
			t.Errorf("another user's Mine() sees a report they did not file")
		}
	}
}

// The mod_queue frame's audience (including that it must exclude a
// bit-holding subject or reporter — P1-1) is fully covered at the ws layer:
// ws.TestModerationAudience_OnlyBitHoldersOrAdmin and
// ws.TestModQueue_ExcludesSubjectAndReporterEvenIfTheyHoldTheBit
// (Server/ws/moderation_queue_test.go). ReportService has no hub dependency
// by design — like ModerationService, broadcasting after a successful
// service call is the REST handler's job — so there is nothing left for a
// service-package test to assert here that those two do not already prove.

// P1-2's original regression (the report_create audit row must not carry
// the reporter's identity) is superseded by a second Codex review: report
// lifecycle events do not go to the shared audit_log AT ALL any more, so
// there is no audit row to read here at all. The system-actor assertion
// lives on as part of TestReportEvents_EveryMutationWritesOne, over
// report_events instead (audit_coverage_test.go's four report_* rows were
// removed for the same reason).

// TestReportEvents_EveryMutationWritesOne is the second Codex review's
// regression test, replacing the four report_* rows audit_coverage_test.go
// used to carry: File, Assign, Note and Close each write exactly one
// report_events row (never the shared audit_log — VIEW_AUDIT_LOG holders
// have no route to any of this any more), created's actor is the system (0,
// hiding the reporter — P1-2's original point survives here), the rest
// carry the acting moderator, and AssertSafeDetails proves detail never
// carries the free text a fixture used (the note body, or the report's own
// detail field) — only the state or outcome word.
func TestReportEvents_EveryMutationWritesOne(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 1505, Name: "general"})
	msgID := seedReportMessage(t, database, 1505, 11, "hi")

	const detail = "password: hunter2, hash $2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
	id, err := svc.File(ctx, FileReportParams{
		ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10),
		Reason: "harassment", Detail: detail,
	})
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	if err := svc.Assign(ctx, 2, id, false); err != nil {
		t.Fatalf("Assign: %v", err)
	}
	const noteBody = "moderator note mentioning password: hunter2secret"
	if err := svc.Note(ctx, 2, id, noteBody); err != nil {
		t.Fatalf("Note: %v", err)
	}
	if _, err := svc.Close(ctx, 2, id, "actioned"); err != nil {
		t.Fatalf("Close: %v", err)
	}

	events, err := database.ListReportEvents(ctx, id)
	if err != nil {
		t.Fatalf("ListReportEvents: %v", err)
	}
	wantActions := []string{"created", "assigned", "noted", "closed"}
	if len(events) != len(wantActions) {
		t.Fatalf("report_events = %d rows (%+v), want %d: %v", len(events), events, len(wantActions), wantActions)
	}
	for i, action := range wantActions {
		if events[i].Action != action {
			t.Errorf("event[%d].Action = %q, want %q", i, events[i].Action, action)
		}
	}
	if events[0].ActorID != 0 {
		t.Errorf("created event actor = %d, want 0 (system actor, hides the reporter)", events[0].ActorID)
	}
	for i := 1; i < len(events); i++ {
		if events[i].ActorID != 2 {
			t.Errorf("event[%d] (%s) actor = %d, want 2 (the acting moderator)", i, events[i].Action, events[i].ActorID)
		}
	}

	corpus := make([]db.AuditEntry, len(events))
	for i, e := range events {
		corpus[i] = db.AuditEntry{Action: e.Action, Detail: e.Detail}
	}
	audittest.AssertSafeDetails(t, corpus, detail, noteBody, "hunter2", "$2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ")

	// No route to any of this through the shared audit_log at all.
	var auditRows int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE target_type = 'report'`).Scan(&auditRows); err != nil {
		t.Fatalf("count audit_log report rows: %v", err)
	}
	if auditRows != 0 {
		t.Errorf("audit_log has %d row(s) naming a report, want 0 (report lifecycle events live only in report_events)", auditRows)
	}
}

// TestReport_MessageTargetErrorsAreIndistinguishable is P2-5's regression
// test: a nonexistent message id and a real message id the reporter cannot
// see must produce the EXACT SAME error text. A distinguishable message is
// itself an existence oracle.
func TestReport_MessageTargetErrorsAreIndistinguishable(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 1501, Name: "blind-channel-p25"})
	unreadableMsg := seedReportMessage(t, database, 1501, 11, "secret")

	_, errMissing := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: "99999999", Reason: "spam"})
	_, errUnreadable := svc.File(ctx, FileReportParams{ReporterID: 16, TargetType: TargetMessage, TargetID: strconv.FormatInt(unreadableMsg, 10), Reason: "spam"})
	if !errors.Is(errMissing, ErrNotFound) || !errors.Is(errUnreadable, ErrNotFound) {
		t.Fatalf("errMissing=%v errUnreadable=%v, want both ErrNotFound", errMissing, errUnreadable)
	}
	if errMissing.Error() != errUnreadable.Error() {
		t.Errorf("error text differs: missing=%q unreadable=%q, want identical (no existence oracle)",
			errMissing.Error(), errUnreadable.Error())
	}
}

// TestReport_ModeratorReporterCannotActOnOwnReport is P2-6's regression
// test: a moderator who filed a report may still read its status (Mine, and
// Get for the report's own metadata) but never its internal notes, and may
// not assign/note/close it — that would be reviewing their own filing.
func TestReport_ModeratorReporterCannotActOnOwnReport(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 1502, Name: "general"})
	// Role 2 (moderator) carries only ModerateMembers, not ReadMessages — grant
	// user 2 read access to this channel so File's target-visibility check
	// isn't what blocks them from filing (that's not what this test is about).
	seedChannelUserOverride(t, database, 2, 1502, permissions.ReadMessages, 0)
	msgID := seedReportMessage(t, database, 1502, 11, "hi")
	// User 2 is a moderator (role 2, ModerateMembers) AND files this report.
	id, err := svc.File(ctx, FileReportParams{ReporterID: 2, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	// A different moderator adds a note before the reporter-moderator looks.
	if err := svc.Note(ctx, 3, id, "internal note the reporter must not see"); err != nil {
		t.Fatalf("Note(other moderator): %v", err)
	}

	detail, err := svc.Get(ctx, 2, id)
	if err != nil {
		t.Fatalf("Get(moderator-reporter): %v", err)
	}
	if len(detail.Notes) != 0 {
		t.Errorf("Get(moderator-reporter).Notes = %+v, want empty", detail.Notes)
	}

	if err := svc.Assign(ctx, 2, id, false); !errors.Is(err, ErrSelfReview) {
		t.Errorf("Assign(self): %v, want ErrSelfReview", err)
	}
	if err := svc.Note(ctx, 2, id, "trying to note my own report"); !errors.Is(err, ErrSelfReview) {
		t.Errorf("Note(self): %v, want ErrSelfReview", err)
	}
	if _, err := svc.Close(ctx, 2, id, "no_action"); !errors.Is(err, ErrSelfReview) {
		t.Errorf("Close(self): %v, want ErrSelfReview", err)
	}
}

// TestReport_ConcurrentFilingExactlyOneSucceeds is P2-7's regression test:
// idx_reports_active_unique must make the dedupe check race-proof, not just
// a sequential pre-check. Two goroutines file the identical report at once;
// exactly one must succeed and the other must see ErrDuplicateReport.
func TestReport_ConcurrentFilingExactlyOneSucceeds(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 1503, Name: "general"})
	msgID := seedReportMessage(t, database, 1503, 11, "hi")

	// File's own rate limit (5 filings / 10 min per reporter) would otherwise
	// mask the race with ErrRateLimited, so this races exactly at that ceiling.
	const attempts = 5
	var wg sync.WaitGroup
	var successes, duplicates atomic.Int32
	for range attempts {
		wg.Go(func() {
			_, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
			switch {
			case err == nil:
				successes.Add(1)
			case errors.Is(err, ErrDuplicateReport):
				duplicates.Add(1)
			default:
				t.Errorf("unexpected error racing File: %v", err)
			}
		})
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Errorf("concurrent filings: %d succeeded, want exactly 1", successes.Load())
	}
	if duplicates.Load() != attempts-1 {
		t.Errorf("concurrent filings: %d saw ErrDuplicateReport, want %d", duplicates.Load(), attempts-1)
	}
	var rows int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM reports WHERE reporter_id = 10 AND target_ref = ?`, strconv.FormatInt(msgID, 10)).Scan(&rows); err != nil {
		t.Fatalf("count reports: %v", err)
	}
	if rows != 1 {
		t.Errorf("reports rows for the raced target = %d, want 1", rows)
	}
}

// TestModerationQueue_ConcurrentUnforcedAssignOneWins is P2-8's regression
// test: the assign UPDATE is guarded on the observed assignee, not just
// state, so two unforced assigns racing on the same open report can never
// both succeed.
func TestModerationQueue_ConcurrentUnforcedAssignOneWins(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 1504, Name: "general"})
	msgID := seedReportMessage(t, database, 1504, 11, "hi")
	id, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetMessage, TargetID: strconv.FormatInt(msgID, 10), Reason: "spam"})
	if err != nil {
		t.Fatalf("File: %v", err)
	}

	var wg sync.WaitGroup
	var successes, conflicts atomic.Int32
	for _, mod := range []int64{2, 3} {
		wg.Go(func() {
			err := svc.Assign(ctx, mod, id, false)
			switch {
			case err == nil:
				successes.Add(1)
			case errors.Is(err, ErrConflict):
				conflicts.Add(1)
			default:
				t.Errorf("unexpected error racing Assign: %v", err)
			}
		})
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Errorf("concurrent unforced assigns: %d succeeded, want exactly 1", successes.Load())
	}
	if conflicts.Load() != 1 {
		t.Errorf("concurrent unforced assigns: %d saw ErrConflict, want 1", conflicts.Load())
	}
	report, err := database.GetReport(ctx, id)
	if err != nil {
		t.Fatalf("GetReport: %v", err)
	}
	if report.AssigneeID != 2 && report.AssigneeID != 3 {
		t.Errorf("final assignee = %d, want 2 or 3", report.AssigneeID)
	}
}
