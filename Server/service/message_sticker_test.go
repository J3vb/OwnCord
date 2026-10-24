package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

func (f *forwardFixture) seedSticker(t *testing.T, name string) *db.Sticker {
	t.Helper()
	st, err := f.database.CreateSticker(context.Background(), name, nil, "file-"+name, "image/png", fwdAlice)
	if err != nil {
		t.Fatalf("seed sticker: %v", err)
	}
	return st
}

func (f *forwardFixture) stickerParams(user, channel, stickerID int64) SendMessageParams {
	return SendMessageParams{
		ClientMessageID: newClientMessageID(), ChannelID: channel, UserID: user,
		Username: seedUsername(user), StickerID: stickerID,
	}
}

func TestSendSticker_StoresFallbackAndRow(t *testing.T) {
	f := newForwardFixture(t, nil)
	st := f.seedSticker(t, "Wave")
	res, err := f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, fwdDstChan, st.ID))
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if res.Content != "[Sticker: Wave]" || res.Duplicate {
		t.Fatalf("result = %+v", res)
	}
	if res.Sticker == nil || res.Sticker.ID == nil || *res.Sticker.ID != st.ID || res.Sticker.Name != "Wave" ||
		res.Sticker.URL == nil || *res.Sticker.URL != StickerImageURL(st.ID) {
		t.Fatalf("sticker block = %+v", res.Sticker)
	}
	msg, err := f.database.GetMessage(context.Background(), res.MessageID)
	if err != nil || msg == nil || msg.Content != "[Sticker: Wave]" {
		t.Fatalf("stored message = %+v, %v", msg, err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_stickers WHERE message_id = ? AND sticker_id = ? AND name = 'Wave'`, res.MessageID, st.ID); n != 1 {
		t.Errorf("message_stickers rows = %d, want 1", n)
	}
	// History carries the block.
	msgs, _, err := f.svc.GetMessages(context.Background(), fwdBob, fwdDstChan, 0, 10)
	if err != nil || len(msgs) != 1 || msgs[0].Sticker == nil || msgs[0].Sticker.Name != "Wave" || msgs[0].Sticker.ID == nil {
		t.Fatalf("history = %+v, %v", msgs, err)
	}
}

func TestSendSticker_RetryIsOneMessage(t *testing.T) {
	f := newForwardFixture(t, nil)
	st := f.seedSticker(t, "Wave")
	p := f.stickerParams(fwdBob, fwdDstChan, st.ID)
	first, err := f.svc.SendMessage(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.svc.SendMessage(context.Background(), p)
	if err != nil || !again.Duplicate || again.MessageID != first.MessageID {
		t.Fatalf("retry = %+v, %v; want a duplicate of %d", again, err, first.MessageID)
	}
	// The same id for a different sticker is a conflict, not a silent ack.
	other := f.seedSticker(t, "Other")
	p.StickerID = other.ID
	if _, err := f.svc.SendMessage(context.Background(), p); !errors.Is(err, ErrConflict) {
		t.Errorf("reused client_message_id for another sticker = %v, want ErrConflict", err)
	}
}

func TestSendSticker_ShapeIsRefused(t *testing.T) {
	f := newForwardFixture(t, nil)
	st := f.seedSticker(t, "Wave")
	tests := []struct {
		name   string
		mutate func(*SendMessageParams)
	}{
		{"with content", func(p *SendMessageParams) { p.Content = "hello" }},
		{"with attachments", func(p *SendMessageParams) { p.AttachmentIDs = []string{"abc"} }},
		{"without client_message_id", func(p *SendMessageParams) { p.ClientMessageID = "" }},
		{"negative id", func(p *SendMessageParams) { p.StickerID = -3 }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := f.stickerParams(fwdBob, fwdDstChan, st.ID)
			tc.mutate(&p)
			if _, err := f.svc.SendMessage(context.Background(), p); !errors.Is(err, ErrBadRequest) {
				t.Fatalf("err = %v, want ErrBadRequest", err)
			}
		})
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_stickers`); n != 0 {
		t.Errorf("a refused send left %d sticker rows", n)
	}
}

func TestSendSticker_UnknownStickerIsAClearError(t *testing.T) {
	f := newForwardFixture(t, nil)
	_, err := f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, fwdDstChan, 4242))
	if !errors.Is(err, ErrStickerNotFound) || !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrStickerNotFound wrapping ErrNotFound", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, fwdDstChan); n != 0 {
		t.Errorf("a refused send stored %d messages", n)
	}
}

