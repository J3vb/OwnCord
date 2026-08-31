package service

import (
	"context"
	"fmt"
	"log/slog"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
)

// ─── S-03: the channel metadata contract ─────────────────────────────────────
//
// One explicit rune/normalization contract for channel name, topic and
// category, shared by every writer (the admin CRUD here; group DM names
// already run the same machinery with MaxGroupDMNameLen matching the name
// cap). Bounds count runes on the cleaned value, never bytes; values are
// sanitized and trimmed by cleanTextBounded exactly like every other
// sidebar-rendered free-text field, with its raw-byte pre-check in front of
// the quadratic sanitizer (OC-0192/OC-0195 lineage).

const (
	// MaxChannelNameLen bounds channels.name. 100 is the cap
	// MaxGroupDMNameLen (dm.go) has always claimed to match: both render in
	// the same sidebar row, so anything longer is only ever shown clipped.
	MaxChannelNameLen = 100
	// MaxChannelTopicLen bounds channels.topic — the client's edit modal has
	// always capped its input at 1024; the server now enforces the same.
	MaxChannelTopicLen = 1024
	// MaxChannelCategoryLen bounds channels.category. Categories are free
	// text rendered as sidebar group headers, so they take the name cap.
	MaxChannelCategoryLen = 100
)

// validChannelTypes is the set of channel types a create may name. A
// channel's CATEGORY deliberately constrains nothing: grouping is a display
// concern, so the server validates the type alone (see the admin handler's
// original rationale, kept verbatim through the B3-8 move).
var validChannelTypes = []string{"text", "voice", "announcement"}

// ChannelMeta is the cleaned, validated name/topic/category triple every
// channel write goes through.
type ChannelMeta struct {
	Name     string
	Topic    string
	Category string
}

// cleanChannelMeta applies the S-03 contract: sanitize + trim each field,
// bound by runes, and require a non-empty name. Every violation is
// ErrBadRequest with the field's own message.
func cleanChannelMeta(name, topic, category string) (ChannelMeta, error) {
	cleanName, err := cleanTextBounded(name, MaxChannelNameLen, "name")
	if err != nil {
		return ChannelMeta{}, err
	}
	if cleanName == "" {
		return ChannelMeta{}, fmt.Errorf("%w: name is required", ErrBadRequest)
	}
	cleanTopic, err := cleanTextBounded(topic, MaxChannelTopicLen, "topic")
	if err != nil {
		return ChannelMeta{}, err
	}
	cleanCategory, err := cleanTextBounded(category, MaxChannelCategoryLen, "category")
	if err != nil {
		return ChannelMeta{}, err
	}
	return ChannelMeta{Name: cleanName, Topic: cleanTopic, Category: cleanCategory}, nil
}

// ─── S-04: the one non-DM resolution policy ──────────────────────────────────

