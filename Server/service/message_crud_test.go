package service

// Tests for the 2026-08-12/13 message_crud.go findings: the post-commit
// GetDMParticipantIDs fan-out gap on send/edit/delete (OC-0033, OC-0067,
// OC-0068), EditMessage's fail-open channel lookup (OC-0074), DeleteMessage's
// missing archived-channel gate (OC-0077), and SendMessage's redundant
// dm_channel_open re-opens (OC-0106).

import (
	"context"
	"errors"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// disconnectAfterWriteStore models a client whose connection drops the instant
// its write commits — the request ctx gets canceled right after the wrapped
// write call returns, before the post-commit DM participant lookup runs.
// GetDMParticipantIDs is overridden to fail whenever it is handed an
// already-canceled context, so a test can tell whether the caller used the
// (canceled) request ctx or a detached one for that lookup.
type disconnectAfterWriteStore struct {
	Store
	cancel context.CancelFunc
}

func (s disconnectAfterWriteStore) CreateMessageWithMentions(ctx context.Context, channelID, userID int64, content string, replyTo *int64, mentionedUserIDs []int64, mentionsEveryone bool) (*db.Message, error) {
	msg, err := s.Store.CreateMessageWithMentions(ctx, channelID, userID, content, replyTo, mentionedUserIDs, mentionsEveryone)
	s.cancel()
	return msg, err
}

func (s disconnectAfterWriteStore) EditMessage(ctx context.Context, id, userID int64, content string) (*db.Message, error) {
	msg, err := s.Store.EditMessage(ctx, id, userID, content)
	s.cancel()
	return msg, err
}

func (s disconnectAfterWriteStore) DeleteMessage(ctx context.Context, id, userID int64, isMod bool) error {
	err := s.Store.DeleteMessage(ctx, id, userID, isMod)
	s.cancel()
	return err
}

func (s disconnectAfterWriteStore) GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return s.Store.GetDMParticipantIDs(ctx, channelID)
}

// newDMFixture seeds a two-person DM channel (alice=1, bob=2) and returns the
// permission service so callers can build plain and wrapped MessageServices
// against the same underlying database.
func newDMFixture(t *testing.T) (*db.DB, *PermissionService) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 50, Name: "dm-1-2", Type: "dm"})
	seedDMParticipant(t, database, 50, 1)
	seedDMParticipant(t, database, 50, 2)
	return database, NewPermissionService(database, permissions.NewChecker(database))
}

// OC-0033: a sender whose connection drops right after their DM message
// commits must not silently drop live fan-out to the other participant(s).
func TestSendMessage_DMFanoutSurvivesSenderDisconnectAfterCommit(t *testing.T) {
	database, permSvc := newDMFixture(t)

	ctx, cancel := context.WithCancel(context.Background())
	svc := NewMessageService(disconnectAfterWriteStore{Store: database, cancel: cancel}, permSvc, nil)

	result, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(result.ParticipantIDs) == 0 {
		t.Fatal("ParticipantIDs empty after a sender disconnect that raced the post-commit DM lookup — " +
			"the recipient gets no live chat_message fan-out until their next reconnect")
	}
}

// OC-0067: same gap on the edit path — a chat_edited must still reach the
// other participant even when the editor's connection drops after the DB
// write commits.
func TestEditMessage_DMFanoutSurvivesEditorDisconnectAfterCommit(t *testing.T) {
	database, permSvc := newDMFixture(t)
	plainSvc := NewMessageService(database, permSvc, nil)

	sent, err := plainSvc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "original",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	svc := NewMessageService(disconnectAfterWriteStore{Store: database, cancel: cancel}, permSvc, nil)

	editResult, err := svc.EditMessage(ctx, 1, sent.MessageID, "edited content")
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	if len(editResult.ParticipantIDs) == 0 {
		t.Fatal("ParticipantIDs empty after an editor disconnect that raced the post-commit DM lookup — " +
			"the other participant never sees the edit live")
	}
}

