package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// AdmitThreadFocus is the gate for thread_focus (the second subscription slot): the id
// must be a thread and pass permissions.CanAdmitSession through its parent (overrides,
// NSFW, archive), so a user who cannot see the parent cannot attach to its thread.
func (s *ChannelService) AdmitThreadFocus(ctx context.Context, userID, threadID int64) (*db.Channel, error) {
	if threadID <= 0 {
		return nil, fmt.Errorf("%w: thread_id must be positive", ErrBadRequest)
	}
	ch, err := lookupChannel(ctx, s.st, threadID)
	if err != nil {
		return nil, err
	}
	if !ch.IsThread() {
		return nil, fmt.Errorf("%w: thread not found", ErrNotFound)
	}
	sub, subErr := channelSubject(ctx, s.st, s.perms, userID, ch, false)
	if subErr != nil {
		return nil, fmt.Errorf("%w: access denied", ErrForbidden)
	}
	if err := permissions.CanAdmitSession(sub); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrForbidden, err)
	}
	return ch, nil
}

// HandleThreadFocus admits the focus and marks the thread read at its latest message, as
// channel_focus does for a channel.
func (s *ChannelService) HandleThreadFocus(ctx context.Context, userID, threadID int64) (*db.Channel, error) {
	ch, err := s.AdmitThreadFocus(ctx, userID, threadID)
	if err != nil {
		return nil, err
	}
	s.markFocusedRead(ctx, userID, threadID)
	slog.Debug("thread_focus", "user_id", userID, "thread_id", threadID)
	return ch, nil
}
