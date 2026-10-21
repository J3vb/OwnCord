package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ForumTag is one tag of a forum (migration 075), in the shape the wire
// carries it: ready, channel_create, channel_update and the admin channel
// list. Emoji is omitted when the tag has none.
type ForumTag struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Emoji    string `json:"emoji,omitempty"`
	Position int    `json:"position"`
}

// ChannelForum is the forum half of a Channel (migration 075), set on a
// type 'forum' row only. It is also the wire shape of a forum's settings, so
// a field here is a field clients read. It lives here rather than in
// models.go because the models.go json-tag count is ratcheted
// (service/datastore_ratchet_test.go).
type ChannelForum struct {
	Tags                      []ForumTag `json:"tags"`
	RequireTag                bool       `json:"require_tag"`
	DefaultAutoArchiveMinutes int        `json:"default_auto_archive_minutes"`
}

// ForumTypeName is the channels.type value of a forum.
const ForumTypeName = "forum"

// MaxForumTags is the most tags one forum may hold.
const MaxForumTags = 20

func forumTagFromGen(r dbgen.ForumTag) ForumTag {
	t := ForumTag{ID: r.ID, Name: r.Name, Position: int(r.Position)}
	if r.Emoji != nil {
		t.Emoji = *r.Emoji
	}
	return t
}

// forumFromFields builds the forum half of a channel row; nil for any other
// type. Tags start empty and non-nil so the wire carries [] rather than null.
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

// attachForumTags fills the tags of every forum in channels with one query,
// and none when there is no forum, so a server without forums pays nothing.
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

// ForumTagWrite is one tag of a ForumSettingsWrite. ID 0 creates a tag; a
// non-zero ID must name a tag of this forum and renames, re-emojis and
// repositions it. Position is the tag's index in the list, set by the writer.
type ForumTagWrite struct {
	ID    int64
	Name  string
	Emoji string
}

// ForumSettingsWrite is the whole settings of a forum: a full replace. A tag
// of the forum that the list does not name is deleted, and its links to posts
// go with it.
type ForumSettingsWrite struct {
	RequireTag                bool
	DefaultAutoArchiveMinutes int
	Tags                      []ForumTagWrite
}

// ReplaceForumSettings writes a forum's settings and tag list in one
// transaction and returns the forum's tags as stored. ErrNotFound when the
// forum is gone or is not a forum, or when a listed tag id is not one of its
// tags; ErrConflict when two tags would share a name, ignoring case, or the
// list would hold more than MaxForumTags. A tag that is renamed to another's
// old name in the same write is fine: renames go through placeholders first.
// The count check runs inside the writer transaction, so two racing writes
// cannot both pass it.
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

// replaceForumTags makes the forum's tags exactly tags, in list order: a tag
// of the forum the list leaves out is deleted, a listed id is updated, an id of
// 0 is inserted. A listed id that is not one of the forum's tags, or is listed
// twice, is ErrNotFound.
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
	// Park every kept tag under a unique placeholder so renames that swap
	// names cannot collide mid-write. A real name never holds a control
	// character.
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

// writeForumTag inserts (ID 0) or updates one tag at list index pos.
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
