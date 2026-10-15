package service

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// newSkippedAttachmentService returns a message service whose member role may
// attach files, with sender 1 owning two fresh uploads "att-a" and "att-b".
func newSkippedAttachmentService(t *testing.T) (*MessageService, *db.DB) {
	t.Helper()
	svc, database := newTestMessageService(t)
	svc.RunBackgroundInlineForTest()
	seedRole(t, database, &db.Role{
		ID: permissions.MemberRoleID, Name: "member", Position: 1,
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AttachFiles,
	})
	svc.perms.InvalidateAll()
	for _, id := range []string{"att-a", "att-b"} {
		if err := database.CreateAttachment(context.Background(), id, 1, id+".png", "s-"+id, "image/png", 1, nil, nil); err != nil {
			t.Fatalf("CreateAttachment %s: %v", id, err)
		}
	}
	return svc, database
}

// sweepAttachment ages one upload past the unlinked grace and runs the orphan
// sweep, which deletes every unlinked row older than the cutoff.
func sweepAttachment(t *testing.T, database *db.DB, id string) {
	t.Helper()
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `UPDATE attachments SET uploaded_at = datetime('now', '-2 hours') WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	files, err := database.DeleteOrphanedAttachments(ctx, time.Now().Add(-time.Hour))
	if err != nil || len(files) != 1 {
		t.Fatalf("sweep = %v, %v, want exactly the aged upload", files, err)
	}
}

func attachmentIDsOf(in []db.AttachmentInfo) []string {
	out := make([]string, 0, len(in))
	for _, a := range in {
		out = append(out, a.ID)
	}
	return out
}

func TestSendMessage_KeyedSweptAttachmentReportedSkipped(t *testing.T) {
	svc, database := newSkippedAttachmentService(t)
	sweepAttachment(t, database, "att-b")

	p := deliveryTestParams()
	p.Content, p.AttachmentIDs = "hi", []string{"att-a", "att-b"}
	res, err := svc.SendMessage(context.Background(), p)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if !reflect.DeepEqual(res.SkippedAttachmentIDs, []string{"att-b"}) {
		t.Fatalf("skipped = %v, want [att-b]", res.SkippedAttachmentIDs)
	}
	if got := attachmentIDsOf(res.Attachments); !reflect.DeepEqual(got, []string{"att-a"}) {
		t.Fatalf("attachments = %v, want [att-a]", got)
	}
}

func TestSendMessage_UnkeyedSkippedReported(t *testing.T) {
	svc, _ := newSkippedAttachmentService(t)
	p := SendMessageParams{ChannelID: 10, UserID: 1, Username: "alice", Content: "hi",
		AttachmentIDs: []string{"att-a", "att-missing"}}
	res, err := svc.SendMessage(context.Background(), p)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if !reflect.DeepEqual(res.SkippedAttachmentIDs, []string{"att-missing"}) {
		t.Fatalf("skipped = %v, want [att-missing]", res.SkippedAttachmentIDs)
	}
	if got := attachmentIDsOf(res.Attachments); !reflect.DeepEqual(got, []string{"att-a"}) {
		t.Fatalf("attachments = %v, want [att-a]", got)
	}
}

func TestSendMessage_NothingSkippedIsNil(t *testing.T) {
	svc, _ := newSkippedAttachmentService(t)
	p := deliveryTestParams()
	p.AttachmentIDs = []string{"att-a", "att-b"}
	res, err := svc.SendMessage(context.Background(), p)
	if err != nil || res.SkippedAttachmentIDs != nil {
		t.Fatalf("result = %+v, %v, want nil skipped", res, err)
	}
}

func TestSendMessage_RetryReplaysSkipped(t *testing.T) {
	svc, database := newSkippedAttachmentService(t)
	ctx := context.Background()
	sweepAttachment(t, database, "att-b")

	p := deliveryTestParams()
	p.Content, p.AttachmentIDs = "hi", []string{"att-a", "att-b"}
	first, err := svc.SendMessage(ctx, p)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	retry, err := svc.SendMessage(ctx, p)
	if err != nil || !retry.Duplicate || retry.MessageID != first.MessageID {
		t.Fatalf("retry = %+v, %v", retry, err)
	}
	if !reflect.DeepEqual(retry.SkippedAttachmentIDs, []string{"att-b"}) {
		t.Fatalf("replayed skipped = %v, want [att-b]", retry.SkippedAttachmentIDs)
	}

	// The retry is answered before the permission gates.
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = ? WHERE id = ?`, permissions.ReadMessages, permissions.MemberRoleID); err != nil {
		t.Fatal(err)
	}
	svc.perms.InvalidateAll()
	revoked, err := svc.SendMessage(ctx, p)
	if err != nil || !revoked.Duplicate || !reflect.DeepEqual(revoked.SkippedAttachmentIDs, []string{"att-b"}) {
		t.Fatalf("retry after revoke = %+v, %v, want duplicate with skipped [att-b]", revoked, err)
	}
}

