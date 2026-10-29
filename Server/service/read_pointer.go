package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// ReadPointer and ReadPointerOp re-export the db shapes so ws callers stay off
// the db package.
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
// Admission is the one channel_focus uses (admitReadState), except that a
// thread is admitted too (admitReadPointer): a missing channel is ErrNotFound,
// lost access or an archived channel ErrForbidden. messageID
// must be positive for db.ReadUpTo and db.MarkUnread (ErrBadRequest otherwise);
// db.ReadAtLatest ignores it. A message that is not a live message of the
// channel is ErrNotFound (still wrapping db.ErrNotFound) for db.MarkUnread.
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
	ch, err := admitReadPointer(ctx, s.st, s.perms, userID, channelID)
	if err != nil {
		return db.ReadPointer{}, err
	}
	// A forum holds no messages, so it has no read state to move: mark_read and
	// mark_unread on one write no read_states row, as channel_focus does. The
	// answer is NOT_FOUND (mark_read drops it silently, mark_unread reports it).
	if ch.Type == db.ForumTypeName {
		return db.ReadPointer{}, fmt.Errorf("%w: a forum holds no messages, so it has no read state", ErrNotFound)
	}

	// The wait for the lock honours ctx: the mention worker holds it across a
	// write on its own lifecycle context, so a stalled write there must end this
	// call at the caller's deadline instead of parking the read goroutine.
	if err := syncutil.LockContext(ctx, &s.mentionEmitMu); err != nil {
		return db.ReadPointer{}, fmt.Errorf("move read pointer: %w", err)
	}
	defer s.mentionEmitMu.Unlock()

	// Read-at-latest fires on every refocus and "Mark as Read" click, and a
	// transaction occupies the single writer even when it changes nothing.
	// Same skip as HandleChannelFocus: when the reader pool already
	// shows the pointer at the newest live message and no mentions, answer
	// from those reads without a transaction. A failed read falls through to
	// the write, which is the load-bearing half. The check runs under
	// mentionEmitMu like the write, so no increment can commit between the
	// reads and the frame, and no mention_count frame can overtake it.
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

// readAtLatestIsCurrent reports whether the stored row already says "read at
// the newest live message, no mentions", and if so the ReadPointer the write
// path would return: nothing is unread past the newest live message.
func (s *MessageService) readAtLatestIsCurrent(ctx context.Context, userID, channelID int64) (db.ReadPointer, bool) {
	latestID, err := s.st.GetLatestMessageID(ctx, channelID)
	if err != nil {
		return db.ReadPointer{}, false
	}
	lastRead, mentions, found, err := s.st.GetReadState(ctx, userID, channelID)
	if err != nil || !found || lastRead != latestID || mentions != 0 {
		return db.ReadPointer{}, false
	}
	// A message that committed between the two reads would make the stale
	// latestID look current; re-read it and fall through to the write if it moved.
	if again, err := s.st.GetLatestMessageID(ctx, channelID); err != nil || again != latestID {
		return db.ReadPointer{}, false
	}
	return db.ReadPointer{LastReadMessageID: lastRead}, true
}

// admitReadPointer is admitReadState for the commands that move a read pointer
// without focusing (mark_read, mark_unread). Those never touch the socket's
// focus slot, so a thread is admitted through its parent like thread_focus
// does: the thread panel and the sidebar row mark a thread read.
func admitReadPointer(ctx context.Context, st Store, perms *PermissionService, userID, channelID int64) (*db.Channel, error) {
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
