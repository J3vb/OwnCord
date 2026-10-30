package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// Channel name, topic and category share one contract across every writer: bounds
// count runes on the cleaned value, never bytes, and values are sanitized and
// trimmed by cleanTextBounded (with its raw-byte pre-check) like every other
// sidebar-rendered free-text field.

const (
	// MaxChannelNameLen bounds channels.name; 100 matches MaxGroupDMNameLen (dm.go)
	// since both render in the same sidebar row.
	MaxChannelNameLen = 100
	// MaxChannelTopicLen bounds channels.topic, matching the client edit modal's cap.
	MaxChannelTopicLen = 1024
	// MaxChannelCategoryLen bounds a category name (sidebar group header), taking the
	// name cap.
	MaxChannelCategoryLen = 100
)

// validChannelTypes is the set of types a create may name. A channel's CATEGORY
// constrains nothing: grouping is display, so only the type is validated.
var validChannelTypes = []string{"text", "voice", "announcement", "forum"}

// ChannelMeta is the cleaned name/topic/category triple every channel write uses.
type ChannelMeta struct {
	Name     string
	Topic    string
	Category string
}

// cleanChannelMeta sanitizes, trims and rune-bounds each field and requires a
// name; every violation is ErrBadRequest with the field's own message.
func cleanChannelMeta(name, topic, category string) (ChannelMeta, error) {
	cleanName, err := cleanChannelField(name, MaxChannelNameLen, "name")
	if err != nil {
		return ChannelMeta{}, err
	}
	if cleanName == "" {
		return ChannelMeta{}, fmt.Errorf("name is required%.0w", ErrBadRequest)
	}
	cleanTopic, err := cleanChannelField(topic, MaxChannelTopicLen, "topic")
	if err != nil {
		return ChannelMeta{}, err
	}
	cleanCategory, err := cleanChannelField(category, MaxChannelCategoryLen, "category")
	if err != nil {
		return ChannelMeta{}, err
	}
	return ChannelMeta{Name: cleanName, Topic: cleanTopic, Category: cleanCategory}, nil
}

// cleanChannelField is cleanTextBounded with a prefix-free error: the body is
// exactly the validation text, so the sentinel is wrapped with %.0w instead of
// rendered (as the settings service does), keeping "bad request: ..." out of the
// admin UI.
func cleanChannelField(v string, maxRunes int, field string) (string, error) {
	cleaned, err := cleanTextBounded(v, maxRunes, field)
	if err != nil {
		return "", fmt.Errorf("%s must be at most %d characters%.0w", field, maxRunes, ErrBadRequest)
	}
	return cleaned, nil
}

