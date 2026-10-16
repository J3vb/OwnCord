package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// ReadStateNotifier delivers a read_state frame to the one reader whose read
// pointer just moved. The hub installs it next to the mention-count notifier.
type ReadStateNotifier interface {
	NotifyReadState(userID, channelID int64, rs db.ReadPointer)
}

// SetReadStateNotifier installs the read_state hook; nil leaves it off.
func (s *MessageService) SetReadStateNotifier(n ReadStateNotifier) {
	s.readStateNotifier = n
}

// MoveReadPointer moves userID's read pointer in channelID and tells them the
// result. It lives on MessageService because it owns mentionEmitMu.
//
// Admission is the one channel_focus uses (admitReadState): a missing channel
// is ErrNotFound, lost access or an archived channel ErrForbidden. messageID
// must be positive for db.ReadUpTo and db.MarkUnread (ErrBadRequest otherwise);
// db.ReadAtLatest ignores it. A message that is not a live message of the
// channel is a db.ErrNotFound wrapped in the returned error for db.MarkUnread.
//
// Lock order: mentionEmitMu, then the database writer, then the hub's
// per-client send. It is the order reverseMentionCounts already uses. The lock
// is held across the write and the frame, so a mention_count frame from the
// worker or a removal cannot overtake this read_state frame, and the last frame
// a reader gets matches the committed row. It is never taken under a hub lock,
// and the caller runs on the read goroutine, not on dispatch. On failure no
// frame is sent.
func (s *MessageService) MoveReadPointer(ctx context.Context, userID, channelID int64, op db.ReadPointerOp, messageID int64) (db.ReadPointer, error) {
	if channelID <= 0 {
		return db.ReadPointer{}, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	if op != db.ReadAtLatest && messageID <= 0 {
		return db.ReadPointer{}, fmt.Errorf("%w: message_id must be positive", ErrBadRequest)
	}
	if _, err := admitReadState(ctx, s.st, s.perms, userID, channelID); err != nil {
		return db.ReadPointer{}, err
	}

	s.mentionEmitMu.Lock()
	defer s.mentionEmitMu.Unlock()
	rs, err := s.st.MoveReadPointer(ctx, userID, channelID, op, messageID)
	if err != nil {
		return db.ReadPointer{}, fmt.Errorf("move read pointer: %w", err)
	}
	if s.readStateNotifier != nil {
		s.readStateNotifier.NotifyReadState(userID, channelID, rs)
	}
	return rs, nil
}
