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

// ─── The channel metadata contract ─────────────────────────────────────
//
// One explicit rune/normalization contract for channel name, topic and
// category, shared by every writer (the admin CRUD here; group DM names
// already run the same machinery with MaxGroupDMNameLen matching the name
// cap). Bounds count runes on the cleaned value, never bytes; values are
// sanitized and trimmed by cleanTextBounded exactly like every other
// sidebar-rendered free-text field, with its raw-byte pre-check in front of
// the quadratic sanitizer.

const (
	// MaxChannelNameLen bounds channels.name. 100 is the cap
	// MaxGroupDMNameLen (dm.go) has always claimed to match: both render in
	// the same sidebar row, so anything longer is only ever shown clipped.
	MaxChannelNameLen = 100
	// MaxChannelTopicLen bounds channels.topic — the client's edit modal has
	// always capped its input at 1024; the server now enforces the same.
	MaxChannelTopicLen = 1024
	// MaxChannelCategoryLen bounds a category name (channel_categories.name,
	// and the legacy free-text category field). Categories render as sidebar
	// group headers, so they take the name cap.
	MaxChannelCategoryLen = 100
)

// validChannelTypes is the set of channel types a create may name. A
// channel's CATEGORY deliberately constrains nothing: grouping is a display
// concern, so the server validates the type alone (see the admin handler's
// original rationale, kept verbatim through the move).
var validChannelTypes = []string{"text", "voice", "announcement", "forum"}

// ChannelMeta is the cleaned, validated name/topic/category triple every
// channel write goes through.
type ChannelMeta struct {
	Name     string
	Topic    string
	Category string
}

// cleanChannelMeta applies the channel metadata contract: sanitize + trim each field,
// bound by runes, and require a non-empty name. Every violation is
// ErrBadRequest with the field's own message.
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

// cleanChannelField is cleanTextBounded with the admin channel surface's
// prefix-free error contract: the response body is exactly the validation
// text, so the sentinel is wrapped with %.0w instead of rendered (the same
// scheme the settings service uses; a review caught the prefixed form
// leaking "bad request: ..." into the admin UI).
func cleanChannelField(v string, maxRunes int, field string) (string, error) {
	cleaned, err := cleanTextBounded(v, maxRunes, field)
	if err != nil {
		return "", fmt.Errorf("%s must be at most %d characters%.0w", field, maxRunes, ErrBadRequest)
	}
	return cleaned, nil
}

// ─── The one non-DM resolution policy ──────────────────────────────────

// ResolveGuildChannel is the single admin-surface channel lookup: a missing
// channel and a DM channel both answer ErrNotFound, indistinguishably. DMs
// share the channels table and id space with guild channels, but they belong
// to their participants, not to MANAGE_CHANNELS holders — and answering a DM
// id with anything but "not found" confirms which ids are private
// conversations (A-2026-08-02). Every sibling lookup goes through here so no
// path can grow its own policy again. A thread answers ErrBadRequest
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

// errThreadNotAdminChannel refuses a thread id on the admin channel surface.
// A thread takes its permissions, NSFW, archive and retention from
// its parent, so an override, edit or delete keyed by a thread id would
// either be ignored or bypass the thread rules; the parent is the channel to
// manage.
var errThreadNotAdminChannel = fmt.Errorf("a thread is managed through its parent channel%.0w", ErrBadRequest)

// ─── Admin channel CRUD ──────────────────────────────────────────────────────

