package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// errStickerNotFound is the answer for a sticker send that names a sticker that
// does not exist, or no longer does. It satisfies errors.Is for both
// ErrNotFound and ErrStickerNotFound (the precise wire code).
func errStickerNotFound() error {
	return fmt.Errorf("%w: %w: that sticker no longer exists", ErrNotFound, ErrStickerNotFound)
}

// stickerFallback is the text a sticker message stores as its content, so
// search, push and older clients still read something.
func stickerFallback(name string) string {
	return "[Sticker: " + name + "]"
}

// validateStickerSend checks the shape of a sticker send before anything is
// read: no text, no attachments, and a client_message_id (the sticker row
// commits with the message and its receipt, as a poll's rows do).
func (s *MessageService) validateStickerSend(p SendMessageParams) error {
	if s.sticker == nil {
		return fmt.Errorf("%w: stickers are not available", ErrInternal)
	}
	if p.StickerID < 0 {
		return fmt.Errorf("%w: sticker_id must be a positive integer", ErrBadRequest)
	}
	if p.Content != "" || len(p.AttachmentIDs) > 0 {
		return fmt.Errorf("%w: a sticker message cannot carry text or attachments", ErrBadRequest)
	}
	if p.ClientMessageID == "" {
		return fmt.Errorf("%w: client_message_id is required to send a sticker", ErrBadRequest)
	}
	return nil
}

// resolveSticker looks the sticker up and returns the reference the message
// row is written with and the fallback content. A missing sticker is
// ErrStickerNotFound.
func (s *MessageService) resolveSticker(ctx context.Context, p SendMessageParams) (*db.StickerRef, string, error) {
	st, err := s.sticker.GetSticker(ctx, p.StickerID)
	if err != nil {
		return nil, "", fmt.Errorf("%w: failed to load sticker: %w", ErrInternal, err)
	}
	if st == nil {
		return nil, "", errStickerNotFound()
	}
	return &db.StickerRef{ID: st.ID, Name: st.Name}, stickerFallback(st.Name), nil
}

// refuseStickerMessage returns ErrBadRequest wrapping reason when msgID is a
// sticker message. A nil sticker store means no message can be one.
func (s *MessageService) refuseStickerMessage(ctx context.Context, msgID int64, reason string) error {
	if s.sticker == nil {
		return nil
	}
	info, err := s.sticker.GetMessageSticker(ctx, msgID)
	if err != nil {
		return fmt.Errorf("%w: read message sticker: %w", ErrInternal, err)
	}
	if info != nil {
		return fmt.Errorf("%w: %s", ErrBadRequest, reason)
	}
	return nil
}
