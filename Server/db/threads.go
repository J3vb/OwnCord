package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// ThreadAutoArchiveMinutes are the auto-archive periods a thread may have,
// matching the CHECK on channels.thread_auto_archive_minutes (migration 074).
var ThreadAutoArchiveMinutes = []int{60, 1440, 4320, 10080}

var (
	// ErrThreadExists means the starter message already has a thread. It is
	// always wrapped in a *ThreadExistsError that names the winner.
	ErrThreadExists = errors.New("a thread already exists for this message")
	// ErrThreadStarterInvalid means the starter message is gone, deleted, not
	// an ordinary message, or not in the parent channel. CreateThread returns
	// it from inside its transaction, so a delete that commits first wins.
	ErrThreadStarterInvalid = errors.New("thread starter message is not available")
	// ErrThreadGone means the thread no longer exists.
	ErrThreadGone = errors.New("thread is gone")
	// ErrThreadLockedForActor means a non-moderator tried to change a locked
	// thread. UpdateThread re-reads the lock inside its transaction.
	ErrThreadLockedForActor = errors.New("thread is locked")
)

// ThreadExistsError names the thread that won a create race.
type ThreadExistsError struct{ ThreadID int64 }

func (e *ThreadExistsError) Error() string {
	return fmt.Sprintf("thread %d already exists for this message", e.ThreadID)
}

// Unwrap lets errors.Is(err, ErrThreadExists) match.
func (e *ThreadExistsError) Unwrap() error { return ErrThreadExists }

// ThreadInfo is the wire shape of a thread: the thread_changed and
// thread_create_ok payloads, the thread on a starter message, and a row of the
// thread list. OwnerID and StarterMessageID are null when that user or
// message is gone. LastMessageAt is null while the thread has no message.
type ThreadInfo struct {
	ID                 int64   `json:"id"`
	ParentID           int64   `json:"parent_id"`
	Name               string  `json:"name"`
	OwnerID            *int64  `json:"owner_id"`
	StarterMessageID   *int64  `json:"starter_message_id"`
	Archived           bool    `json:"archived"`
	Locked             bool    `json:"locked"`
	AutoArchiveMinutes int     `json:"auto_archive_minutes"`
	MessageCount       int64   `json:"message_count"`
	LastMessageAt      *string `json:"last_message_at"`
	CreatedAt          string  `json:"created_at"`
	// Post is the forum post block, present only when the parent is
	// a forum.
	Post *ForumPostMeta `json:"post,omitempty"`
}

// threadFields carries the columns shared by every thread info row; the
// generated row types are structurally identical, so one mapper narrows any.
type threadFields struct {
	ID                       int64
	ParentID                 int64
	Name                     string
	ThreadOwnerID            *int64
	ThreadStarterMessageID   *int64
	ThreadArchived           int64
	ThreadLocked             int64
	ThreadAutoArchiveMinutes int64
	MessageCount             int64
	LastMessageAt            any
	CreatedAt                string
}

func threadFromFields(f threadFields) ThreadInfo {
	t := ThreadInfo{
		ID: f.ID, ParentID: f.ParentID, Name: f.Name, OwnerID: f.ThreadOwnerID,
		StarterMessageID: f.ThreadStarterMessageID, Archived: f.ThreadArchived != 0,
		Locked: f.ThreadLocked != 0, AutoArchiveMinutes: int(f.ThreadAutoArchiveMinutes),
		MessageCount: f.MessageCount, CreatedAt: f.CreatedAt,
	}
	if s, ok := f.LastMessageAt.(string); ok && s != "" {
		t.LastMessageAt = &s
	}
	return t
}

// NewThread is one thread to create.
type NewThread struct {
	ParentID, StarterMessageID, OwnerID int64
	Name                                string
	AutoArchiveMinutes                  int
}

// CreateThread inserts the thread row in one writer transaction. The starter
// is re-read inside it (ErrThreadStarterInvalid), and a starter that already
// has a thread is *ThreadExistsError naming it: the writer serialises racing
// creates and the unique starter index is the backstop. That same answer is
// what makes a retry idempotent; the service turns it into the existing
// thread when the caller owns it. created reports whether this call inserted
// the row.
func (d *DB) CreateThread(ctx context.Context, n NewThread) (info *ThreadInfo, created bool, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, fmt.Errorf("CreateThread begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := d.q.WithTx(tx)
	if err := refuseWhileErasing(ctx, tx, n.OwnerID); err != nil {
		return nil, false, fmt.Errorf("CreateThread: %w", err)
	}
	st, err := q.GetForwardSourceState(ctx, n.StarterMessageID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, false, ErrThreadStarterInvalid
	case err != nil:
		return nil, false, fmt.Errorf("CreateThread starter: %w", err)
	case st.Deleted != 0 || st.Kind != MessageKindUser || st.ChannelID != n.ParentID:
		return nil, false, ErrThreadStarterInvalid
	}
	if won, werr := q.GetThreadInfoByStarter(ctx, &n.StarterMessageID); werr == nil {
		return nil, false, &ThreadExistsError{ThreadID: won.ID}
	} else if !errors.Is(werr, sql.ErrNoRows) {
		return nil, false, fmt.Errorf("CreateThread winner lookup: %w", werr)
	}
	now := time.Now().UTC().Format(dbtime.ISOLayout)
	res, err := q.InsertThread(ctx, dbgen.InsertThreadParams{
		Name: n.Name, ParentID: &n.ParentID, StarterMessageID: &n.StarterMessageID, OwnerID: &n.OwnerID,
		AutoArchiveMinutes: int64(n.AutoArchiveMinutes), LastActivityAt: &now,
	})
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, false, threadWonBy(ctx, q, n.StarterMessageID)
		}
		return nil, false, fmt.Errorf("CreateThread insert: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, false, fmt.Errorf("CreateThread id: %w", err)
	}
	// The owner follows the thread they start.
	if _, err := q.JoinThread(ctx, dbgen.JoinThreadParams{ThreadID: id, UserID: n.OwnerID}); err != nil {
		return nil, false, fmt.Errorf("CreateThread follow: %w", err)
	}
	t, err := d.getThread(ctx, q, id)
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, fmt.Errorf("CreateThread commit: %w", err)
	}
	return t, true, nil
}

