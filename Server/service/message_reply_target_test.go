package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// replyTargetStore counts message inserts and can fail the reply target
// lookup.
type replyTargetStore struct {
	Store
	inserts   *int
	lookupErr error
}

func (s replyTargetStore) CreateMessageWithMentions(ctx context.Context, channelID, userID int64, content string, replyTo *int64, mentionedUserIDs []int64, replyPingUserID int64, mentionsEveryone bool, mentionedRoleIDs []int64) (*db.Message, error) {
	*s.inserts++
	return s.Store.CreateMessageWithMentions(ctx, channelID, userID, content, replyTo, mentionedUserIDs, replyPingUserID, mentionsEveryone, mentionedRoleIDs)
}

func (s replyTargetStore) GetReferencedMessages(ctx context.Context, channelID int64, ids []int64) (map[int64]*db.ReferencedMessage, error) {
	if s.lookupErr != nil {
		return nil, s.lookupErr
	}
	return s.Store.GetReferencedMessages(ctx, channelID, ids)
}

// newReplyTargetFixture seeds channels 10 and 11, each with one message by
// alice, and returns a service whose inserts are counted.
func newReplyTargetFixture(t *testing.T, lookupErr error) (svc *MessageService, database *db.DB, inserts *int, inCh10, inCh11 int64) {
	t.Helper()
	_, database = newTestMessageService(t)
	seedChannel(t, database, &db.Channel{ID: 11, Name: "other", Type: "text"})
	inCh10 = mustCreateMessage(t, database, 10, 1, "parent", nil)
	inCh11 = mustCreateMessage(t, database, 11, 1, "elsewhere", nil)
	inserts = new(int)
	permSvc := NewPermissionService(database, permissions.NewChecker(database))
	svc = NewMessageService(replyTargetStore{Store: database, inserts: inserts, lookupErr: lookupErr}, permSvc, nil)
	return svc, database, inserts, inCh10, inCh11
}

func replyParams(replyTo int64) SendMessageParams {
	return SendMessageParams{ChannelID: 10, UserID: 1, Username: "alice", Content: "a reply", ReplyTo: &replyTo}
}

func TestSendMessage_ReplyInSameChannelIsAccepted(t *testing.T) {
	svc, _, inserts, parent, _ := newReplyTargetFixture(t, nil)

	result, err := svc.SendMessage(context.Background(), replyParams(parent))
	mustDo(t, "SendMessage", err)
	if *inserts != 1 {
		t.Errorf("inserts = %d, want 1", *inserts)
	}
	if result.ReferencedMessage == nil || result.ReferencedMessage.ID != parent {
		t.Errorf("ReferencedMessage = %+v, want the parent %d", result.ReferencedMessage, parent)
	}
}

func TestSendMessage_ReplyTargetMustBeAMessageInTheChannel(t *testing.T) {
	cases := []struct {
		name   string
		target func(database *db.DB, inCh10, inCh11 int64) int64
	}{
		{"another channel", func(_ *db.DB, _, inCh11 int64) int64 { return inCh11 }},
		{"no such message", func(_ *db.DB, _, inCh11 int64) int64 { return inCh11 + 1000 }},
		{"deleted", func(database *db.DB, inCh10, _ int64) int64 {
			mustDo(t, "DeleteMessage", database.DeleteMessage(context.Background(), inCh10, 1, false))
			return inCh10
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, database, inserts, inCh10, inCh11 := newReplyTargetFixture(t, nil)

			_, err := svc.SendMessage(context.Background(), replyParams(tc.target(database, inCh10, inCh11)))
			if !errors.Is(err, ErrBadRequest) {
				t.Fatalf("err = %v, want ErrBadRequest", err)
			}
			if err.Error() != "bad request: reply target not found" {
				t.Errorf("err = %q, want the same message for every case", err.Error())
			}
			if *inserts != 0 {
				t.Errorf("inserts = %d, want 0", *inserts)
			}
		})
	}
}

// A retry of a send that already committed still gets its original message
// after the reply target is deleted.
func TestSendMessage_RetryAfterReplyTargetDeletedReturnsOriginal(t *testing.T) {
	svc, database, _, parent, _ := newReplyTargetFixture(t, nil)
	p := replyParams(parent)
	p.ClientMessageID = deliveryTestID(time.Now())

	first, err := svc.SendMessage(context.Background(), p)
	mustDo(t, "first send", err)
	mustDo(t, "DeleteMessage", database.DeleteMessage(context.Background(), parent, 1, false))

	retry, err := svc.SendMessage(context.Background(), p)
	mustDo(t, "retry", err)
	if !retry.Duplicate || retry.MessageID != first.MessageID {
		t.Errorf("retry = {Duplicate: %v, MessageID: %d}, want the original %d as a duplicate",
			retry.Duplicate, retry.MessageID, first.MessageID)
	}
}

// A failed reply target lookup refuses the send.
func TestSendMessage_ReplyTargetLookupFailureRefusesSend(t *testing.T) {
	lookupErr := errors.New("database is locked")
	svc, _, inserts, parent, _ := newReplyTargetFixture(t, lookupErr)

	_, err := svc.SendMessage(context.Background(), replyParams(parent))
	if !errors.Is(err, ErrInternal) || !errors.Is(err, lookupErr) {
		t.Fatalf("err = %v, want ErrInternal wrapping the lookup error", err)
	}
	if *inserts != 0 {
		t.Errorf("inserts = %d, want 0", *inserts)
	}
}
