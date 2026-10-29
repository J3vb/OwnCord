package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// sendMessagePrecheck runs every gate a new send must clear before anything
// is written: channel lookup, send permission, content sanitization, and
// attachment permission. It returns the resolved channel and the sanitized
// content for the caller to persist.
func (s *MessageService) sendMessagePrecheck(ctx context.Context, p SendMessageParams) (*db.Channel, string, error) {
	if p.StickerID != 0 {
		if err := s.validateStickerSend(p); err != nil {
			return nil, "", err
		}
	}
	ch, err := s.st.GetChannel(ctx, p.ChannelID)
	if err != nil || ch == nil {
		return nil, "", fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	isDM := ch.Type == "dm"

	// Permission check. Also refuses a write against an archived channel — see
	// requireChannelWritable in message_perms.go, the shared gate every
	// message write sink routes through.
	if err := s.checkSendPermission(ctx, p.UserID, ch); err != nil {
		return nil, "", err
	}

	if p.StickerID != 0 {
		// No text to sanitize and no attachments to gate: the content is
		// filled in from the sticker once it is looked up.
		return ch, "", nil
	}

	// Validate and sanitize content.
	content, err := sanitizeContent(p.Content, len(p.AttachmentIDs) > 0)
	if err != nil {
		return nil, "", err
	}

	// Attachment permission (non-DM).
	if !isDM && len(p.AttachmentIDs) > 0 {
		if !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.AttachFiles) {
			return nil, "", fmt.Errorf("%w: missing ATTACH_FILES permission", ErrForbidden)
		}
	}

	return ch, content, nil
}