// AdminChannelCreate carries a create request's raw fields; the service
// cleans and validates them before anything persists.
type AdminChannelCreate struct {
	Name string
	Type string
	// CategoryID places the channel in that category (0 = none). It must
	// exist and wins over Category.
	CategoryID int64
	// Category is the legacy free-text category: matched by name ignoring
	// case, created when missing, empty means none. Ignored when CategoryID
	// is set.
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

// AdminCreateChannel validates per the channel metadata contract, persists, audits, and returns the
// committed row. The re-read runs on an uncancellable tail: once the row has
// committed, a caller disconnect must not leave a durably created channel
// unread and unbroadcast — the caller fans out from the returned
// row.
//
// The second result is the full category list, non-nil only when this create
// made a new category through the legacy category string: that category is
// audited here and the handler owes managers a channel_categories frame.
func (s *ChannelService) AdminCreateChannel(ctx context.Context, actorID int64, req AdminChannelCreate, postCommitHook func()) (*db.Channel, []db.ChannelCategory, error) {
	if req.Type == "" {
		req.Type = "text"
	}
	if !slices.Contains(validChannelTypes, req.Type) {
		return nil, nil, fmt.Errorf("type must be one of text, voice, announcement, forum%.0w", ErrBadRequest)
	}
	// category_id wins over the legacy string, so the string is not even
	// looked at when an id is sent.
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
	// A channel created in a category starts as a copy of its template: drop
	// the affected members' cached permissions before the caller broadcasts
	// the new channel, so that broadcast resolves who may see it afresh.
	s.invalidatePermEffect(s.templateEffect(tail, ch.CategoryID))
	slog.Info("channel created", "actor_id", actorID, "channel", meta.Name, "type", req.Type)
	db.WriteAudit(tail, s.st, actorID, "channel_create", "channel", id,
		fmt.Sprintf("created #%s (%s)", meta.Name, req.Type))
	return ch, s.auditCreatedCategory(tail, actorID, createdCat), nil
}

// createChannelRow persists a new channel. A category the request names goes
// through CategoryStore.CreateChannelIn so the category resolve-or-create and
// the insert share one transaction; a channel with no category keeps the plain
// Store path. created is the id of a category the write made (0 if none).
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

// requireChannelNameFree refuses a name another channel of the same type in
// the same category (categoryID, 0 = uncategorized) already has, ignoring
// case, with ErrConflict. selfID is the channel being renamed (0 on create). A
// check, not a constraint: rows that already share a name are left as they
// are.
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

// AdminChannelUpdate carries a full update — the handler pre-fills it from
// the existing row so a partial PATCH body is safe — with the raw text
// fields cleaned here per the channel metadata contract.
type AdminChannelUpdate struct {
	Name  string
	Topic string
	// CategoryID is the category the channel ends up in (0 = none); it must
	// exist and wins over Category. Category, when non-nil and CategoryID is
	// 0, is the legacy free-text category: matched by name ignoring case,
	// created when missing, empty means none. The handler pre-fills
	// CategoryID from the existing row, so a body that names neither leaves
	// the category alone.
	CategoryID int64
	Category   *string
	// KeepCategory marks CategoryID as the channel's own current category,
	// carried forward because the request named none. If that category was
	// deleted in the meantime the channel falls back to uncategorized instead
	// of the update failing. Ignored when the request named a category.
	KeepCategory  bool
	SlowMode      int
	Position      int
	Archived      bool
	NSFW          bool
	VoiceMaxUsers int
	VoiceMaxVideo int
	// SyncPermissions replaces the channel's role and member overrides with the
	// template of the category it ends up in and marks it synced, in the same
	// transaction as the update. It needs an existing category
	// (ErrBadRequest otherwise) and ActorRole, and is refused (ErrForbidden)
	// when the actor could not have written the rows it removes or writes.
	// Without it a move keeps the channel's overrides and unsyncs it.
	SyncPermissions bool
	ActorRole       *db.Role
	// Password sets, changes or removes a voice channel's password: nil leaves
	// it alone, "" removes it, anything else is the new password. Any value on
	// a channel that is not a voice channel is refused (ErrBadRequest).
	Password *string
}

// AdminUpdateChannel validates (the metadata text contract + numeric bounds),
// persists, audits, and returns the committed row read on the uncancellable
// tail. The caller fans out visibility changes from the returned
// before/after pair. The second result is the full category list, non-nil
// only when the update created a category through the legacy category string
// (audited here; the handler broadcasts it to managers).
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
	pwChange, err := validateChannelUpdate(existing, req)
	if err != nil {
		return nil, nil, err
	}
	// Only a rename or a move is checked, so rows that already share a name
	// stay editable.
	if !target.fresh && (!strings.EqualFold(meta.Name, existing.Name) || target.id != existing.CategoryID) {
		if err := s.requireChannelNameFree(ctx, meta.Name, existing.Type, target.id, existing.ID); err != nil {
			return nil, nil, err
		}
	}

	var createdCat int64
	var refused error
	var syncPlan db.ChannelSyncPlan
	update := db.ChannelUpdate{
		Password:     pwChange,
		Name:         meta.Name,
		Topic:        meta.Topic,
		CategoryID:   target.id,
		CategoryName: target.name,
		// A carried category that vanished means uncategorized; one the
		// request named was checked above and must still exist.
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
	// Clearing the flag deletes the channel's standing
	// acknowledgements in the SAME transaction as the flag write, so a later
	// re-label re-prompts everyone rather than trusting consent given for a
	// different warning. Flipping the flag ON writes nothing extra.
	//
	// Gated on the RESULTING flag (req.NSFW == false), not a 1→0
	// transition read from the stale `existing` snapshot this handler was
	// dispatched with. Two concurrent edits — this one, which read
	// existing.NSFW == false, and another that labelled the channel and was
	// immediately acknowledged in between — must not let this edit's
	// unconditional "nothing to clear" assumption skip the delete: whatever
	// existing.NSFW says, an edit that turns the flag off (or leaves it off)
	// always clears, so no acknowledgement row for a DIFFERENT labelling
	// survives it.
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
		fmt.Sprintf("updated #%s%s%s", meta.Name, nsfwAuditSuffix(existing.NSFW, req.NSFW),
			passwordAuditSuffix(existing.PasswordProtected, pwChange)))

	updated, err := s.st.GetChannel(tail, existing.ID)
	if err != nil || updated == nil {
		return nil, nil, fmt.Errorf("%w: failed to fetch updated channel: %w", ErrInternal, err)
	}
	// A sync replaced override rows: the cache is already dropped, so the
	// audience is re-derived from the post-sync rows.
	s.notifyAudienceIf(syncEffect.Applied, updated)
	return updated, s.auditCreatedCategory(tail, actorID, createdCat), nil
}

