package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ForumTag is one forum tag (migration 075) in its wire shape; Emoji is omitted when none.
type ForumTag struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Emoji    string `json:"emoji,omitempty"`
	Position int    `json:"position"`
}

// ChannelForum is the forum half of a Channel (migration 075), set on a type 'forum'
// row only. It lives here because the models.go json-tag count is ratcheted.
type ChannelForum struct {
	Tags                      []ForumTag `json:"tags"`
	RequireTag                bool       `json:"require_tag"`
	DefaultAutoArchiveMinutes int        `json:"default_auto_archive_minutes"`
}

const ForumTypeName = "forum"

const MaxForumTags = 20

func forumTagFromGen(r dbgen.ForumTag) ForumTag {
	t := ForumTag{ID: r.ID, Name: r.Name, Position: int(r.Position)}
	if r.Emoji != nil {
		t.Emoji = *r.Emoji
	}
	return t
}

// forumFromFields builds the forum half of a channel row, nil for other types; Tags
// start non-nil so the wire carries [].
func forumFromFields(f channelFields) *ChannelForum {
	if f.Type != ForumTypeName {
		return nil
	}
	return &ChannelForum{
		Tags:                      []ForumTag{},
		RequireTag:                f.ForumRequireTag != 0,
		DefaultAutoArchiveMinutes: int(f.ForumDefaultAutoArchiveMinutes),
	}
}

func (d *DB) attachForumTags(ctx context.Context, channels []Channel) error {
	hasForum := false
	for i := range channels {
		if channels[i].Forum != nil {
			hasForum = true
			break
		}
	}
	if !hasForum {
		return nil
	}
	rows, err := d.q.ListForumTags(ctx)
	if err != nil {
		return fmt.Errorf("ListForumTags: %w", err)
	}
	byForum := make(map[int64][]ForumTag)
	for i := range rows {
		byForum[rows[i].ForumID] = append(byForum[rows[i].ForumID], forumTagFromGen(rows[i]))
	}
	for i := range channels {
		if channels[i].Forum != nil && byForum[channels[i].ID] != nil {
			channels[i].Forum.Tags = byForum[channels[i].ID]
		}
	}
	return nil
}

// ForumTagWrite is one tag of a ForumSettingsWrite: ID 0 creates, else it must name a
// tag of this forum.
type ForumTagWrite struct {
	ID    int64
	Name  string
	Emoji string
}

// ForumSettingsWrite is a forum's whole settings, a full replace; unlisted tags are
// deleted with their post links.
type ForumSettingsWrite struct {
	RequireTag                bool
	DefaultAutoArchiveMinutes int
	Tags                      []ForumTagWrite
}

// ReplaceForumSettings writes a forum's settings and tag list in one
// transaction and returns the stored tags. ErrNotFound when the forum is gone,
// not a forum, or a listed tag id is not its own; ErrConflict on duplicate
// names (ignoring case) or more than MaxForumTags. A rename into another's old
// name in the same write is fine (placeholders first). The count check runs in
// the writer transaction, so racing writes cannot both pass.
func (d *DB) ReplaceForumSettings(ctx context.Context, forumID int64, in ForumSettingsWrite) ([]ForumTag, error) {
	var out []ForumTag
	err := d.inWriteTx(ctx, "ReplaceForumSettings", func(q *dbgen.Queries) error {
		n, err := q.UpdateForumSettings(ctx, dbgen.UpdateForumSettingsParams{
			ForumRequireTag:                b2i64(in.RequireTag),
			ForumDefaultAutoArchiveMinutes: int64(in.DefaultAutoArchiveMinutes),
			ID:                             forumID,
		})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
		if len(in.Tags) > MaxForumTags {
			return ErrConflict
		}
		if err := replaceForumTags(ctx, q, forumID, in.Tags); err != nil {
			return err
		}
		rows, err := q.ListForumTagsByForum(ctx, forumID)
		if err != nil {
			return err
		}
		out = make([]ForumTag, 0, len(rows))
		for i := range rows {
			out = append(out, forumTagFromGen(rows[i]))
		}
		return nil
	})
	if err != nil {
		if IsUniqueConstraintError(err) {
			return nil, fmt.Errorf("ReplaceForumSettings: %w", ErrConflict)
		}
		return nil, err
	}
	return out, nil
}

// replaceForumTags makes the forum's tags exactly tags, in order: omitted tags
// are deleted, listed ids updated, id 0 inserted. A foreign or duplicated id is ErrNotFound.
func replaceForumTags(ctx context.Context, q *dbgen.Queries, forumID int64, tags []ForumTagWrite) error {
	cur, err := q.ListForumTagsByForum(ctx, forumID)
	if err != nil {
		return err
	}
	have := make(map[int64]bool, len(cur))
	for i := range cur {
		have[cur[i].ID] = true
	}
	keep := make(map[int64]bool, len(tags))
	for i := range tags {
		if id := tags[i].ID; id != 0 {
			if !have[id] || keep[id] {
				return ErrNotFound
			}
			keep[id] = true
		}
	}
	for i := range cur {
		if !keep[cur[i].ID] {
			if _, err := q.DeleteForumTag(ctx, dbgen.DeleteForumTagParams{ID: cur[i].ID, ForumID: forumID}); err != nil {
				return err
			}
		}
	}
	for id := range keep {
		if _, err := q.UpdateForumTag(ctx, dbgen.UpdateForumTagParams{
			Name: fmt.Sprintf("\x01%d", id), ID: id, ForumID: forumID,
		}); err != nil {
			return err
		}
	}
	for i := range tags {
		if err := writeForumTag(ctx, q, forumID, tags[i], i); err != nil {
			return err
		}
	}
	return nil
}

func writeForumTag(ctx context.Context, q *dbgen.Queries, forumID int64, t ForumTagWrite, pos int) error {
	var emoji *string
	if t.Emoji != "" {
		emoji = &t.Emoji
	}
	if t.ID == 0 {
		_, err := q.InsertForumTag(ctx, dbgen.InsertForumTagParams{ForumID: forumID, Name: t.Name, Emoji: emoji, Position: int64(pos)})
		return err
	}
	_, err := q.UpdateForumTag(ctx, dbgen.UpdateForumTagParams{Name: t.Name, Emoji: emoji, Position: int64(pos), ID: t.ID, ForumID: forumID})
	return err
}
