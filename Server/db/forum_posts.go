package db

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Forum posts. A post is a thread under a forum with no starter
// message; its opening message is the thread's own first message, and
// channels.thread_post_message_id points at it. The post, its message, its tags
// and the send receipt commit in one transaction (CreateMessageDelivery).

// MaxPostTags is the most tags one post may carry.
const MaxPostTags = 5

// ForumPostPreviewRunes bounds ForumFirstMessage.Preview.
const ForumPostPreviewRunes = 200

var (
	// ErrForumGone means the forum named by a post create is gone, or is not a
	// forum. CreateMessageDelivery returns it from inside its transaction.
	ErrForumGone = errors.New("forum is gone")
	// ErrForumTagUnknown means a tag id is not (or no longer) a tag of the
	// forum. Tag deletes and post writes both run on the single writer, so the
	// answer is exact: either the tag exists for this write or it does not.
	ErrForumTagUnknown = errors.New("unknown forum tag")
)

// ForumPostInput is the post a forum_post_create makes, carried by
// MessageDeliveryParams. The owner is the sender.
type ForumPostInput struct {
	Name               string
	AutoArchiveMinutes int
	TagIDs             []int64
}

// ForumFirstMessage is a post's opening message as the forum list shows it.
// Preview is empty once the message is deleted.
type ForumFirstMessage struct {
	ID             int64  `json:"id"`
	AuthorID       *int64 `json:"author_id"`
	Preview        string `json:"preview"`
	HasAttachments bool   `json:"has_attachments"`
	Deleted        bool   `json:"deleted"`
}

// ForumPostMeta is the post block of a ThreadInfo. FirstMessage is null when
// the opening message was hard-deleted (retention).
type ForumPostMeta struct {
	TagIDs       []int64            `json:"tag_ids"`
	FirstMessage *ForumFirstMessage `json:"first_message"`
}

// previewOf cuts content to ForumPostPreviewRunes runes.
func previewOf(content string) string {
	r := []rune(content)
	if len(r) <= ForumPostPreviewRunes {
		return content
	}
	return string(r[:ForumPostPreviewRunes])
}

// attachPosts fills Post on every thread in ts whose parent is a forum, with
// two batched reads. A page with no thread costs no query, and a thread under
// a text channel matches nothing.
func attachPosts(ctx context.Context, q *dbgen.Queries, ts []*ThreadInfo) error {
	if len(ts) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(ts))
	for _, t := range ts {
		ids = append(ids, t.ID)
	}
	rows, err := q.ListThreadPosts(ctx, ids)
	if err != nil {
		return fmt.Errorf("thread posts: %w", err)
	}
	if len(rows) == 0 {
		return nil
	}
	links, err := q.ListThreadTagLinks(ctx, ids)
	if err != nil {
		return fmt.Errorf("thread tags: %w", err)
	}
	tags := make(map[int64][]int64, len(rows))
	for _, l := range links {
		tags[l.ThreadID] = append(tags[l.ThreadID], l.TagID)
	}
	posts := make(map[int64]*ForumPostMeta, len(rows))
	for i := range rows {
		r := rows[i]
		meta := &ForumPostMeta{TagIDs: tags[r.ThreadID]}
		if meta.TagIDs == nil {
			meta.TagIDs = []int64{}
		}
		if r.PostMessageID != nil {
			fm := &ForumFirstMessage{ID: *r.PostMessageID, AuthorID: r.AuthorID, HasAttachments: r.HasAttachments != 0, Deleted: r.Deleted != 0}
			if !fm.Deleted {
				fm.Preview = previewOf(r.Content)
			}
			meta.FirstMessage = fm
		}
		posts[r.ThreadID] = meta
	}
	for _, t := range ts {
		t.Post = posts[t.ID]
	}
	return nil
}

// insertForumPost writes the post's thread row and checks the forum and tags
// inside the delivery transaction, so a forum or tag deleted since the service
// looked wins. It returns the new thread's id.
func insertForumPost(ctx context.Context, q *dbgen.Queries, forumID, ownerID int64, in *ForumPostInput, now string) (int64, error) {
	isForum, err := q.IsForumChannel(ctx, forumID)
	if err != nil {
		return 0, fmt.Errorf("forum post forum: %w", err)
	}
	if isForum == 0 {
		return 0, ErrForumGone
	}
	if err := requireForumTags(ctx, q, forumID, in.TagIDs); err != nil {
		return 0, err
	}
	res, err := q.InsertThread(ctx, dbgen.InsertThreadParams{
		Name: in.Name, ParentID: &forumID, OwnerID: &ownerID,
		AutoArchiveMinutes: int64(in.AutoArchiveMinutes), LastActivityAt: &now,
	})
	if err != nil {
		return 0, fmt.Errorf("forum post insert: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("forum post id: %w", err)
	}
	return id, nil
}

// requireForumTags is ErrForumTagUnknown unless every id is a distinct tag of
// the forum.
func requireForumTags(ctx context.Context, q *dbgen.Queries, forumID int64, tagIDs []int64) error {
	if len(tagIDs) == 0 {
		return nil
	}
	if len(slices.Compact(slices.Sorted(slices.Values(tagIDs)))) != len(tagIDs) {
		return ErrForumTagUnknown
	}
	n, err := q.CountForumTagsIn(ctx, dbgen.CountForumTagsInParams{ForumID: forumID, TagIds: tagIDs})
	if err != nil {
		return fmt.Errorf("forum tags: %w", err)
	}
	if int(n) != len(tagIDs) {
		return ErrForumTagUnknown
	}
	return nil
}

// linkForumPost points the post at its opening message and writes its tags.
func linkForumPost(ctx context.Context, q *dbgen.Queries, threadID, messageID int64, tagIDs []int64) error {
	if n, err := q.SetThreadPostMessage(ctx, dbgen.SetThreadPostMessageParams{ID: threadID, MessageID: &messageID}); err != nil {
		return fmt.Errorf("forum post opening message: %w", err)
	} else if n == 0 {
		return fmt.Errorf("forum post opening message: %w", ErrThreadGone)
	}
	for _, id := range tagIDs {
		if err := q.InsertThreadTag(ctx, dbgen.InsertThreadTagParams{ThreadID: threadID, TagID: id}); err != nil {
			return fmt.Errorf("forum post tag: %w", err)
		}
	}
	return nil
}

// replaceThreadTags makes the tags of a post exactly tagIDs inside the
// caller's transaction: every id must be a tag of the forum, the old links go,
// the new ones are written.
func replaceThreadTags(ctx context.Context, q *dbgen.Queries, threadID, forumID int64, tagIDs []int64) error {
	if err := requireForumTags(ctx, q, forumID, tagIDs); err != nil {
		return err
	}
	if err := q.DeleteThreadTags(ctx, threadID); err != nil {
		return fmt.Errorf("clear tags: %w", err)
	}
	for _, id := range tagIDs {
		if err := q.InsertThreadTag(ctx, dbgen.InsertThreadTagParams{ThreadID: threadID, TagID: id}); err != nil {
			return fmt.Errorf("write tag: %w", err)
		}
	}
	return nil
}
