package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Thread follows (migration 079): a follow is a notification and sidebar
// preference kept on the server, never permission. No gate reads it, and every
// read that hands a follow to a user is joined with what the parent lets them see.

// threadFollowWriteTimeout bounds a follow write, which runs detached from the
// frame's context once the gate has passed.
const threadFollowWriteTimeout = 5 * time.Second

// MaxFollowedThreads bounds the followed threads one ready payload carries.
const MaxFollowedThreads = db.MaxFollowedThreads

// FollowedThread is one followed open thread with the user's read position.
type FollowedThread = db.FollowedThread

// ThreadFollowStore is the follow persistence behind ThreadService. *db.DB
// satisfies it; a Store that does not leaves the follow operations answering
// ErrInternal. A slice interface for the same reason as ThreadStore.
type ThreadFollowStore interface {
	FollowThread(ctx context.Context, threadID, userID int64) (bool, error)
	UnfollowThread(ctx context.Context, threadID, userID int64) (bool, error)
	ListThreadFollowers(ctx context.Context, threadID int64) ([]int64, error)
	ListFollowedThreads(ctx context.Context, userID int64) ([]db.FollowedThread, error)
}

func (s *ThreadService) followStore() (ThreadFollowStore, error) {
	fs, ok := s.st.(ThreadFollowStore)
	if !ok || s.ts == nil {
		return nil, fmt.Errorf("%w: thread follow storage unavailable", ErrInternal)
	}
	return fs, nil
}

// SetFollow follows or unfollows a thread for userID and returns the thread; both
// are idempotent. The thread must be visible to the caller (thread_focus's gate);
// a locked or archived thread can still be (un)followed. An invisible thread is
// not found.
func (s *ThreadService) SetFollow(ctx context.Context, userID, threadID int64, follow bool) (*db.ThreadInfo, error) {
	fs, err := s.followStore()
	if err != nil {
		return nil, err
	}
	if threadID <= 0 {
		return nil, fmt.Errorf("%w: thread_id must be positive", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, threadID)
	if err != nil {
		return nil, fmt.Errorf("%w: load thread: %w", ErrInternal, err)
	}
	if ch == nil || !ch.IsThread() {
		return nil, fmt.Errorf("%w: thread not found", ErrNotFound)
	}
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, false)
	if err != nil {
		return nil, err
	}
	if permissions.CanViewChannel(sub) != nil {
		return nil, fmt.Errorf("%w: thread not found", ErrNotFound)
	}
	// The reply names the thread, disclosing its starter message, so an unacknowledged
	// member of an NSFW parent cannot follow it yet.
	if err := readContentDenial(permissions.CanReadContent(readSubject(ctx, s.st, s.perms, userID, ch))); err != nil {
		return nil, err
	}
	// Past the gate the write is committed work: a hang-up must not leave the
	// follow half applied from the caller's point of view.
	tail, cancel := context.WithTimeout(context.WithoutCancel(ctx), threadFollowWriteTimeout)
	defer cancel()
	if follow {
		_, err = fs.FollowThread(tail, threadID, userID)
	} else {
		_, err = fs.UnfollowThread(tail, threadID, userID)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: set thread follow: %w", ErrInternal, err)
	}
	info, err := s.ts.GetThread(tail, threadID)
	if err != nil {
		return nil, fmt.Errorf("%w: load thread: %w", ErrInternal, err)
	}
	if info == nil {
		return nil, fmt.Errorf("%w: thread not found", ErrNotFound)
	}
	slog.Debug("thread follow set", "user_id", userID, "thread_id", threadID, "follow", follow)
	return info, nil
}

// Followers returns a thread's followers with no permission check: for the
// hub, which intersects them with the parent's audience before sending
// anything.
func (s *ThreadService) Followers(ctx context.Context, threadID int64) ([]int64, error) {
	fs, err := s.followStore()
	if err != nil {
		return nil, err
	}
	ids, err := fs.ListThreadFollowers(ctx, threadID)
	if err != nil {
		return nil, fmt.Errorf("%w: list thread followers: %w", ErrInternal, err)
	}
	return ids, nil
}

// Followed returns userID's followed open threads, newest activity first, for the
// ready payload, at most MaxFollowedThreads. readableParents is the set of channels
// the socket can read; a thread whose parent is outside it is left out (membership
// is not permission, and the row stays so regaining access brings it back).
func (s *ThreadService) Followed(ctx context.Context, userID int64, readableParents map[int64]struct{}) ([]db.FollowedThread, error) {
	fs, err := s.followStore()
	if err != nil {
		return nil, err
	}
	rows, err := fs.ListFollowedThreads(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: list followed threads: %w", ErrInternal, err)
	}
	out := rows[:0]
	for i := range rows {
		if _, ok := readableParents[rows[i].Thread.ParentID]; !ok {
			continue
		}
		out = append(out, rows[i])
		if len(out) == MaxFollowedThreads {
			break
		}
	}
	return out, nil
}

// DeleteNotifying is Delete that also returns the thread's followers as they
// were just before it went, so the hub can tell each of them it is gone (the
// delete cascades the rows). A failed follower read is logged and yields none:
// those clients drop the thread at their next ready.
func (s *ThreadService) DeleteNotifying(ctx context.Context, userID, threadID int64) (info *db.ThreadInfo, followers []int64, err error) {
	if fs, ferr := s.followStore(); ferr == nil {
		followers, ferr = fs.ListThreadFollowers(ctx, threadID)
		if ferr != nil {
			slog.Warn("thread delete: follower read failed, followers will learn at their next ready",
				"thread_id", threadID, "err", ferr)
			followers = nil
		}
	}
	info, err = s.Delete(ctx, userID, threadID)
	if err != nil {
		return nil, nil, err
	}
	return info, followers, nil
}
