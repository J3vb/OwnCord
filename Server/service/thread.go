package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Threads: a thread is a channel row of type 'thread' under a text channel
// (migration 074). It has no permission state of its own: who may see, read or
// post is answered by its parent plus the thread's lock.

const (
	// MaxThreadNameLen bounds a thread's name, in runes.
	MaxThreadNameLen = 100
	// DefaultThreadAutoArchiveMinutes is the idle period of a thread whose
	// creator named none.
	DefaultThreadAutoArchiveMinutes = 1440

	threadCreateLimit  = 5
	threadCreateWindow = 10 * time.Minute
	// ThreadListMaxLimit and ThreadListDefaultLimit bound one page of the
	// thread list.
	ThreadListMaxLimit     = 100
	ThreadListDefaultLimit = 50
)

// ThreadInfo is the wire shape of a thread, aliased so the ws transport depends on
// service, not db.
type ThreadInfo = db.ThreadInfo

// ErrThreadExists means the message already has a thread. It always rides a
// *ThreadExistsError naming the winner, and refines ErrConflict.
var ErrThreadExists = errors.New("a thread already exists for this message")

// ThreadExistsError is the loser's answer to a create race.
type ThreadExistsError struct{ ThreadID int64 }

func (e *ThreadExistsError) Error() string {
	return fmt.Sprintf("%v: thread %d", ErrThreadExists, e.ThreadID)
}

// Unwrap lets errors.Is match both ErrThreadExists and ErrConflict.
func (e *ThreadExistsError) Unwrap() []error { return []error{ErrThreadExists, ErrConflict} }

// ThreadStore is the persistence behind the thread operations. *db.DB satisfies
// it; a Store that does not makes them answer ErrInternal. Kept beside Store
// because Store's surface is ratcheted (datastore_ratchet_test.go).
type ThreadStore interface {
	GetThreadByStarter(ctx context.Context, starterID int64) (*db.ThreadInfo, error)
	CreateThread(ctx context.Context, n db.NewThread) (info *db.ThreadInfo, created bool, err error)
	GetThread(ctx context.Context, id int64) (*db.ThreadInfo, error)
	ListThreadsBy(ctx context.Context, parentID int64, archived bool, opts db.ThreadListOptions, after db.ThreadCursor, limit int) ([]db.ThreadListRow, error)
	UpdateThread(ctx context.Context, id int64, patch db.ThreadPatch, byModerator bool) (*db.ThreadInfo, error)
	DeleteThread(ctx context.Context, id int64) (bool, error)
	NextThreadArchiveDue(ctx context.Context) (time.Time, bool, error)
	ArchiveDueThreads(ctx context.Context, now time.Time, limit int) (archived []db.DueThread, listed int, err error)
}

// ThreadService owns thread create, update, delete and the thread list.
type ThreadService struct {
	st      Store
	ts      ThreadStore
	perms   *PermissionService
	limiter *auth.RateLimiter
}

// NewThreadService creates a ThreadService over the ThreadStore slice of st.
func NewThreadService(st Store, perms *PermissionService, limiter *auth.RateLimiter) *ThreadService {
	ts, _ := st.(ThreadStore)
	return &ThreadService{st: st, ts: ts, perms: perms, limiter: limiter}
}

func (s *ThreadService) store() (ThreadStore, error) {
	if s.ts == nil {
		return nil, fmt.Errorf("%w: thread storage unavailable", ErrInternal)
	}
	return s.ts, nil
}

// CreateThreadParams is one thread_create request.
type CreateThreadParams struct {
	UserID    int64
	ChannelID int64 // the parent
	MessageID int64 // the starter
	Name      string
	// AutoArchiveMinutes is one of db.ThreadAutoArchiveMinutes, 0 for the default.
	AutoArchiveMinutes int
}

