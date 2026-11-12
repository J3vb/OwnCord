package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// sendMessagePrecheck runs every gate a new send must clear before anything is written and returns the
// resolved channel and sanitized content.
func (s *MessageService) sendMessagePrecheck(ctx context.Context, p SendMessageParams) (*db.Channel, string, error) {
	if p.StickerID != 0 {
		if err := s.validateStickerSend(p); err != nil {
			return nil, "", err
		}
	}
	ch, err := lookupChannel(ctx, s.st, p.ChannelID)
	if err != nil {
		return nil, "", err
	}

	isDM := ch.Type == "dm"

	// Also refuses a write against an archived channel (requireChannelWritable, message_perms.go).
	if err := s.checkSendPermission(ctx, p.UserID, ch); err != nil {
		return nil, "", err
	}

	if p.StickerID != 0 {
		// No text or attachments to gate: content is filled from the sticker once it is looked up.
		return ch, "", nil
	}

	content, err := sanitizeContent(p.Content, len(p.AttachmentIDs) > 0)
	if err != nil {
		return nil, "", err
	}

	if !isDM && len(p.AttachmentIDs) > 0 {
		if !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.AttachFiles) {
			return nil, "", fmt.Errorf("%w: missing ATTACH_FILES permission", ErrForbidden)
		}
	}

	return ch, content, nil
}
