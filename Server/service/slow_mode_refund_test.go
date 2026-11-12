package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// deliveryFaultStore fails CreateMessageDelivery with fail while it is set, and
// with commitFirst set it commits the delivery itself first, so the real call
// that follows finds the receipt and reports a duplicate (an identical attempt
// that won the write).
type deliveryFaultStore struct {
	Store
	fail        error
	commitFirst bool
}

func (s *deliveryFaultStore) CreateMessageDelivery(ctx context.Context, p db.MessageDeliveryParams) (*db.MessageDelivery, error) {
	if s.fail != nil {
		return nil, s.fail
	}
	if s.commitFirst {
		if _, err := s.Store.CreateMessageDelivery(ctx, p); err != nil {
			return nil, err
		}
	}
	return s.Store.CreateMessageDelivery(ctx, p)
}

const slowModeSeconds = 3600

func slowSendParams(user, channel int64) SendMessageParams {
	return SendMessageParams{
		ChannelID: channel, UserID: user, Username: seedUsername(user), Content: "hi",
		ClientMessageID: newClientMessageID(),
	}
}

func newSlowModeSendService(t *testing.T) (*MessageService, *deliveryFaultStore) {
	t.Helper()
	_, database := newTestMessageService(t)
	mustDo(t, "SetChannelSlowMode", database.SetChannelSlowMode(context.Background(), 10, slowModeSeconds))
	_, err := database.ExecContext(context.Background(),
		`UPDATE roles SET permissions = permissions | ? WHERE id = ?`, permissions.AttachFiles, permissions.MemberRoleID)
	mustDo(t, "grant attach", err)
	st := &deliveryFaultStore{Store: database}
	return NewMessageService(st, NewPermissionService(database, permissions.NewChecker(database)), auth.NewRateLimiter()), st
}

// A send whose uploads are all unavailable posts nothing, so the member can send
// again at once, with and without a client message id.
func TestSendMessage_SlowModeTokenReturnedWhenAllAttachmentsUnavailable(t *testing.T) {
	for _, keyed := range []bool{true, false} {
		svc, _ := newSlowModeSendService(t)
		p := slowSendParams(1, 10)
		p.Content, p.AttachmentIDs = "", []string{"00000000-0000-4000-8000-000000000001"}
		if !keyed {
			p.ClientMessageID = ""
		}
		if _, err := svc.SendMessage(context.Background(), p); err == nil {
			t.Fatalf("keyed=%v: attachment-only send with an unavailable upload was accepted", keyed)
		}
		if _, err := svc.SendMessage(context.Background(), slowSendParams(1, 10)); err != nil {
			t.Fatalf("keyed=%v: valid send right after a refused send: %v", keyed, err)
		}
	}
}

// A write that fails after the gate returns the token; a write that succeeds keeps
// it, so the next send is refused.
func TestSendMessage_SlowModeRefundedOnWriteFailureOnly(t *testing.T) {
	svc, st := newSlowModeSendService(t)
	st.fail = errors.New("writer busy")
	p := slowSendParams(1, 10)
	if _, err := svc.SendMessage(context.Background(), p); !errors.Is(err, ErrInternal) {
		t.Fatalf("failing write: err = %v, want ErrInternal", err)
	}
	st.fail = nil
	if _, err := svc.SendMessage(context.Background(), p); err != nil {
		t.Fatalf("retry after the failed write: %v", err)
	}
	if _, err := svc.SendMessage(context.Background(), slowSendParams(1, 10)); !errors.Is(err, ErrSlowMode) {
		t.Fatalf("send after a posted one: err = %v, want ErrSlowMode", err)
	}
}

// An identical attempt that won the write holds its own token; the duplicate must
// not leave a second charge behind.
func TestSendMessage_SlowModeNotChargedTwiceForDuplicate(t *testing.T) {
	svc, st := newSlowModeSendService(t)
	st.commitFirst = true
	res, err := svc.SendMessage(context.Background(), slowSendParams(1, 10))
	if err != nil || !res.Duplicate {
		t.Fatalf("send = %+v, %v; want a duplicate", res, err)
	}
	st.commitFirst = false
	if _, err := svc.SendMessage(context.Background(), slowSendParams(1, 10)); err != nil {
		t.Fatalf("send after a duplicate: %v (the duplicate kept a token)", err)
	}
}

// eachRefundCase runs try under a failing write and under a send an identical attempt
// already committed: neither may post, and the same call right after must pass.
func eachRefundCase(t *testing.T, st *deliveryFaultStore, try func(tag string) (posted bool, err error), reset func()) {
	t.Helper()
	for name, set := range map[string]func(){
		"write failure": func() { st.fail, st.commitFirst = errors.New("writer busy"), false },
		"duplicate":     func() { st.fail, st.commitFirst = nil, true },
	} {
		set()
		if posted, _ := try("t-" + name); posted {
			t.Fatalf("%s: the send was posted", name)
		}
		st.fail, st.commitFirst = nil, false
		if _, err := try("u-" + name); err != nil {
			t.Fatalf("%s: the same send right after: %v", name, err)
		}
		reset()
	}
}

// slowModeForwardFixture is a forward fixture whose target channel is in slow mode and
// whose store can fail or pre-commit a write.
func slowModeForwardFixture(t *testing.T) (*forwardFixture, *deliveryFaultStore, func()) {
	t.Helper()
	limiter := auth.NewRateLimiter()
	f := newForwardFixture(t, limiter)
	mustDo(t, "SetChannelSlowMode", f.database.SetChannelSlowMode(context.Background(), fwdDstChan, slowModeSeconds))
	st := &deliveryFaultStore{Store: f.database}
	f.svc.st = st
	return f, st, func() { limiter.Reset(context.Background(), auth.Key(auth.Key("slow", fwdBob), fwdDstChan)) }
}

func TestCreatePoll_SlowModeRefundedOnWriteFailureAndDuplicate(t *testing.T) {
	f, st, reset := slowModeForwardFixture(t)
	eachRefundCase(t, st, func(string) (bool, error) {
		res, err := f.svc.CreatePoll(context.Background(), f.pollParams(fwdBob, fwdDstChan))
		return err == nil && !res.Duplicate, err
	}, reset)
}

func TestForwardMessage_SlowModeRefundedOnWriteFailureAndDuplicate(t *testing.T) {
	f, st, reset := slowModeForwardFixture(t)
	eachRefundCase(t, st, func(string) (bool, error) {
		res, err := f.svc.ForwardMessage(context.Background(), ForwardParams{
			ClientMessageID: newClientMessageID(), UserID: fwdBob, Username: "bob",
			TargetChannelID: fwdDstChan, SourceMessageID: f.srcID,
		})
		return err == nil && !res.Duplicate, err
	}, reset)
}

func TestCreateForumPost_SlowModeRefundedOnWriteFailureAndDuplicate(t *testing.T) {
	f := newForumPostFixture(t)
	mustDo(t, "SetChannelSlowMode", f.database.SetChannelSlowMode(context.Background(), frmForum, slowModeSeconds))
	st := &deliveryFaultStore{Store: f.database}
	f.limited.st = st
	eachRefundCase(t, st, func(tag string) (bool, error) {
		res, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, tag, "c"))
		return err == nil && res != nil && !res.Duplicate, err
	}, func() { f.limited.limiter.Reset(context.Background(), auth.Key(auth.Key("slow", thrOwner), frmForum)) })
}
