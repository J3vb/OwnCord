package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// Forum settings and tags: require-tag flag, default auto-archive period and tag list,
// written as one whole value (full replace, like Discord's available_tags): a tag without
// an id is created, a listed id renamed/re-emojied/repositioned, an omitted tag deleted
// with its post links. One transaction, one audit row, one channel_update.

const (
	// MaxForumTagNameLen bounds a forum tag's name in runes.
	MaxForumTagNameLen = 20
	// MaxForumTags is the most tags one forum holds.
	MaxForumTags = db.MaxForumTags
)

// forumAutoArchiveMinutes are the periods a forum may offer its posts: the same four a thread takes.
var forumAutoArchiveMinutes = []int{60, 1440, 4320, 10080}

// ForumStore is the persistence behind forum settings; a Store that is not a *db.DB makes
// the operations answer ErrInternal. Kept beside Store because Store's surface is
// ratcheted (datastore_ratchet_test.go).
type ForumStore interface {
	ReplaceForumSettings(ctx context.Context, forumID int64, in db.ForumSettingsWrite) ([]db.ForumTag, error)
}

// ForumTagInput is one tag of a forum settings write.
type ForumTagInput struct {
	ID    int64
	Name  string
	Emoji string
}

// ForumSettingsInput is the whole of a forum's settings; tag order is display order.
type ForumSettingsInput struct {
	RequireTag                bool
	DefaultAutoArchiveMinutes int
	Tags                      []ForumTagInput
}

func (s *ChannelService) forumStore() (ForumStore, error) {
	if s.forum == nil {
		return nil, fmt.Errorf("%w: forum storage unavailable", ErrInternal)
	}
	return s.forum, nil
}

// cleanForumSettings applies the settings contract: auto-archive is one of the four, at
// most MaxForumTags tags, each name cleaned, 1..MaxForumTagNameLen runes and unique
// ignoring case, each emoji valid, each id once, and requiring a tag needs at least
// one tag to pick. Violations are ErrBadRequest.
func cleanForumSettings(in ForumSettingsInput) (db.ForumSettingsWrite, error) {
	ok := false
	for _, m := range forumAutoArchiveMinutes {
		ok = ok || m == in.DefaultAutoArchiveMinutes
	}
	if !ok {
		return db.ForumSettingsWrite{}, fmt.Errorf("default_auto_archive_minutes must be 60, 1440, 4320 or 10080%.0w", ErrBadRequest)
	}
	if len(in.Tags) > MaxForumTags {
		return db.ForumSettingsWrite{}, fmt.Errorf("a forum holds at most %d tags%.0w", MaxForumTags, ErrBadRequest)
	}
	if in.RequireTag && len(in.Tags) == 0 {
		return db.ForumSettingsWrite{}, fmt.Errorf("add a tag before requiring one%.0w", ErrBadRequest)
	}
	out := db.ForumSettingsWrite{
		RequireTag:                in.RequireTag,
		DefaultAutoArchiveMinutes: in.DefaultAutoArchiveMinutes,
		Tags:                      make([]db.ForumTagWrite, 0, len(in.Tags)),
	}
	names := make(map[string]bool, len(in.Tags))
	ids := make(map[int64]bool, len(in.Tags))
	for i := range in.Tags {
		t := in.Tags[i]
		name, err := cleanChannelField(t.Name, MaxForumTagNameLen, "tag name")
		if err != nil {
			return db.ForumSettingsWrite{}, err
		}
		if name == "" {
			return db.ForumSettingsWrite{}, fmt.Errorf("tag name is required%.0w", ErrBadRequest)
		}
		key := strings.ToLower(name)
		if names[key] {
			return db.ForumSettingsWrite{}, fmt.Errorf("tag name %q is used twice%.0w", name, ErrBadRequest)
		}
		names[key] = true
		if t.ID < 0 || (t.ID != 0 && ids[t.ID]) {
			return db.ForumSettingsWrite{}, fmt.Errorf("tag id %d is invalid or used twice%.0w", t.ID, ErrBadRequest)
		}
		ids[t.ID] = true
		if t.Emoji != "" {
			if err := validateEmoji(t.Emoji); err != nil {
				return db.ForumSettingsWrite{}, fmt.Errorf("tag emoji is invalid%.0w", ErrBadRequest)
			}
		}
		out.Tags = append(out.Tags, db.ForumTagWrite{ID: t.ID, Name: name, Emoji: t.Emoji})
	}
	return out, nil
}

// AdminUpdateForumSettings validates and writes a forum's settings, audits it and returns
// the channel row read on the uncancellable tail, for the caller's channel_update.
// existing must be the resolved guild channel; a non-forum is ErrBadRequest.
func (s *ChannelService) AdminUpdateForumSettings(ctx context.Context, actorID int64, existing *db.Channel, in ForumSettingsInput) (*db.Channel, error) {
	if existing == nil || existing.Type != db.ForumTypeName {
		return nil, fmt.Errorf("forum settings apply to forum channels only%.0w", ErrBadRequest)
	}
	fs, err := s.forumStore()
	if err != nil {
		return nil, err
	}
	write, err := cleanForumSettings(in)
	if err != nil {
		return nil, err
	}
	if _, err := fs.ReplaceForumSettings(ctx, existing.ID, write); err != nil {
		switch {
		case errors.Is(err, db.ErrNotFound):
			return nil, fmt.Errorf("forum or tag not found%.0w", ErrBadRequest)
		case errors.Is(err, db.ErrConflict):
			return nil, fmt.Errorf("tag names must be unique and a forum holds at most %d tags%.0w", MaxForumTags, ErrBadRequest)
		}
		return nil, fmt.Errorf("%w: failed to update forum settings: %w", ErrInternal, err)
	}
	tail := context.WithoutCancel(ctx)
	slog.Info("forum settings updated", "actor_id", actorID, "channel_id", existing.ID, "tags", len(write.Tags))
	db.WriteAudit(tail, s.st, actorID, "channel_update", "channel", existing.ID,
		fmt.Sprintf("updated forum settings for #%s", existing.Name))
	updated, err := s.st.GetChannel(tail, existing.ID)
	if err != nil || updated == nil {
		return nil, fmt.Errorf("%w: failed to fetch updated forum: %w", ErrInternal, err)
	}
	return updated, nil
}