// ResolveGuildChannel is the single admin-surface channel lookup: a missing
// channel and a DM both answer ErrNotFound. DMs share the channels table and id
// space but belong to their participants, and anything but "not found" confirms
// which ids are private conversations. Every sibling lookup goes through here so
// no path grows its own policy. A thread answers ErrBadRequest
// (errThreadNotAdminChannel).
func (s *ChannelService) ResolveGuildChannel(ctx context.Context, id int64) (*db.Channel, error) {
	if id <= 0 {
		return nil, fmt.Errorf("invalid channel id%.0w", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch channel: %w", ErrInternal, err)
	}
	if ch == nil || ch.Type == "dm" {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.IsThread() {
		return nil, fmt.Errorf("%w", errThreadNotAdminChannel)
	}
	return ch, nil
}

// errThreadNotAdminChannel refuses a thread id on the admin surface: a thread
// takes permissions, NSFW, archive and retention from its parent, so an override,
// edit or delete keyed by a thread id would be ignored or bypass the thread
// rules.
var errThreadNotAdminChannel = fmt.Errorf("a thread is managed through its parent channel%.0w", ErrBadRequest)

// AdminChannelCreate carries a create request's raw fields; the service cleans
// and validates them first.
type AdminChannelCreate struct {
	Name string
	Type string
	// CategoryID places the channel in that category (0 = none); it must exist and
	// wins over Category.
	CategoryID int64
	// Category is the legacy free-text category: matched by name ignoring case,
	// created when missing, empty means none. Ignored when CategoryID is set.
	Category string
	Topic    string
	Position int
}

// AdminListChannels lists guild channels only: DM rows share the table, and
// listing them exposed ids and group names to any MANAGE_CHANNELS holder.
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

// AdminCreateChannel validates per the metadata contract, persists, audits and
// returns the committed row, re-read on an uncancellable tail so a caller
// disconnect cannot leave a created channel unread and unbroadcast. The second
// result is the full category list, non-nil only when this create made a category
// through the legacy string (audited here; the handler owes managers a
// channel_categories frame).
func (s *ChannelService) AdminCreateChannel(ctx context.Context, actorID int64, req AdminChannelCreate, postCommitHook func()) (*db.Channel, []db.ChannelCategory, error) {
	if req.Type == "" {
		req.Type = "text"
	}
	if !slices.Contains(validChannelTypes, req.Type) {
		return nil, nil, fmt.Errorf("type must be one of text, voice, announcement, forum%.0w", ErrBadRequest)
	}
	// category_id wins over the legacy string, so the string is not looked at when an
	// id is sent.
	legacyText := req.Category
	if req.CategoryID != 0 {
		legacyText = ""
	}
	meta, err := cleanChannelMeta(req.Name, req.Topic, legacyText)
	if err != nil {
		return nil, nil, err
	}
	var legacy *string
	if req.CategoryID == 0 {
		legacy = &req.Category
	}
	target, err := s.resolveCategoryTarget(ctx, req.CategoryID, legacy)
	if err != nil {
		return nil, nil, err
	}
	if !target.fresh {
		if err := s.requireChannelNameFree(ctx, meta.Name, req.Type, target.id, 0); err != nil {
			return nil, nil, err
		}
	}

	id, createdCat, err := s.createChannelRow(ctx, meta, req, target)
	if err != nil {
		return nil, nil, err
	}

	tail := context.WithoutCancel(ctx)
	if postCommitHook != nil {
		postCommitHook()
	}
	ch, err := s.st.GetChannel(tail, id)
	if err != nil || ch == nil {
		return nil, nil, fmt.Errorf("%w: failed to fetch created channel: %w", ErrInternal, err)
	}
	// A channel created in a category starts as a copy of its template: drop the
	// affected members' cached permissions before the broadcast so it resolves
	// visibility afresh.
	s.invalidatePermEffect(s.templateEffect(tail, ch.CategoryID))
	slog.Info("channel created", "actor_id", actorID, "channel", meta.Name, "type", req.Type)
	db.WriteAudit(tail, s.st, actorID, "channel_create", "channel", id,
		fmt.Sprintf("created #%s (%s)", meta.Name, req.Type))
	return ch, s.auditCreatedCategory(tail, actorID, createdCat), nil
}

// createChannelRow persists a new channel. A named category goes through
// CategoryStore.CreateChannelIn so resolve-or-create and insert share one
// transaction; no category keeps the plain Store path. created is the id of a
// category the write made (0 if none).
func (s *ChannelService) createChannelRow(ctx context.Context, meta ChannelMeta, req AdminChannelCreate, target categoryTarget) (id, created int64, err error) {
	if target.id == 0 && target.name == nil {
		id, err = s.st.AdminCreateChannel(ctx, meta.Name, req.Type, "", meta.Topic, req.Position)
		if err != nil {
			return 0, 0, fmt.Errorf("%w: failed to create channel: %w", ErrInternal, err)
		}
		return id, 0, nil
	}
	if target.name != nil && *target.name == "" {
		id, err = s.st.AdminCreateChannel(ctx, meta.Name, req.Type, "", meta.Topic, req.Position)
		if err != nil {
			return 0, 0, fmt.Errorf("%w: failed to create channel: %w", ErrInternal, err)
		}
		return id, 0, nil
	}
	cs, err := s.categoryStore()
	if err != nil {
		return 0, 0, err
	}
	nc := db.NewChannel{Name: meta.Name, Type: req.Type, Topic: meta.Topic, Position: req.Position, CreatedCategory: &created}
	if target.name != nil {
		nc.CategoryName = *target.name
	} else {
		nc.CategoryID = target.id
	}
	id, err = cs.CreateChannelIn(ctx, nc)
	switch {
	case errors.Is(err, db.ErrNotFound):
		return 0, 0, fmt.Errorf("category_id does not exist%.0w", ErrBadRequest)
	case err != nil:
		return 0, 0, fmt.Errorf("%w: failed to create channel: %w", ErrInternal, err)
	}
	return id, created, nil
}

// requireChannelNameFree refuses (ErrConflict) a name another channel of the same
// type in the same category (0 = uncategorized) already has, ignoring case.
// selfID is the channel being renamed (0 on create). A check, not a constraint:
// rows already sharing a name are left alone.
func (s *ChannelService) requireChannelNameFree(ctx context.Context, name, chType string, categoryID, selfID int64) error {
	channels, err := s.st.ListChannels(ctx)
	if err != nil {
		return fmt.Errorf("%w: failed to list channels: %w", ErrInternal, err)
	}
	for i := range channels {
		c := &channels[i]
		if c.ID != selfID && c.Type == chType && c.CategoryID == categoryID && strings.EqualFold(c.Name, name) {
			return fmt.Errorf("a %s channel named %q already exists in this category%.0w", chType, c.Name, ErrConflict)
		}
	}
	return nil
}

// AdminChannelUpdate carries a full update, pre-filled by the handler from the
// existing row so a partial PATCH is safe; text fields are cleaned per the
// metadata contract.
type AdminChannelUpdate struct {
	Name  string
	Topic string
	// CategoryID is the category the channel ends up in (0 = none); it must exist and
	// wins over Category. Category, when non-nil and CategoryID is 0, is the legacy
	// free-text category (matched ignoring case, created when missing, empty means
	// none). The handler pre-fills CategoryID, so a body naming neither leaves the
	// category alone.
	CategoryID int64
	Category   *string
	// KeepCategory marks CategoryID as the channel's own current category, carried
	// forward because the request named none; if it was deleted meanwhile the channel
	// falls back to uncategorized instead of failing. Ignored when a category was named.
	KeepCategory  bool
	SlowMode      int
	Position      int
	Archived      bool
	NSFW          bool
	VoiceMaxUsers int
	VoiceMaxVideo int
	// SyncPermissions replaces the channel's role and member overrides with the
	// template of the category it ends up in and marks it synced, in the update's
	// transaction. It needs an existing category (ErrBadRequest) and ActorRole, and
	// is refused (ErrForbidden) when the actor could not have written the rows it
	// touches. Without it a move keeps the overrides and unsyncs the channel.
	SyncPermissions bool
	ActorRole       *db.Role
}

// AdminUpdateChannel validates (metadata contract and numeric bounds), persists,
// audits and returns the row read on the uncancellable tail; the caller fans out
// visibility changes from the before/after pair. The second result is the full
// category list, non-nil only when the update created a category through the
// legacy string (audited here; the handler broadcasts it).
func (s *ChannelService) AdminUpdateChannel(ctx context.Context, actorID int64, existing *db.Channel, req AdminChannelUpdate, postCommitHook func()) (*db.Channel, []db.ChannelCategory, error) {
	meta, err := cleanChannelMeta(req.Name, req.Topic, "")
	if err != nil {
		return nil, nil, err
	}
	var legacy *string
	if req.CategoryID == 0 {
		legacy = req.Category
	}
	target, err := s.resolveUpdateTarget(ctx, req, legacy)
	if err != nil {
		return nil, nil, err
	}
	if err := validateChannelBounds(req); err != nil {
		return nil, nil, err
	}
	// Only a rename or move is checked, so rows already sharing a name stay editable.
	if !target.fresh && (!strings.EqualFold(meta.Name, existing.Name) || target.id != existing.CategoryID) {
		if err := s.requireChannelNameFree(ctx, meta.Name, existing.Type, target.id, existing.ID); err != nil {
			return nil, nil, err
		}
	}

	var createdCat int64
	var refused error
	var syncPlan db.ChannelSyncPlan
	update := db.ChannelUpdate{
		Name:         meta.Name,
		Topic:        meta.Topic,
		CategoryID:   target.id,
		CategoryName: target.name,
		// A carried category that vanished means uncategorized; a named one was checked
		// above and must still exist.
		CategoryIfExists: req.KeepCategory && req.Category == nil,
		CreatedCategory:  &createdCat,
		SlowMode:         req.SlowMode,
		Position:         req.Position,
		Archived:         req.Archived,
		NSFW:             req.NSFW,
		VoiceMaxUsers:    req.VoiceMaxUsers,
		VoiceMaxVideo:    req.VoiceMaxVideo,
		SyncPlan:         &syncPlan,
	}
	if err := s.prepareUpdateSync(ctx, req, existing.ID, target.id, &update, &refused); err != nil {
		return nil, nil, err
	}
	// Clearing the flag deletes the channel's standing acknowledgements in the SAME
	// transaction as the flag write, so a later re-label re-prompts everyone. It
	// keys on the RESULTING flag (req.NSFW == false), not a 1-to-0 transition from the
	// stale `existing` snapshot: a concurrent edit that labelled the channel and was
	// immediately acknowledged would otherwise skip the delete and leave an
	// acknowledgement from a DIFFERENT labelling.
	var writeErr error
	if !req.NSFW {
		writeErr = s.st.AdminUpdateChannelClearingNSFW(ctx, existing.ID, update)
	} else {
		writeErr = s.st.AdminUpdateChannel(ctx, existing.ID, update)
	}
	if refused != nil && writeErr != nil {
		return nil, nil, refused
	}
	if errors.Is(writeErr, db.ErrNotFound) {
		// The category was deleted between the check above and the write.
		return nil, nil, fmt.Errorf("category_id does not exist%.0w", ErrBadRequest)
	}
	if errors.Is(writeErr, db.ErrUncategorized) {
		return nil, nil, fmt.Errorf("channel has no category to sync with%.0w", ErrBadRequest)
	}
	if writeErr != nil {
		return nil, nil, fmt.Errorf("%w: failed to update channel: %w", ErrInternal, writeErr)
	}

	tail := context.WithoutCancel(ctx)
	if postCommitHook != nil {
		postCommitHook()
	}
	syncEffect := s.afterUpdateSync(tail, actorID, existing, req, syncPlan)
	slog.Info("channel updated", "actor_id", actorID, "channel_id", existing.ID, "name", meta.Name, "nsfw", req.NSFW)
	db.WriteAudit(tail, s.st, actorID, "channel_update", "channel", existing.ID,
		fmt.Sprintf("updated #%s%s", meta.Name, nsfwAuditSuffix(existing.NSFW, req.NSFW)))

	updated, err := s.st.GetChannel(tail, existing.ID)
	if err != nil || updated == nil {
		return nil, nil, fmt.Errorf("%w: failed to fetch updated channel: %w", ErrInternal, err)
	}
	// A sync replaced override rows: the cache is dropped, so re-derive the audience
	// from the post-sync rows.
	s.notifyAudienceIf(syncEffect.Applied, updated)
	return updated, s.auditCreatedCategory(tail, actorID, createdCat), nil
}

// AdminDeleteChannel owns the delete ordering: archive, then the caller's voice
// eviction, then the row delete on an uncancellable tail.
//
//   - Archive BEFORE evicting: CleanupVoiceForChannel snapshots participants
//     once, so a racing voice_join could pass the archived gate and insert a
//     voice_states row after the snapshot but before the cascade, orphaning that
//     joiner's hub state and LiveKit session. archived=1 first makes voice_join
//     refuse the race.
//   - Evict BEFORE deleting: the voice_states FK cascade wipes the rows the
//     cleanup reads.
//   - Delete on the tail: archive and eviction committed, so a disconnect must not
//     leave the channel silently archived, unbroadcast and unaudited.
//
// evictVoice is the hub's CleanupVoiceForChannel (nil in hub-less tests). If the
// delete fails after the archive committed, the archived row is returned with the
// error so the caller can tell clients about the state that did change.
func (s *ChannelService) AdminDeleteChannel(ctx context.Context, actorID int64, existing *db.Channel, evictVoice func(channelID int64)) (archivedRow *db.Channel, err error) {
	if !existing.Archived {
		if err := s.st.AdminUpdateChannel(ctx, existing.ID, db.ChannelUpdate{
			Name:       existing.Name,
			Topic:      existing.Topic,
			CategoryID: existing.CategoryID,
			// The channel is about to go; a category deleted since the handler read the row
			// must not stop the archive.
			CategoryIfExists: true,
			SlowMode:         existing.SlowMode,
			Position:         existing.Position,
			Archived:         true,
			NSFW:             existing.NSFW,
			VoiceMaxUsers:    existing.VoiceMaxUsers,
			VoiceMaxVideo:    existing.VoiceMaxVideo,
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