// GetThreadByStarter returns the thread started on a message, or nil.
func (d *DB) GetThreadByStarter(ctx context.Context, starterID int64) (*ThreadInfo, error) {
	r, err := d.q.GetThreadInfoByStarter(ctx, &starterID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetThreadByStarter: %w", err)
	}
	t := threadFromFields(threadFields(r))
	return &t, nil
}

// threadWonBy reads the thread that took a starter, for the unique-index
// backstop; the failed insert aborted nothing else in the transaction.
func threadWonBy(ctx context.Context, q *dbgen.Queries, starterID int64) error {
	won, err := q.GetThreadInfoByStarter(ctx, &starterID)
	if err != nil {
		return fmt.Errorf("CreateThread winner lookup: %w", err)
	}
	return &ThreadExistsError{ThreadID: won.ID}
}

func (d *DB) getThread(ctx context.Context, q *dbgen.Queries, id int64) (*ThreadInfo, error) {
	r, err := q.GetThreadInfo(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetThread: %w", err)
	}
	t := threadFromFields(threadFields(r))
	if err := attachPosts(ctx, q, []*ThreadInfo{&t}); err != nil {
		return nil, fmt.Errorf("GetThread: %w", err)
	}
	return &t, nil
}

// GetThread returns the thread with the given id, or nil when there is none
// (including when id is an ordinary channel).
func (d *DB) GetThread(ctx context.Context, id int64) (*ThreadInfo, error) {
	return d.getThread(ctx, d.q, id)
}

// ThreadCursor is where a thread list page stops: the activity time and id of
// its last row, carried by the caller to the next request. The zero value is
// the first page.
type ThreadCursor struct {
	Activity string
	ID       int64
}

// ThreadListRow is a ThreadInfo with the activity time the list is ordered by,
// so the caller can build the next cursor.
type ThreadListRow struct {
	ThreadInfo
	Activity string
}

// Cursor is the position just after this row.
func (r ThreadListRow) Cursor() ThreadCursor { return ThreadCursor{Activity: r.Activity, ID: r.ID} }

// ThreadPatch is the set of thread fields one update changes; nil leaves a
// field as it is.
type ThreadPatch struct {
	Name               *string
	Archived           *bool
	Locked             *bool
	AutoArchiveMinutes *int
	// TagIDs, when set, replaces the tags of a forum post. The
	// service only sets it for a post; ErrNotFound otherwise.
	TagIDs *[]int64
}

