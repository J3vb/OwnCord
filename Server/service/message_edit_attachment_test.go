package service

import (
	"context"
	"errors"
	"testing"
)

func TestEditMessage_EmptyTextKeptWhenAttachmentRemains(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	msgID, _ := f.sendWithFile(t, fwdBob, fwdDstChan, "caption", "0123456789")

	res, err := f.svc.EditMessage(ctx, fwdBob, msgID, "")
	if err != nil {
		t.Fatalf("EditMessage with an attachment: %v", err)
	}
	if res.Content != "" {
		t.Errorf("content = %q, want empty", res.Content)
	}
	msg, err := f.database.GetMessage(ctx, msgID)
	if err != nil || msg == nil || msg.Content != "" || msg.Deleted {
		t.Fatalf("stored message = %+v, %v; want live with no text", msg, err)
	}
}

func TestEditMessage_EmptyTextRefusedWithoutAttachment(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	msgID, fileID := f.sendWithFile(t, fwdBob, fwdDstChan, "caption", "0123456789")
	f.removeOwnUpload(ctx, t, fileID)

	_, err := f.svc.EditMessage(ctx, fwdBob, msgID, "")
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("err = %v, want ErrBadRequest", err)
	}
	msg, gErr := f.database.GetMessage(ctx, msgID)
	if gErr != nil || msg == nil || msg.Content != "caption" {
		t.Fatalf("stored message = %+v, %v; want the text untouched", msg, gErr)
	}
}
