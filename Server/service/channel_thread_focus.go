package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// AdmitThreadFocus is the gate for thread_focus, the second subscription slot:
// the id must be a thread, and the caller must pass
// permissions.CanAdmitSession for it. The subject resolves through the
// thread's parent (its overrides, NSFW and archive state), so a user who
// cannot see the parent cannot attach to its thread. It is admitReadState's
// twin for threads; admitReadState keeps refusing them for channel_focus.
func (s *ChannelService) AdmitThreadFocus(ctx context.Context, userID, threadID int64) (*db.Channel, error) {
	if threadID <= 0 {
		return nil, fmt.Errorf("%w: thread_id must be positive", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, threadID)
	if err != nil || ch == nil || !ch.IsThread() {
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

// HandleThreadFocus admits the focus and marks the thread read at its latest
// message, as channel_focus does for a channel.
func (s *ChannelService) HandleThreadFocus(ctx context.Context, userID, threadID int64) (*db.Channel, error) {
	ch, err := s.AdmitThreadFocus(ctx, userID, threadID)
	if err != nil {
		return nil, err
	}
	s.markFocusedRead(ctx, userID, threadID)
	slog.Debug("thread_focus", "user_id", userID, "thread_id", threadID)
	return ch, nil
}
