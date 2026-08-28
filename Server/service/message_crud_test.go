package service

// Tests for the 2026-08-12/13 message_crud.go findings: the post-commit
// GetDMParticipantIDs fan-out gap on send/edit/delete (OC-0033, OC-0067,
// OC-0068), EditMessage's fail-open channel lookup (OC-0074), DeleteMessage's
// missing archived-channel gate (OC-0077), and SendMessage's redundant
// dm_channel_open re-opens (OC-0106).

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
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

// OC-0033 residual: the recipient's dm_open_state re-open must survive the
// sender's disconnect too — GetDMParticipantIDs was detached from ctx but the
// OpenDM loop was not, so a canceled request ctx silently skipped the re-open
// and the recipient's sidebar never learned the DM existed.
func TestSendMessage_DMReopenSurvivesSenderDisconnectAfterCommit(t *testing.T) {
	database, permSvc := newDMFixture(t)
	// Bob has closed the DM; this send must genuinely re-open it for him.
	if err := database.CloseDM(context.Background(), 2, 50); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	svc := NewMessageService(disconnectAfterWriteStore{Store: database, cancel: cancel}, permSvc, nil)

	result, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi bob",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(result.OpenedDMFor) != 1 || result.OpenedDMFor[0] != 2 {
		t.Fatalf("OpenedDMFor = %v, want [2] — OpenDM must run detached from the request ctx, "+
			"or a sender disconnect after commit leaves the DM invisible in the recipient's sidebar",
			result.OpenedDMFor)
	}
}

// Same fail-closed rule the edit path got (OC-0074): DeleteMessage must not
// fall open into the non-DM permission branch — and past the new archived
// gate (OC-0077) — when the channel lookup errors.
func TestDeleteMessage_FailsClosedWhenChannelLookupErrors(t *testing.T) {
	database, permSvc := newDMFixture(t)

	sendSvc := NewMessageService(database, permSvc, nil)
	sent, err := sendSvc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "to be deleted",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	svc := NewMessageService(erroringGetChannelStore{Store: database, failFor: 50}, permSvc, nil)
	if _, err := svc.DeleteMessage(context.Background(), 1, sent.MessageID); err == nil {
		t.Fatal("DeleteMessage succeeded despite a failed channel lookup — " +
			"a GetChannel error must fail closed, not fall through to the non-DM permission path")
	}
	msg, err := database.GetMessage(context.Background(), sent.MessageID)
	if err != nil || msg == nil {
		t.Fatalf("message must survive the refused delete; GetMessage: msg=%v err=%v", msg, err)
	}
}

// OC-0036: slow mode's cooldown token is spent by limiter.Allow, which must
// only run once the send has passed content/attachment validation. Consuming
// it earlier means a send that gets rejected for an unrelated reason (content
// too long, in this case) still locks the composer for the full slow-mode
// window even though nothing was ever posted.
func TestSendMessage_SlowModeNotConsumedByFailedContentValidation(t *testing.T) {
	_, database := newTestMessageService(t)
	if err := database.SetChannelSlowMode(context.Background(), 10, 3600); err != nil {
		t.Fatalf("SetChannelSlowMode: %v", err)
	}
	checker := permissions.NewChecker(database)
	permSvc := NewPermissionService(database, checker)
	svc := NewMessageService(database, permSvc, auth.NewRateLimiter())
	ctx := context.Background()

	overLong := strings.Repeat("a", maxMessageLen+1)
	if _, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: overLong,
	}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("over-length send: err = %v, want ErrBadRequest", err)
	}

	// The rejected send above must not have spent the once-per-hour slow-mode
	// token: a valid, short send immediately after should still go through.
	if _, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: "hi",
	}); err != nil {
		t.Fatalf("SendMessage right after a rejected over-length send: %v — slow mode must only be "+
			"charged once a send clears content/attachment validation, not before", err)
	}
}

// disconnectAfterLinkStore models a client whose connection drops the instant
// LinkAttachmentsToMessage commits — mirrors disconnectAfterWriteStore but for
// the attachment path. GetAttachmentsByMessageIDs is overridden to fail
// whenever handed an already-canceled context, so a test can tell whether the
// post-link attachment read used the (canceled) request ctx or a detached one.
type disconnectAfterLinkStore struct {
	Store
	cancel context.CancelFunc
}

func (s disconnectAfterLinkStore) LinkAttachmentsToMessage(ctx context.Context, messageID, uploaderID int64, attachmentIDs []string) (int64, error) {
	n, err := s.Store.LinkAttachmentsToMessage(ctx, messageID, uploaderID, attachmentIDs)
	s.cancel()
	return n, err
}

func (s disconnectAfterLinkStore) GetAttachmentsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]db.AttachmentInfo, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return s.Store.GetAttachmentsByMessageIDs(ctx, msgIDs)
}

// OC-0128: a sender whose connection drops the instant the attachment link
// commits must still get the linked attachment back on the broadcast result —
// not a message with no content and no attachments. The post-link read must
// run on a detached ctx, the same way the compensating deletes in SendMessage
// already do.
func TestSendMessage_AttachmentsSurviveSenderDisconnectAfterLink(t *testing.T) {
	_, database := newTestMessageService(t)
	// Grant ATTACH_FILES on top of the base member perms newTestMessageService seeds.
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions | permissions.AttachFiles,
		Position:    1,
	})
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO attachments (id, uploader_id, filename, stored_as, mime_type, size)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		"att-1", 1, "photo.png", "stored-photo.png", "image/png", 100,
	); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	checker := permissions.NewChecker(database)
	permSvc := NewPermissionService(database, checker)

	ctx, cancel := context.WithCancel(context.Background())
	svc := NewMessageService(disconnectAfterLinkStore{Store: database, cancel: cancel}, permSvc, nil)

	result, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", AttachmentIDs: []string{"att-1"},
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(result.Attachments) != 1 {
		t.Fatalf("Attachments = %v, want 1 — a disconnect right after the attachment link commits must not "+
			"broadcast a blank message bubble", result.Attachments)
	}
}