// AdminDeleteChannel owns the delete ordering: archive first, then the
// caller-supplied voice eviction, then the row delete on an uncancellable
// tail.
//
//   - Archive BEFORE evicting: CleanupVoiceForChannel snapshots participants
//     once, so a voice_join racing the delete could otherwise pass the
//     archived gate and insert a voice_states row after the snapshot but
//     before the cascade — orphaning that joiner's hub state and LiveKit
//     session with no DB row left for any sweep. Persisting
//     archived=1 first makes voice_join's archived check refuse the race.
//   - Evict BEFORE deleting: the voice_states FK cascade wipes the rows the
//     cleanup reads.
//   - Delete on the tail: the archive (and eviction) already committed, so a
//     caller disconnect must not leave the channel silently archived,
//     unbroadcast and unaudited.
//
// evictVoice is the hub's CleanupVoiceForChannel (nil in hub-less tests).
// When the delete itself fails after the archive committed, the archived row
// is returned with the error so the caller can tell connected clients about
// the state that DID change.
func (s *ChannelService) AdminDeleteChannel(ctx context.Context, actorID int64, existing *db.Channel, evictVoice func(channelID int64)) (archivedRow *db.Channel, err error) {
	if !existing.Archived {
		if err := s.st.AdminUpdateChannel(ctx, existing.ID, db.ChannelUpdate{
			Name:       existing.Name,
			Topic:      existing.Topic,
			CategoryID: existing.CategoryID,
			// The channel is about to go; a category deleted since the
			// handler read the row must not stop the archive.
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