// Edge case (a): a sticker deleted while a member still has it in the picker.
func TestSendSticker_DeletedStickerIsRefusedAndOldMessageKeepsItsName(t *testing.T) {
	f := newForwardFixture(t, nil)
	st := f.seedSticker(t, "Wave")
	sent, err := f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, fwdDstChan, st.ID))
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := f.database.DeleteSticker(context.Background(), st.ID); err != nil || !ok {
		t.Fatalf("DeleteSticker = %v, %v", ok, err)
	}

	_, err = f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, fwdDstChan, st.ID))
	if !errors.Is(err, ErrStickerNotFound) {
		t.Fatalf("send of a deleted sticker = %v, want ErrStickerNotFound", err)
	}

	msgs, _, err := f.svc.GetMessages(context.Background(), fwdBob, fwdDstChan, 0, 10)
	if err != nil || len(msgs) != 1 || msgs[0].ID != sent.MessageID {
		t.Fatalf("history = %+v, %v", msgs, err)
	}
	s := msgs[0].Sticker
	if s == nil || s.Name != "Wave" || s.ID != nil || s.URL != nil {
		t.Fatalf("sticker block after delete = %+v, want name kept and id/url null", s)
	}
	if msgs[0].Content != "[Sticker: Wave]" {
		t.Errorf("content = %q", msgs[0].Content)
	}
}

func TestSendSticker_StillGatedByTheSendChecks(t *testing.T) {
	f := newForwardFixture(t, nil)
	st := f.seedSticker(t, "Wave")
	if _, err := f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, fwdNoSendChan, st.ID)); !errors.Is(err, ErrForbidden) {
		t.Errorf("send without SEND_MESSAGES = %v, want ErrForbidden", err)
	}
	if _, err := f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, fwdArchived, st.ID)); err == nil {
		t.Error("send into an archived channel succeeded")
	}
	if _, err := f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, 9999, st.ID)); !errors.Is(err, ErrNotFound) {
		t.Errorf("send into a missing channel = %v, want ErrNotFound", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_stickers`); n != 0 {
		t.Errorf("refused sends left %d sticker rows", n)
	}
}

func TestSendSticker_ReplyAndDMAreAllowed(t *testing.T) {
	f := newForwardFixture(t, nil)
	st := f.seedSticker(t, "Wave")
	p := f.stickerParams(fwdBob, fwdDstChan, st.ID)
	parent, err := f.svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: fwdDstChan, UserID: fwdAlice, Username: seedUsername(fwdAlice), Content: "parent",
	})
	if err != nil {
		t.Fatal(err)
	}
	p.ReplyTo = &parent.MessageID
	if _, err := f.svc.SendMessage(context.Background(), p); err != nil {
		t.Fatalf("sticker reply: %v", err)
	}
	dm, err := f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, fwdDM, st.ID))
	if err != nil || !dm.IsDM || dm.Sticker == nil {
		t.Fatalf("sticker in a DM = %+v, %v", dm, err)
	}
}

func TestSendSticker_SlowModeApplies(t *testing.T) {
	f := newForwardFixture(t, auth.NewRateLimiter())
	st := f.seedSticker(t, "Wave")
	if _, err := f.database.ExecContext(context.Background(), `UPDATE channels SET slow_mode = 60 WHERE id = ?`, fwdDstChan); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, fwdDstChan, st.ID)); err != nil {
		t.Fatalf("first sticker: %v", err)
	}
	if _, err := f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, fwdDstChan, st.ID)); !errors.Is(err, ErrSlowMode) {
		t.Errorf("second sticker inside the slow-mode window = %v, want ErrSlowMode", err)
	}
}

func TestEditAndForward_RefuseAStickerMessage(t *testing.T) {
	f := newForwardFixture(t, nil)
	st := f.seedSticker(t, "Wave")
	sent, err := f.svc.SendMessage(context.Background(), f.stickerParams(fwdBob, fwdDstChan, st.ID))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.EditMessage(context.Background(), fwdBob, sent.MessageID, "now text"); !errors.Is(err, ErrBadRequest) {
		t.Errorf("EditMessage on a sticker message = %v, want ErrBadRequest", err)
	}
	msg, _ := f.database.GetMessage(context.Background(), sent.MessageID)
	if msg == nil || msg.Content != "[Sticker: Wave]" || msg.EditedAt != nil {
		t.Errorf("message after a refused edit = %+v", msg)
	}
	if _, err := f.forwardAs(fwdBob, newClientMessageID(), fwdSrcChan, sent.MessageID); !errors.Is(err, ErrBadRequest) {
		t.Errorf("forward of a sticker message = %v, want ErrBadRequest", err)
	}
}