// validAutoArchive resolves the requested idle period.
func validAutoArchive(minutes int) (int, error) {
	if minutes == 0 {
		return DefaultThreadAutoArchiveMinutes, nil
	}
	if !slices.Contains(db.ThreadAutoArchiveMinutes, minutes) {
		return 0, fmt.Errorf("%w: auto_archive_minutes must be one of %v", ErrBadRequest, db.ThreadAutoArchiveMinutes)
	}
	return minutes, nil
}

// cleanThreadName is the channel-name contract for a thread name: sanitised,
// trimmed, 1..MaxThreadNameLen runes.
func cleanThreadName(name string) (string, error) {
	cleaned, err := cleanTextBounded(name, MaxThreadNameLen, "name")
	if err != nil {
		return "", err
	}
	if cleaned == "" {
		return "", fmt.Errorf("%w: name is required", ErrBadRequest)
	}
	return cleaned, nil
}

// Create starts a thread on a message of a text channel and reports whether this
// call created it. It is idempotent on the starter message (the unique starter
// index), not on a request key: the thread's owner retrying gets it back with
// created false, and anyone else gets *ThreadExistsError naming it, which is also
// how the loser of a race learns the winner.
func (s *ThreadService) Create(ctx context.Context, p CreateThreadParams) (info *db.ThreadInfo, created bool, err error) {
	ts, err := s.store()
	if err != nil {
		return nil, false, err
	}
	if p.ChannelID <= 0 || p.MessageID <= 0 {
		return nil, false, fmt.Errorf("%w: channel_id and message_id must be positive", ErrBadRequest)
	}
	name, err := cleanThreadName(p.Name)
	if err != nil {
		return nil, false, err
	}
	minutes, err := validAutoArchive(p.AutoArchiveMinutes)
	if err != nil {
		return nil, false, err
	}
	n := db.NewThread{
		ParentID: p.ChannelID, StarterMessageID: p.MessageID, OwnerID: p.UserID,
		Name: name, AutoArchiveMinutes: minutes,
	}
	// A retry is answered before the create budget, so a lost thread_create_ok never
	// costs a second token.
	if prior, perr := ts.GetThreadByStarter(ctx, p.MessageID); perr != nil {
		return nil, false, fmt.Errorf("%w: load thread: %w", ErrInternal, perr)
	} else if prior != nil && s.ownRetry(prior, p) {
		// Ahead of the rate limiter but not the view gate: an owner who has since lost
		// the parent gets nothing back.
		if err := s.requireCanView(ctx, p); err != nil {
			return nil, false, err
		}
		return prior, false, nil
	}
	if s.limiter != nil && !s.limiter.Allow(auth.Key("thread_create", p.UserID), threadCreateLimit, threadCreateWindow) {
		return nil, false, ErrRateLimited
	}
	if err := s.requireCanStart(ctx, p); err != nil {
		return nil, false, err
	}
	info, created, err = ts.CreateThread(ctx, n)
	if err != nil {
		if exists, ok := errors.AsType[*db.ThreadExistsError](err); ok {
			// Lost a race, or a retry the lookup above could not see yet.
			if won, gerr := ts.GetThread(ctx, exists.ThreadID); gerr == nil && won != nil && s.ownRetry(won, p) {
				return won, false, nil
			}
		}
		return nil, false, mapThreadErr(err)
	}
	if created {
		slog.Info("thread created", "user_id", p.UserID, "channel_id", p.ChannelID, "thread_id", info.ID)
	}
	return info, created, nil
}

// ownRetry reports whether the existing thread is the one p's caller made for
// the same message in the same channel.
func (s *ThreadService) ownRetry(t *db.ThreadInfo, p CreateThreadParams) bool {
	return t.ParentID == p.ChannelID && t.OwnerID != nil && *t.OwnerID == p.UserID
}