// ResolveGuildChannel is the single admin-surface channel lookup: a missing
// channel and a DM channel both answer ErrNotFound, indistinguishably. DMs
// share the channels table and id space with guild channels, but they belong
// to their participants, not to MANAGE_CHANNELS holders — and answering a DM
// id with anything but "not found" confirms which ids are private
// conversations (A-2026-08-02). Every sibling lookup goes through here so no
// path can grow its own policy again (S-04).
func (s *ChannelService) ResolveGuildChannel(ctx context.Context, id int64) (*db.Channel, error) {
	if id <= 0 {
		return nil, fmt.Errorf("%w: invalid channel id", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch channel: %w", ErrInternal, err)
	}
	if ch == nil || ch.Type == "dm" {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	return ch, nil
}

// ─── Admin channel CRUD ──────────────────────────────────────────────────────

// AdminChannelCreate carries a create request's raw fields; the service
// cleans and validates them (S-03) before anything persists.
type AdminChannelCreate struct {
	Name     string
	Type     string
	Category string
	Topic    string
	Position int
}

// AdminListChannels lists guild channels only. DM rows live in the same
// table but are private conversations — enumerating them exposed ids and
// user-chosen group names to any MANAGE_CHANNELS holder (A-2026-08-02).
func (s *ChannelService) AdminListChannels(ctx context.Context) ([]db.Channel, error) {
	channels, err := s.st.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list channels: %w", ErrInternal, err)
	}
	guildChannels := make([]db.Channel, 0, len(channels))
	for i := range channels {
		if channels[i].Type != "dm" {
			guildChannels = append(guildChannels, channels[i])
		}
	}
	return guildChannels, nil
}

// AdminCreateChannel validates per S-03, persists, audits, and returns the
// committed row. The re-read runs on an uncancellable tail: once the row has
// committed, a caller disconnect must not leave a durably created channel
// unread and unbroadcast (OC-0158) — the caller fans out from the returned
// row.
func (s *ChannelService) AdminCreateChannel(ctx context.Context, actorID int64, req AdminChannelCreate, postCommitHook func()) (*db.Channel, error) {
	if req.Type == "" {
		req.Type = "text"
	}
	if !slices.Contains(validChannelTypes, req.Type) {
		return nil, fmt.Errorf("%w: type must be one of text, voice, announcement", ErrBadRequest)
	}
	meta, err := cleanChannelMeta(req.Name, req.Topic, req.Category)
	if err != nil {
		return nil, err
	}

	id, err := s.st.AdminCreateChannel(ctx, meta.Name, req.Type, meta.Category, meta.Topic, req.Position)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create channel: %w", ErrInternal, err)
	}

	tail := context.WithoutCancel(ctx)
	if postCommitHook != nil {
		postCommitHook()
	}
	ch, err := s.st.GetChannel(tail, id)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: failed to fetch created channel: %w", ErrInternal, err)
	}
	slog.Info("channel created", "actor_id", actorID, "channel", meta.Name, "type", req.Type)
	db.WriteAudit(tail, s.st, actorID, "channel_create", "channel", id,
		fmt.Sprintf("created #%s (%s)", meta.Name, req.Type))
	return ch, nil
}

// AdminChannelUpdate carries a full update — the handler pre-fills it from
// the existing row so a partial PATCH body is safe — with the raw text
// fields cleaned here per S-03.
type AdminChannelUpdate struct {
	Name          string
	Topic         string
	Category      string
	SlowMode      int
	Position      int
	Archived      bool
	NSFW          bool
	VoiceMaxUsers int
	VoiceMaxVideo int
}

// Bounds for the numeric channel settings an update may set: SQLite would
// happily store a slow mode of six years or a user limit of -3, and the only
// place that would surface is a client rendering nonsense. The values match
// what the clients offer (0 = unlimited in both voice cases).
const (
	maxSlowModeSeconds = 21600
	maxVoiceLimit      = 99
)

// AdminUpdateChannel validates (S-03 text contract + numeric bounds),
// persists, audits, and returns the committed row read on the uncancellable
// tail (OC-0158). The caller fans out visibility changes from the returned
// before/after pair.
func (s *ChannelService) AdminUpdateChannel(ctx context.Context, actorID int64, existing *db.Channel, req AdminChannelUpdate, postCommitHook func()) (*db.Channel, error) {
	meta, err := cleanChannelMeta(req.Name, req.Topic, req.Category)
	if err != nil {
		return nil, err
	}
	switch {
	case req.SlowMode < 0 || req.SlowMode > maxSlowModeSeconds:
		return nil, fmt.Errorf("%w: slow_mode must be between 0 and %d seconds", ErrBadRequest, maxSlowModeSeconds)
	case req.VoiceMaxUsers < 0 || req.VoiceMaxUsers > maxVoiceLimit:
		return nil, fmt.Errorf("%w: voice_max_users must be between 0 and %d", ErrBadRequest, maxVoiceLimit)
	case req.VoiceMaxVideo < 0 || req.VoiceMaxVideo > maxVoiceLimit:
		return nil, fmt.Errorf("%w: voice_max_video must be between 0 and %d", ErrBadRequest, maxVoiceLimit)
	}

	if err := s.st.AdminUpdateChannel(ctx, existing.ID, db.ChannelUpdate{
		Name:          meta.Name,
		Topic:         meta.Topic,
		Category:      meta.Category,
		SlowMode:      req.SlowMode,
		Position:      req.Position,
		Archived:      req.Archived,
		NSFW:          req.NSFW,
		VoiceMaxUsers: req.VoiceMaxUsers,
		VoiceMaxVideo: req.VoiceMaxVideo,
	}); err != nil {
		return nil, fmt.Errorf("%w: failed to update channel: %w", ErrInternal, err)
	}

	tail := context.WithoutCancel(ctx)
	if postCommitHook != nil {
		postCommitHook()
	}
	slog.Info("channel updated", "actor_id", actorID, "channel_id", existing.ID, "name", meta.Name, "nsfw", req.NSFW)
	db.WriteAudit(tail, s.st, actorID, "channel_update", "channel", existing.ID,
		fmt.Sprintf("updated #%s%s", meta.Name, nsfwAuditSuffix(existing.NSFW, req.NSFW)))

	updated, err := s.st.GetChannel(tail, existing.ID)
	if err != nil || updated == nil {
		return nil, fmt.Errorf("%w: failed to fetch updated channel: %w", ErrInternal, err)
	}
	return updated, nil
}