func TestSendMessage_AllSkippedIsAttachmentsUnavailable(t *testing.T) {
	for name, keyed := range map[string]bool{"keyed": true, "unkeyed": false} {
		t.Run(name, func(t *testing.T) {
			svc, database := newSkippedAttachmentService(t)
			ctx := context.Background()
			p := SendMessageParams{ChannelID: 10, UserID: 1, Username: "alice",
				AttachmentIDs: []string{"att-missing", "att-also-missing"}}
			if keyed {
				p.ClientMessageID = deliveryTestID(time.Now())
			}
			res, err := svc.SendMessage(ctx, p)
			if res != nil || !errors.Is(err, ErrAttachmentsUnavailable) || !errors.Is(err, ErrBadRequest) {
				t.Fatalf("result = %v, err = %v, want ErrAttachmentsUnavailable and ErrBadRequest", res, err)
			}
			rows, err := database.GetMessages(ctx, 10, 0, 50)
			if err != nil || len(rows) != 0 {
				t.Fatalf("messages = %d, %v, want none", len(rows), err)
			}
			var receipts int
			if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_delivery_receipts`).Scan(&receipts); err != nil || receipts != 0 {
				t.Fatalf("receipts = %d, %v, want none", receipts, err)
			}
		})
	}
}

func TestSendMessage_TextWithAllSkippedSendsAndReportsEveryID(t *testing.T) {
	svc, _ := newSkippedAttachmentService(t)
	p := deliveryTestParams()
	p.AttachmentIDs = []string{"att-missing", "att-missing", "att-other"}
	res, err := svc.SendMessage(context.Background(), p)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if want := []string{"att-missing", "att-other"}; !reflect.DeepEqual(res.SkippedAttachmentIDs, want) {
		t.Fatalf("skipped = %v, want %v", res.SkippedAttachmentIDs, want)
	}
}

func TestSkippedAttachmentIDs_OrderAndDedup(t *testing.T) {
	cases := []struct {
		name              string
		requested, linked []string
		want              []string
	}{
		{"none requested", nil, nil, nil},
		{"all linked", []string{"a", "b"}, []string{"b", "a"}, nil},
		{"request order kept", []string{"c", "a", "b"}, []string{"a"}, []string{"c", "b"}},
		{"duplicates once", []string{"x", "a", "x", "x"}, []string{"a"}, []string{"x"}},
		{"unrequested linked ignored", []string{"a"}, []string{"z"}, []string{"a"}},
	}
	for _, tc := range cases {
		if got := skippedAttachmentIDs(tc.requested, tc.linked); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// replayReadFailsStore fails the attachment read a duplicate ack derives its
// skipped ids from.
type replayReadFailsStore struct{ Store }

func (replayReadFailsStore) GetAttachmentsByMessageIDs(context.Context, []int64) (map[int64][]db.AttachmentInfo, error) {
	return nil, errors.New("read failed")
}

func TestSendMessage_ReplaySkippedReadFailureOmits(t *testing.T) {
	svc, database := newSkippedAttachmentService(t)
	ctx := context.Background()
	p := deliveryTestParams()
	p.AttachmentIDs = []string{"att-a", "att-b"}
	first, err := svc.SendMessage(ctx, p)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	failing := NewMessageService(replayReadFailsStore{Store: database}, svc.perms, nil)
	retry, err := failing.SendMessage(ctx, p)
	if err != nil || !retry.Duplicate || retry.MessageID != first.MessageID {
		t.Fatalf("retry = %+v, %v", retry, err)
	}
	if retry.SkippedAttachmentIDs != nil {
		t.Fatalf("skipped = %v, want nil when the read fails (never a false skip)", retry.SkippedAttachmentIDs)
	}
}

// missedReceiptStore hides the sender's receipt from the pre-gate lookup, so a
// retry reaches CreateMessageDelivery and is caught by its in-transaction
// duplicate check instead (two sends racing).
type missedReceiptStore struct{ Store }

func (missedReceiptStore) FindMessageDelivery(context.Context, db.MessageDeliveryParams) (*db.MessageDelivery, error) {
	return nil, nil
}

func TestSendMessage_InTxDuplicateReplaysSkipped(t *testing.T) {
	svc, database := newSkippedAttachmentService(t)
	ctx := context.Background()
	sweepAttachment(t, database, "att-b")

	p := deliveryTestParams()
	p.Content, p.AttachmentIDs = "hi", []string{"att-a", "att-b"}
	first, err := svc.SendMessage(ctx, p)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	racing := NewMessageService(missedReceiptStore{Store: database}, svc.perms, nil)
	racing.RunBackgroundInlineForTest()
	retry, err := racing.SendMessage(ctx, p)
	if err != nil || !retry.Duplicate || retry.MessageID != first.MessageID {
		t.Fatalf("retry = %+v, %v, want in-tx duplicate of %d", retry, err, first.MessageID)
	}
	if !reflect.DeepEqual(retry.SkippedAttachmentIDs, []string{"att-b"}) {
		t.Fatalf("replayed skipped = %v, want [att-b]", retry.SkippedAttachmentIDs)
	}
}