// OC-0068: same gap on the delete path — a chat_deleted must still reach the
// other participant even when the deleter's connection drops after the
// soft-delete commits.
func TestDeleteMessage_DMFanoutSurvivesDeleterDisconnectAfterCommit(t *testing.T) {
	database, permSvc := newDMFixture(t)
	plainSvc := NewMessageService(database, permSvc, nil)

	sent, err := plainSvc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "delete me",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	svc := NewMessageService(disconnectAfterWriteStore{Store: database, cancel: cancel}, permSvc, nil)

	delResult, err := svc.DeleteMessage(ctx, 1, sent.MessageID)
	if err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
	if len(delResult.ParticipantIDs) == 0 {
		t.Fatal("ParticipantIDs empty after a deleter disconnect that raced the post-commit DM lookup — " +
			"the other participant never sees the delete live")
	}
}

// erroringGetChannelStore fails GetChannel for exactly one channel id,
// modeling a transient DB hiccup on that lookup alone.
type erroringGetChannelStore struct {
	Store
	failFor int64
}

func (s erroringGetChannelStore) GetChannel(ctx context.Context, id int64) (*db.Channel, error) {
	if id == s.failFor {
		return nil, errors.New("simulated transient GetChannel failure")
	}
	return s.Store.GetChannel(ctx, id)
}

// OC-0074: a GetChannel failure inside EditMessage must not fail OPEN into
// the non-DM permission branch — that branch passes on the base role mask
// (SEND_MESSAGES|READ_MESSAGES) with no per-channel override to stop it,
// skipping both the DM-participant check and the block gate entirely.
func TestEditMessage_FailsClosedWhenChannelLookupErrors(t *testing.T) {
	database, permSvc := newDMFixture(t)
	plainSvc := NewMessageService(database, permSvc, nil)

	sent, err := plainSvc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	seedBlock(t, database, 2, 1) // bob blocks alice

	svc := NewMessageService(erroringGetChannelStore{Store: database, failFor: 50}, permSvc, nil)

	if _, err := svc.EditMessage(context.Background(), 1, sent.MessageID, "slipped past the block"); err == nil {
		t.Fatal("EditMessage succeeded despite a failed channel lookup and an active block — " +
			"a GetChannel error must fail closed, not fall through to the non-DM permission path")
	}
	msg, err := database.GetMessage(context.Background(), sent.MessageID)
	if err != nil || msg == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg.Content != "hi bob" {
		t.Fatalf("content must survive the refused edit, got %q", msg.Content)
	}
}

// OC-0077: DeleteMessage must refuse to mutate a message in an archived
// channel, mirroring the SendMessage gate (message_crud.go:54).
func TestDeleteMessage_RefusedInArchivedChannel(t *testing.T) {
	svc, database := newTestMessageService(t)
	ctx := context.Background()

	sent, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: "delete me",
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	if _, err := database.ExecContext(ctx, `UPDATE channels SET archived = 1 WHERE id = 10`); err != nil {
		t.Fatalf("archive channel: %v", err)
	}

	if _, err := svc.DeleteMessage(ctx, 1, sent.MessageID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("DeleteMessage in an archived channel: err = %v, want ErrForbidden", err)
	}

	msg, err := database.GetMessage(ctx, sent.MessageID)
	if err != nil || msg == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg.Deleted {
		t.Fatal("message must survive a delete attempt against an archived channel")
	}
}

// OC-0106: OpenDM is INSERT OR IGNORE and SendMessage used to append every
// recipient to OpenedDMFor unconditionally, so a DM that is already open
// still re-emits dm_channel_open (and bumps the hub's global visibility
// watermark) on every single message. Once a DM is open for a recipient, a
// second send must not report it as freshly opened.
func TestSendMessage_DoesNotReopenAlreadyOpenDM(t *testing.T) {
	database, permSvc := newDMFixture(t)
	svc := NewMessageService(database, permSvc, nil)
	ctx := context.Background()

	first, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "first",
	})
	if err != nil {
		t.Fatalf("first send: %v", err)
	}
	if len(first.OpenedDMFor) != 1 || first.OpenedDMFor[0] != 2 {
		t.Fatalf("first send OpenedDMFor = %v, want [2] (bob's first open)", first.OpenedDMFor)
	}

	second, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "second",
	})
	if err != nil {
		t.Fatalf("second send: %v", err)
	}
	if len(second.OpenedDMFor) != 0 {
		t.Fatalf("second send OpenedDMFor = %v, want [] — the DM was already open for bob, "+
			"so re-reporting it forces a redundant dm_channel_open and a global visibility-watermark bump "+
			"for every other connected client's next reconnect", second.OpenedDMFor)
	}
}
