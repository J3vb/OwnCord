package db

import (
	"context"
	"fmt"
	"slices"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Thread follows (migration 079). thread_members is never
// permission: nothing here decides who may see a thread, and every caller that
// turns a follow into something a user receives joins it with the parent's
// visibility first.

// MaxFollowedThreads bounds the followed threads one ready payload carries.
const MaxFollowedThreads = 200

// followedThreadScan is how many followed rows are read before the caller
// drops the ones whose parent is no longer readable, so a user with a few
// hidden follows still fills MaxFollowedThreads.
const followedThreadScan = 2 * MaxFollowedThreads

// FollowedThread is one followed open thread with its read position, for the
// ready payload. UnreadCount stops at 100, as a channel's does.
type FollowedThread struct {
	Thread            ThreadInfo
	LastMessageID     int64
	LastReadMessageID int64
	UnreadCount       int64
	MentionCount      int64
}

// contentMentionIDs is the content-derived part of a mention set as it is
// stored: the reply-ping target is taken out (it has its own flagged row) and
// the rest is capped at maxMentionsPerMessage.
func contentMentionIDs(mentionedUserIDs []int64, replyPingUserID int64) []int64 {
	if replyPingUserID != 0 {
		mentionedUserIDs = slices.DeleteFunc(slices.Clone(mentionedUserIDs), func(id int64) bool { return id == replyPingUserID })
	}
	if len(mentionedUserIDs) > maxMentionsPerMessage {
		mentionedUserIDs = mentionedUserIDs[:maxMentionsPerMessage]
	}
	return mentionedUserIDs
}

// threadPostEffects runs inside a send transaction. For a message in a thread
// it records the activity (touchIfThread) and joins the author and each direct
// mention with INSERT OR IGNORE, returning the users this call actually
// inserted. For any other channel it does nothing and returns nil.
func threadPostEffects(ctx context.Context, q *dbgen.Queries, channelID, authorID int64, mentioned []int64, replyPingUserID int64) ([]int64, error) {
	isThread, err := touchIfThread(ctx, q, channelID)
	if err != nil || !isThread {
		return nil, err
	}
	users := append([]int64{authorID}, contentMentionIDs(mentioned, replyPingUserID)...)
	if replyPingUserID != 0 {
		users = append(users, replyPingUserID)
	}
	var joined []int64
	seen := make(map[int64]bool, len(users))
	for _, uid := range users {
		if uid <= 0 || seen[uid] {
			continue
		}
		seen[uid] = true
		n, err := q.JoinThread(ctx, dbgen.JoinThreadParams{ThreadID: channelID, UserID: uid})
		if err != nil {
			return nil, fmt.Errorf("join thread %d: %w", channelID, err)
		}
		if n > 0 {
			joined = append(joined, uid)
		}
	}
	return joined, nil
}

// FollowThread makes userID a follower of the thread. It reports whether the
// row was newly written: false for a user who already followed, and for an id
// that is not a thread.
func (d *DB) FollowThread(ctx context.Context, threadID, userID int64) (bool, error) {
	n, err := d.q.JoinThread(ctx, dbgen.JoinThreadParams{ThreadID: threadID, UserID: userID})
	if err != nil {
		return false, fmt.Errorf("FollowThread: %w", err)
	}
	return n > 0, nil
}

// UnfollowThread removes userID from the thread's followers. It reports whether
// a row was removed.
func (d *DB) UnfollowThread(ctx context.Context, threadID, userID int64) (bool, error) {
	n, err := d.q.LeaveThread(ctx, dbgen.LeaveThreadParams{ThreadID: threadID, UserID: userID})
	if err != nil {
		return false, fmt.Errorf("UnfollowThread: %w", err)
	}
	return n > 0, nil
}

// IsThreadFollower reports whether userID follows the thread.
func (d *DB) IsThreadFollower(ctx context.Context, threadID, userID int64) (bool, error) {
	v, err := d.q.IsThreadFollower(ctx, dbgen.IsThreadFollowerParams{ThreadID: threadID, UserID: userID})
	if err != nil {
		return false, fmt.Errorf("IsThreadFollower: %w", err)
	}
	return v != 0, nil
}

// ListThreadFollowers returns the thread's followers, lowest user id first.
func (d *DB) ListThreadFollowers(ctx context.Context, threadID int64) ([]int64, error) {
	ids, err := d.q.ListThreadFollowerIDs(ctx, threadID)
	if err != nil {
		return nil, fmt.Errorf("ListThreadFollowers: %w", err)
	}
	return ids, nil
}

// ListFollowedThreads returns userID's followed open threads, newest activity
// first, for the caller to narrow to the parents the user can read. At most
// followedThreadScan rows are read.
func (d *DB) ListFollowedThreads(ctx context.Context, userID int64) ([]FollowedThread, error) {
	rows, err := d.q.ListFollowedThreadStates(ctx, dbgen.ListFollowedThreadStatesParams{
		UserID: userID, RowLimit: followedThreadScan,
	})
	if err != nil {
		return nil, fmt.Errorf("ListFollowedThreads: %w", err)
	}
	out := make([]FollowedThread, 0, len(rows))
	for i := range rows {
		r := rows[i]
		out = append(out, FollowedThread{
			Thread: threadFromFields(threadFields{
				ID: r.ID, ParentID: r.ParentID, Name: r.Name, ThreadOwnerID: r.ThreadOwnerID,
				ThreadStarterMessageID: r.ThreadStarterMessageID, ThreadArchived: r.ThreadArchived,
				ThreadLocked: r.ThreadLocked, ThreadAutoArchiveMinutes: r.ThreadAutoArchiveMinutes,
				MessageCount: r.MessageCount, LastMessageAt: r.LastMessageAt, CreatedAt: r.CreatedAt,
			}),
			LastMessageID:     anyInt64(r.LastMessageID),
			LastReadMessageID: anyInt64(r.LastReadMessageID),
			UnreadCount:       r.UnreadCount,
			MentionCount:      anyInt64(r.MentionCount),
		})
	}
	return out, nil
}

// anyInt64 reads an integer column sqlc typed as interface{}.
func anyInt64(v any) int64 {
	if n, ok := v.(int64); ok {
		return n
	}
	return 0
}