// requireCanView is the read half of the create gate: the parent exists and the
// caller can see it; otherwise not found.
func (s *ThreadService) requireCanView(ctx context.Context, p CreateThreadParams) error {
	parent, err := s.st.GetChannel(ctx, p.ChannelID)
	if err != nil {
		return fmt.Errorf("%w: load channel: %w", ErrInternal, err)
	}
	if parent == nil || parent.Type == "dm" {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	sub, err := channelSubject(ctx, s.st, s.perms, p.UserID, parent, false)
	if err != nil {
		return err
	}
	if permissions.CanViewChannel(sub) != nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	return nil
}

// requireCanStart is the create gate: the parent is a live text channel the caller
// may send in (READ and SEND, not timed out, not archived).
func (s *ThreadService) requireCanStart(ctx context.Context, p CreateThreadParams) error {
	parent, err := s.st.GetChannel(ctx, p.ChannelID)
	if err != nil {
		return fmt.Errorf("%w: load channel: %w", ErrInternal, err)
	}
	if parent == nil || parent.Type == "dm" {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	sub, err := channelSubject(ctx, s.st, s.perms, p.UserID, parent, false)
	if err != nil {
		return err
	}
	if err := denial(permissions.CanSendMessage(sub)); err != nil {
		return err
	}
	if parent.Type != "text" {
		return fmt.Errorf("%w: threads start in text channels", ErrBadRequest)
	}
	return nil
}

// UpdateThreadParams is one thread_update request; a nil field is unchanged.
type UpdateThreadParams struct {
	UserID, ThreadID   int64
	Name               *string
	Archived           *bool
	Locked             *bool
	AutoArchiveMinutes *int
	// TagIDs replaces a forum post's tags; BAD_REQUEST on any other
	// thread.
	TagIDs *[]int64
}

// threadActor resolves the thread, whether the caller owns it, and whether they
// moderate it (READ and MANAGE_MESSAGES in the parent, via the thread's own channel
// row). A thread the caller cannot see is not found.
func (s *ThreadService) threadActor(ctx context.Context, ts ThreadStore, userID, threadID int64) (info *db.ThreadInfo, isOwner, isMod bool, err error) {
	if threadID <= 0 {
		return nil, false, false, fmt.Errorf("%w: thread_id must be positive", ErrBadRequest)
	}
	info, err = ts.GetThread(ctx, threadID)
	if err != nil {
		return nil, false, false, fmt.Errorf("%w: load thread: %w", ErrInternal, err)
	}
	if info == nil {
		return nil, false, false, fmt.Errorf("%w: thread not found", ErrNotFound)
	}
	ch, err := s.st.GetChannel(ctx, threadID)
	if err != nil || ch == nil {
		return nil, false, false, fmt.Errorf("%w: thread not found", ErrNotFound)
	}
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, false)
	if err != nil {
		return nil, false, false, err
	}
	if permissions.CanViewChannel(sub) != nil {
		return nil, false, false, fmt.Errorf("%w: thread not found", ErrNotFound)
	}
	if sub.TimedOut {
		return nil, false, false, denial(permissions.ErrTimedOut)
	}
	isOwner = info.OwnerID != nil && *info.OwnerID == userID
	return info, isOwner, sub.Has(permissions.ManageMessages), nil
}

// Update renames, archives, unarchives, locks or retimes a thread. The owner may
// rename, archive, unarchive and change the period; a moderator may also lock. A
// locked thread belongs to moderators alone.
func (s *ThreadService) Update(ctx context.Context, p UpdateThreadParams) (*db.ThreadInfo, error) {
	ts, err := s.store()
	if err != nil {
		return nil, err
	}
	if p.Name == nil && p.Archived == nil && p.Locked == nil && p.AutoArchiveMinutes == nil && p.TagIDs == nil {
		return nil, fmt.Errorf("%w: nothing to update", ErrBadRequest)
	}
	patch, err := cleanThreadPatch(p)
	if err != nil {
		return nil, err
	}
	cur, isOwner, isMod, err := s.threadActor(ctx, ts, p.UserID, p.ThreadID)
	if err != nil {
		return nil, err
	}
	switch {
	case !isOwner && !isMod:
		return nil, fmt.Errorf("%w: only the thread's creator or a moderator can change it", ErrForbidden)
	case p.Locked != nil && !isMod:
		return nil, fmt.Errorf("%w: only a moderator can lock a thread", ErrForbidden)
	case cur.Locked && !isMod:
		return nil, denial(permissions.ErrThreadLocked)
	}
	if patch.TagIDs, err = s.postTagsPatch(ctx, cur, p.TagIDs); err != nil {
		return nil, err
	}
	out, err := ts.UpdateThread(ctx, p.ThreadID, patch, isMod)
	if err != nil {
		return nil, mapThreadErr(err)
	}
	return out, nil
}

// postTags validates a tag edit of a forum post against its forum's rules.
func (s *ThreadService) postTags(ctx context.Context, cur *db.ThreadInfo, ids []int64) ([]int64, error) {
	if cur.Post == nil {
		return nil, fmt.Errorf("%w: only forum posts take tags", ErrBadRequest)
	}
	forum, err := s.st.GetChannel(ctx, cur.ParentID)
	if err != nil || forum == nil {
		return nil, fmt.Errorf("%w: thread not found", ErrNotFound)
	}
	return cleanPostTags(forum, ids)
}

// Delete removes a thread and, by cascade, its messages. Moderators only.
// It returns the thread as it was, so the caller can tell the parent's viewers.
func (s *ThreadService) Delete(ctx context.Context, userID, threadID int64) (*db.ThreadInfo, error) {
	ts, err := s.store()
	if err != nil {
		return nil, err
	}
	cur, _, isMod, err := s.threadActor(ctx, ts, userID, threadID)
	if err != nil {
		return nil, err
	}
	if !isMod {
		return nil, fmt.Errorf("%w: only a moderator can delete a thread", ErrForbidden)
	}
	tail := context.WithoutCancel(ctx)
	gone, err := ts.DeleteThread(tail, threadID)
	if err != nil {
		return nil, fmt.Errorf("%w: delete thread: %w", ErrInternal, err)
	}
	if !gone {
		return nil, fmt.Errorf("%w: thread not found", ErrNotFound)
	}
	slog.Warn("thread deleted", "actor_id", userID, "thread_id", threadID, "channel_id", cur.ParentID)
	db.WriteAudit(tail, s.st, userID, "thread_delete", "thread", threadID,
		fmt.Sprintf("deleted thread %q in channel %d", cur.Name, cur.ParentID))
	return cur, nil
}

// Get returns a thread by id with no permission check: for the hub, which has
// already decided who hears about it. nil when there is none.
func (s *ThreadService) Get(ctx context.Context, threadID int64) (*db.ThreadInfo, error) {
	ts, err := s.store()
	if err != nil {
		return nil, err
	}
	info, err := ts.GetThread(ctx, threadID)
	if err != nil {
		return nil, fmt.Errorf("%w: load thread: %w", ErrInternal, err)
	}
	return info, nil
}

// mapThreadErr turns a db thread error into the service's error kinds.
func mapThreadErr(err error) error {
	var exists *db.ThreadExistsError
	switch {
	case errors.As(err, &exists):
		return &ThreadExistsError{ThreadID: exists.ThreadID}
	case errors.Is(err, db.ErrThreadStarterInvalid):
		return fmt.Errorf("%w: message not found", ErrNotFound)
	case errors.Is(err, db.ErrThreadGone), errors.Is(err, db.ErrNotFound):
		return fmt.Errorf("%w: thread not found", ErrNotFound)
	case errors.Is(err, db.ErrThreadLockedForActor):
		return denial(permissions.ErrThreadLocked)
	case errors.Is(err, db.ErrForumTagUnknown):
		return fmt.Errorf("%w: unknown tag", ErrBadRequest)
	case errors.Is(err, db.ErrAccountErasing):
		return fmt.Errorf("%w: account is being deleted", ErrForbidden)
	default:
		return fmt.Errorf("%w: thread: %w", ErrInternal, err)
	}
}