// UpdateThread applies patch in one writer transaction and returns the thread
// after it. The lock is re-read inside the transaction: a caller that is not a
// moderator (byModerator false) gets ErrThreadLockedForActor when the thread is
// locked by then, so a lock that lands between the service's check and this
// write is honoured. ErrNotFound when the thread is gone.
func (d *DB) UpdateThread(ctx context.Context, id int64, patch ThreadPatch, byModerator bool) (*ThreadInfo, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("UpdateThread begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := d.q.WithTx(tx)
	cur, err := d.getThread(ctx, q, id)
	if err != nil {
		return nil, err
	}
	if cur == nil {
		return nil, ErrNotFound
	}
	if cur.Locked && !byModerator {
		return nil, ErrThreadLockedForActor
	}
	if patch.Name != nil {
		cur.Name = *patch.Name
	}
	if patch.Archived != nil {
		cur.Archived = *patch.Archived
	}
	if patch.Locked != nil {
		cur.Locked = *patch.Locked
	}
	if patch.AutoArchiveMinutes != nil {
		cur.AutoArchiveMinutes = *patch.AutoArchiveMinutes
	}
	if patch.TagIDs != nil {
		if cur.Post == nil {
			return nil, ErrNotFound
		}
		if err := replaceThreadTags(ctx, q, id, cur.ParentID, *patch.TagIDs); err != nil {
			return nil, err
		}
	}
	if _, err := q.UpdateThreadRow(ctx, dbgen.UpdateThreadRowParams{
		ID: id, Name: cur.Name, Archived: b2i64(cur.Archived), Locked: b2i64(cur.Locked),
		AutoArchiveMinutes: int64(cur.AutoArchiveMinutes),
	}); err != nil {
		return nil, fmt.Errorf("UpdateThread: %w", err)
	}
	// Unarchiving restarts the idle clock, or the next sweep would archive it again.
	if patch.Archived != nil && !*patch.Archived {
		now := time.Now().UTC().Format(dbtime.ISOLayout)
		if err := q.TouchThreadOnPost(ctx, dbgen.TouchThreadOnPostParams{ID: id, At: &now}); err != nil {
			return nil, fmt.Errorf("UpdateThread touch: %w", err)
		}
	}
	out, err := d.getThread(ctx, q, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("UpdateThread commit: %w", err)
	}
	return out, nil
}

// DeleteThread removes the thread row; the foreign keys cascade its messages.
// It reports whether a thread was deleted.
func (d *DB) DeleteThread(ctx context.Context, id int64) (bool, error) {
	n, err := d.q.DeleteThreadRow(ctx, id)
	if err != nil {
		return false, fmt.Errorf("DeleteThread: %w", err)
	}
	return n > 0, nil
}

// touchThreadOnPost records a committed message in channelID when it is a
// thread: it sets the activity time and reopens an archived thread. It runs in
// the message's own transaction, so activity and message commit together. For
// any other channel it matches nothing.
func touchThreadOnPost(ctx context.Context, q *dbgen.Queries, channelID int64) error {
	_, err := touchIfThread(ctx, q, channelID)
	return err
}

// touchIfThread is touchThreadOnPost that also reports whether channelID is a
// thread, so the send transaction can join its followers with the one lookup.
func touchIfThread(ctx context.Context, q *dbgen.Queries, channelID int64) (isThread bool, err error) {
	if is, err := q.IsThreadChannel(ctx, channelID); err != nil {
		return false, fmt.Errorf("touch thread: %w", err)
	} else if is == 0 {
		return false, nil
	}
	now := time.Now().UTC().Format(dbtime.ISOLayout)
	if err := q.TouchThreadOnPost(ctx, dbgen.TouchThreadOnPostParams{ID: channelID, At: &now}); err != nil {
		return false, fmt.Errorf("touch thread: %w", err)
	}
	return true, nil
}

// DueThread is a thread the archiver just archived.
type DueThread struct{ ID, ParentID int64 }

// NextThreadArchiveDue returns when the earliest open thread falls due, with
// ok false when no thread is open.
func (d *DB) NextThreadArchiveDue(ctx context.Context) (due time.Time, ok bool, err error) {
	v, err := d.q.NextThreadArchiveDue(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, fmt.Errorf("NextThreadArchiveDue: %w", err)
	}
	secs, isInt := v.(int64)
	if !isInt {
		return time.Time{}, false, nil
	}
	return time.Unix(secs, 0).UTC(), true, nil
}

// ArchiveDueThreads archives up to limit open threads whose idle period has
// passed at now, and returns the ones it archived. Each archive re-checks the
// due test, so a post that landed after the list keeps its thread open.
func (d *DB) ArchiveDueThreads(ctx context.Context, now time.Time, limit int) (archived []DueThread, listed int, err error) {
	rows, err := d.q.ListThreadsDueForArchive(ctx, dbgen.ListThreadsDueForArchiveParams{NowUnix: now.Unix(), RowLimit: int64(limit)})
	if err != nil {
		return nil, 0, fmt.Errorf("ListThreadsDueForArchive: %w", err)
	}
	for _, r := range rows {
		n, aerr := d.q.ArchiveThreadIfDue(ctx, dbgen.ArchiveThreadIfDueParams{ID: r.ID, NowUnix: now.Unix()})
		if aerr != nil {
			return archived, len(rows), fmt.Errorf("ArchiveThreadIfDue %d: %w", r.ID, aerr)
		}
		if n > 0 {
			archived = append(archived, DueThread{ID: r.ID, ParentID: r.ParentID})
		}
	}
	return archived, len(rows), nil
}

// attachThreads fills Thread on every ordinary, live row in msgs that started a
// thread, with one batched read. A page with no candidate rows costs no query.
func (d *DB) attachThreads(ctx context.Context, msgs []MessageAPIResponse) error {
	var ids []*int64
	for i := range msgs {
		if msgs[i].Kind == "" && !msgs[i].Deleted {
			ids = append(ids, &msgs[i].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := d.q.ListThreadInfosByStarters(ctx, padIDs(ids))
	if err != nil {
		return fmt.Errorf("threads: %w", err)
	}
	if len(rows) == 0 {
		return nil
	}
	byStarter := make(map[int64]ThreadInfo, len(rows))
	for i := range rows {
		t := threadFromFields(threadFields(rows[i]))
		if t.StarterMessageID != nil {
			byStarter[*t.StarterMessageID] = t
		}
	}
	for i := range msgs {
		if t, ok := byStarter[msgs[i].ID]; ok && !msgs[i].Deleted {
			msgs[i].Thread = &t
		}
	}
	return nil
}
