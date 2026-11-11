package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// ReadPointer and ReadPointerOp re-export the db shapes so ws callers stay off the db package.
type (
	ReadPointer   = db.ReadPointer
	ReadPointerOp = db.ReadPointerOp
)

// The read-pointer moves MoveReadPointer accepts.
const (
	ReadAtLatest = db.ReadAtLatest
	ReadUpTo     = db.ReadUpTo
	MarkUnread   = db.MarkUnread
)

// ReadStateNotifier delivers a read_state frame to the one reader whose read pointer just moved.
type ReadStateNotifier interface {
	NotifyReadState(userID, channelID int64, rs db.ReadPointer)
}

// SetReadStateNotifier installs the read_state hook; nil leaves it off.
func (s *MessageService) SetReadStateNotifier(n ReadStateNotifier) {
	s.readStateNotifier = n
}

// MoveReadPointer moves userID's read pointer in channelID and tells them the result. Admission is
// channel_focus's (admitReadState) except that a thread is admitted too (admitReadPointer): a missing channel
// is ErrNotFound, lost access or an archived channel ErrForbidden. messageID must be positive for db.ReadUpTo
// and db.MarkUnread (ErrBadRequest otherwise); for MarkUnread a message that is not a live message of the
// channel is ErrNotFound. Lock order: the channel's mention emit lock, then the database writer, then the
// hub's per-client send (as reverseMentionCounts). It is held across the write and the frame so a
// mention_count frame from the worker or a removal cannot overtake this read_state frame. Never taken under a
// hub lock. On failure no frame is sent.
func (s *mentionState) MoveReadPointer(ctx context.Context, userID, channelID int64, op db.ReadPointerOp, messageID int64) (db.ReadPointer, error) {
	if channelID <= 0 {
		return db.ReadPointer{}, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	if op != db.ReadAtLatest && messageID <= 0 {
		return db.ReadPointer{}, fmt.Errorf("%w: message_id must be positive", ErrBadRequest)
	}
	ch, err := admitReadPointer(ctx, s.st, s.perms, userID, channelID)
	if err != nil {
		return db.ReadPointer{}, err
	}
	// A forum holds no messages, so no read state: mark_read and mark_unread on one write no row, as
	// channel_focus does; NOT_FOUND (mark_read drops it silently, mark_unread reports it).
	if ch.Type == db.ForumTypeName {
		return db.ReadPointer{}, fmt.Errorf("%w: a forum holds no messages, so it has no read state", ErrNotFound)
	}

	// The lock wait honours ctx: the mention worker holds it across a write on its own lifecycle context, so a
	// stalled write must end this call at the caller's deadline.
	mu := s.mentionEmitLocks.forChannel(channelID)
	if err := syncutil.LockContext(ctx, mu); err != nil {
		return db.ReadPointer{}, fmt.Errorf("move read pointer: %w", err)
	}
	defer mu.Unlock()

	// Read-at-latest fires on every refocus and "Mark as Read" click, and a transaction occupies the single
	// writer even when it changes nothing. As in HandleChannelFocus: when the reader pool shows the pointer at
	// the newest live message and no mentions, answer without a transaction (under the emit lock, so no
	// increment can commit in between). A failed read falls through to the write.
	if op == db.ReadAtLatest {
		if rs, ok := s.readAtLatestIsCurrent(ctx, userID, channelID); ok {
			if s.readStateNotifier != nil {
				s.readStateNotifier.NotifyReadState(userID, channelID, rs)
			}
			return rs, nil
		}
	}

	rs, err := s.st.MoveReadPointer(ctx, userID, channelID, op, messageID)
	if errors.Is(err, db.ErrNotFound) {
		return db.ReadPointer{}, fmt.Errorf("move read pointer: %w: %w", ErrNotFound, err)
	}
	if err != nil {
		return db.ReadPointer{}, fmt.Errorf("move read pointer: %w", err)
	}
	if s.readStateNotifier != nil {
		s.readStateNotifier.NotifyReadState(userID, channelID, rs)
	}
	return rs, nil
}

// readAtLatestIsCurrent reports whether the stored row already says "read at the newest live message, no
// mentions" and, if so, the ReadPointer the write would return.
func (s *mentionState) readAtLatestIsCurrent(ctx context.Context, userID, channelID int64) (db.ReadPointer, bool) {
	latestID, err := s.st.GetLatestMessageID(ctx, channelID)
	if err != nil {
		return db.ReadPointer{}, false
	}
	lastRead, mentions, found, err := s.st.GetReadState(ctx, userID, channelID)
	if err != nil || !found || lastRead != latestID || mentions != 0 {
		return db.ReadPointer{}, false
	}
	// A message committed between the two reads would make the stale latestID look current; re-read it and fall
	// through to the write if it moved.
	if again, err := s.st.GetLatestMessageID(ctx, channelID); err != nil || again != latestID {
		return db.ReadPointer{}, false
	}
	return db.ReadPointer{LastReadMessageID: lastRead}, true
}

// admitReadPointer is admitReadState for commands that move a pointer without focusing: a thread is admitted
// through its parent, as thread_focus does.
func admitReadPointer(ctx context.Context, st readAdmitStore, perms *PermissionService, userID, channelID int64) (*db.Channel, error) {
	ch, err := st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if !ch.IsThread() {
		return admitReadState(ctx, st, perms, userID, channelID)
	}
	sub, subErr := channelSubject(ctx, st, perms, userID, ch, false)
	if subErr != nil {
		return nil, fmt.Errorf("%w: access denied", ErrForbidden)
	}
	if err := permissions.CanAdmitSession(sub); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrForbidden, err)
	}
	return ch, nil
}