// nsfwAuditSuffix names an NSFW transition in the audit detail, or returns ""
// when the flag did not move — the one part of a channel edit an operator may
// need to answer for later.
func nsfwAuditSuffix(before, after bool) string {
	if before == after {
		return ""
	}
	if after {
		return " (marked NSFW)"
	}
	return " (unmarked NSFW)"
}

// AdminDeleteChannel owns the delete ordering: archive first, then the
// caller-supplied voice eviction, then the row delete on an uncancellable
// tail.
//
//   - Archive BEFORE evicting: CleanupVoiceForChannel snapshots participants
//     once, so a voice_join racing the delete could otherwise pass the
//     archived gate and insert a voice_states row after the snapshot but
//     before the cascade — orphaning that joiner's hub state and LiveKit
//     session with no DB row left for any sweep (OC-0035). Persisting
//     archived=1 first makes voice_join's archived check refuse the race.
//   - Evict BEFORE deleting: the voice_states FK cascade wipes the rows the
//     cleanup reads.
//   - Delete on the tail: the archive (and eviction) already committed, so a
//     caller disconnect must not leave the channel silently archived,
//     unbroadcast and unaudited (OC-0010).
//
// evictVoice is the hub's CleanupVoiceForChannel (nil in hub-less tests).
// When the delete itself fails after the archive committed, the archived row
// is returned with the error so the caller can tell connected clients about
// the state that DID change.
func (s *ChannelService) AdminDeleteChannel(ctx context.Context, actorID int64, existing *db.Channel, evictVoice func(channelID int64)) (archivedRow *db.Channel, err error) {
	if !existing.Archived {
		if err := s.st.AdminUpdateChannel(ctx, existing.ID, db.ChannelUpdate{
			Name:          existing.Name,
			Topic:         existing.Topic,
			Category:      existing.Category,
			SlowMode:      existing.SlowMode,
			Position:      existing.Position,
			Archived:      true,
			NSFW:          existing.NSFW,
			VoiceMaxUsers: existing.VoiceMaxUsers,
			VoiceMaxVideo: existing.VoiceMaxVideo,
		}); err != nil {
			return nil, fmt.Errorf("%w: failed to delete channel: %w", ErrInternal, err)
		}
	}

	if evictVoice != nil {
		evictVoice(existing.ID)
	}

	delCtx := context.WithoutCancel(ctx)
	if err := s.st.AdminDeleteChannel(delCtx, existing.ID); err != nil {
		if !existing.Archived {
			if archived, gErr := s.st.GetChannel(delCtx, existing.ID); gErr == nil && archived != nil {
				return archived, fmt.Errorf("%w: failed to delete channel: %w", ErrInternal, err)
			}
		}
		return nil, fmt.Errorf("%w: failed to delete channel: %w", ErrInternal, err)
	}
	slog.Warn("channel deleted", "actor_id", actorID, "channel_id", existing.ID, "name", existing.Name)
	db.WriteAudit(delCtx, s.st, actorID, "channel_delete", "channel", existing.ID,
		fmt.Sprintf("deleted #%s", existing.Name))
	return nil, nil
}
