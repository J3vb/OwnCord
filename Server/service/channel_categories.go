package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// Channel categories: a row with an id, name and position. Rename, reorder and delete
// change the category fields of channels in touched categories, so each returns the changed
// channels for the caller to re-broadcast as channel_update before the new list.

// CategoryStore is the persistence behind the category operations; a Store that is not a
// *db.DB makes them answer ErrInternal. Kept beside Store because Store's surface is
// ratcheted (datastore_ratchet_test.go).
type CategoryStore interface {
	ListChannelCategories(ctx context.Context) ([]db.ChannelCategory, error)
	GetChannelCategory(ctx context.Context, id int64) (*db.ChannelCategory, error)
	FindChannelCategoryByName(ctx context.Context, name string) (*db.ChannelCategory, error)
	CreateChannelCategory(ctx context.Context, name string) (*db.ChannelCategory, error)
	RenameChannelCategory(ctx context.Context, id int64, name string) error
	ReorderChannelCategories(ctx context.Context, ids []int64) error
	DeleteChannelCategory(ctx context.Context, id int64) error
	CreateChannelIn(ctx context.Context, c db.NewChannel) (int64, error)
}

// CategoryChange is the committed outcome of a category mutation: Categories is the full
// list after, Category the touched row (nil after a delete), Channels every channel whose
// category fields changed, read after commit.
type CategoryChange struct {
	Categories []db.ChannelCategory
	Category   *db.ChannelCategory
	Channels   []db.Channel
}

func (s *ChannelService) categoryStore() (CategoryStore, error) {
	if s.cats == nil {
		return nil, fmt.Errorf("%w: category storage unavailable", ErrInternal)
	}
	return s.cats, nil
}

func cleanCategoryName(name string) (string, error) {
	cleaned, err := cleanChannelField(name, MaxChannelCategoryLen, "category name")
	if err != nil {
		return "", err
	}
	if cleaned == "" {
		return "", fmt.Errorf("category name is required%.0w", ErrBadRequest)
	}
	return cleaned, nil
}

// ListCategories returns every category ordered by (position, id).
func (s *ChannelService) ListCategories(ctx context.Context) ([]db.ChannelCategory, error) {
	cs, err := s.categoryStore()
	if err != nil {
		return nil, err
	}
	cats, err := cs.ListChannelCategories(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list categories: %w", ErrInternal, err)
	}
	return cats, nil
}

// CreateCategory appends a category; a name another category has, ignoring case, is ErrConflict.
func (s *ChannelService) CreateCategory(ctx context.Context, actorID int64, name string) (CategoryChange, error) {
	cs, err := s.categoryStore()
	if err != nil {
		return CategoryChange{}, err
	}
	clean, err := cleanCategoryName(name)
	if err != nil {
		return CategoryChange{}, err
	}
	cat, err := cs.CreateChannelCategory(ctx, clean)
	if err != nil {
		return CategoryChange{}, mapCategoryErr(err, "create")
	}
	tail := context.WithoutCancel(ctx)
	slog.Info("channel category created", "actor_id", actorID, "category_id", cat.ID)
	db.WriteAudit(tail, s.st, actorID, "category_create", "category", cat.ID,
		fmt.Sprintf("created category %s", cat.Name))
	return s.categoryChange(tail, cat, nil)
}

// RenameCategory renames a category: ErrNotFound when gone, ErrConflict on a taken name (case-insensitive).
func (s *ChannelService) RenameCategory(ctx context.Context, actorID, id int64, name string) (CategoryChange, error) {
	cs, err := s.categoryStore()
	if err != nil {
		return CategoryChange{}, err
	}
	clean, err := cleanCategoryName(name)
	if err != nil {
		return CategoryChange{}, err
	}
	before, err := s.channelsSnapshot(ctx)
	if err != nil {
		return CategoryChange{}, err
	}
	old, err := cs.GetChannelCategory(ctx, id)
	if err != nil {
		return CategoryChange{}, fmt.Errorf("%w: failed to fetch category: %w", ErrInternal, err)
	}
	if old == nil {
		return CategoryChange{}, fmt.Errorf("category not found%.0w", ErrNotFound)
	}
	if err := cs.RenameChannelCategory(ctx, id, clean); err != nil {
		return CategoryChange{}, mapCategoryErr(err, "rename")
	}
	tail := context.WithoutCancel(ctx)
	cat, err := cs.GetChannelCategory(tail, id)
	if err != nil || cat == nil {
		return CategoryChange{}, fmt.Errorf("%w: failed to fetch renamed category: %w", ErrInternal, err)
	}
	slog.Info("channel category renamed", "actor_id", actorID, "category_id", id)
	db.WriteAudit(tail, s.st, actorID, "category_rename", "category", id,
		fmt.Sprintf("renamed category %s to %s", old.Name, cat.Name))
	return s.categoryChange(tail, cat, before)
}

// ReorderCategories sets the order to ids, which must be exactly the current set. A stale
// set is ErrConflict and nothing is written.
func (s *ChannelService) ReorderCategories(ctx context.Context, actorID int64, ids []int64) (CategoryChange, error) {
	cs, err := s.categoryStore()
	if err != nil {
		return CategoryChange{}, err
	}
	seen := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		if id <= 0 {
			return CategoryChange{}, fmt.Errorf("ids must be category ids%.0w", ErrBadRequest)
		}
		if _, dup := seen[id]; dup {
			return CategoryChange{}, fmt.Errorf("ids must not repeat%.0w", ErrBadRequest)
		}
		seen[id] = struct{}{}
	}
	before, err := s.channelsSnapshot(ctx)
	if err != nil {
		return CategoryChange{}, err
	}
	if err := cs.ReorderChannelCategories(ctx, ids); err != nil {
		return CategoryChange{}, mapCategoryErr(err, "reorder")
	}
	tail := context.WithoutCancel(ctx)
	slog.Info("channel categories reordered", "actor_id", actorID, "count", len(ids))
	db.WriteAudit(tail, s.st, actorID, "category_reorder", "category", 0,
		fmt.Sprintf("reordered %d categories", len(ids)))
	return s.categoryChange(tail, nil, before)
}

// DeleteCategory removes a category; its channels survive with their overrides and become uncategorized.
func (s *ChannelService) DeleteCategory(ctx context.Context, actorID, id int64) (CategoryChange, error) {
	cs, err := s.categoryStore()
	if err != nil {
		return CategoryChange{}, err
	}
	before, err := s.channelsSnapshot(ctx)
	if err != nil {
		return CategoryChange{}, err
	}
	old, err := cs.GetChannelCategory(ctx, id)
	if err != nil {
		return CategoryChange{}, fmt.Errorf("%w: failed to fetch category: %w", ErrInternal, err)
	}
	if old == nil {
		return CategoryChange{}, fmt.Errorf("category not found%.0w", ErrNotFound)
	}
	if err := cs.DeleteChannelCategory(ctx, id); err != nil {
		return CategoryChange{}, mapCategoryErr(err, "delete")
	}
	tail := context.WithoutCancel(ctx)
	slog.Info("channel category deleted", "actor_id", actorID, "category_id", id)
	db.WriteAudit(tail, s.st, actorID, "category_delete", "category", id,
		fmt.Sprintf("deleted category %s", old.Name))
	return s.categoryChange(tail, nil, before)
}

func mapCategoryErr(err error, op string) error {
	switch {
	case errors.Is(err, db.ErrConflict):
		if op == "reorder" {
			return fmt.Errorf("the category list changed, reload it and try again%.0w", ErrConflict)
		}
		return fmt.Errorf("a category with that name already exists%.0w", ErrConflict)
	case errors.Is(err, db.ErrNotFound):
		return fmt.Errorf("category not found%.0w", ErrNotFound)
	default:
		return fmt.Errorf("%w: failed to %s category: %w", ErrInternal, op, err)
	}
}

func (s *ChannelService) channelsSnapshot(ctx context.Context) ([]db.Channel, error) {
	chs, err := s.st.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list channels: %w", ErrInternal, err)
	}
	return chs, nil
}

// categoryChange assembles the outcome after a committed mutation: the new list and, given
// a before snapshot, the channels whose category fields moved. Runs on the uncancellable
// tail so clients can still be told.
func (s *ChannelService) categoryChange(ctx context.Context, cat *db.ChannelCategory, before []db.Channel) (CategoryChange, error) {
	cats, err := s.cats.ListChannelCategories(ctx)
	if err != nil {
		return CategoryChange{}, fmt.Errorf("%w: failed to list categories: %w", ErrInternal, err)
	}
	out := CategoryChange{Categories: cats, Category: cat}
	if before == nil {
		return out, nil
	}
	after, err := s.st.ListChannels(ctx)
	if err != nil {
		return CategoryChange{}, fmt.Errorf("%w: failed to list channels: %w", ErrInternal, err)
	}
	out.Channels = changedCategoryFields(before, after)
	return out, nil
}

func changedCategoryFields(before, after []db.Channel) []db.Channel {
	prev := make(map[int64]*db.Channel, len(before))
	for i := range before {
		prev[before[i].ID] = &before[i]
	}
	var out []db.Channel
	for i := range after {
		b, ok := prev[after[i].ID]
		if !ok {
			continue
		}
		if b.CategoryID != after[i].CategoryID || b.Category != after[i].Category || b.CategoryPosition != after[i].CategoryPosition {
			out = append(out, after[i])
		}
	}
	return out
}

type categoryTarget struct {
	// id is the category the channel lands in, 0 for none; for an unmatched by-name request it is 0 and fresh is
	// true.
	id int64
	// name, when non-nil, is the cleaned legacy name to resolve (or create) at write time.
	name *string
	// fresh: a legacy name matching no category yet; the write creates it, so the name check has nothing to
	// find.
	fresh bool
}

// resolveCategoryTarget turns a request's category fields into a target. A legacy name
// is cleaned, matched ignoring case and created at write time when missing; empty means
// none. Otherwise categoryID must exist (ErrBadRequest). category_id wins.
func (s *ChannelService) resolveCategoryTarget(ctx context.Context, categoryID int64, byName *string) (categoryTarget, error) {
	if categoryID < 0 {
		return categoryTarget{}, fmt.Errorf("category_id must not be negative%.0w", ErrBadRequest)
	}
	if categoryID > 0 {
		if s.cats == nil {
			return categoryTarget{}, fmt.Errorf("%w: category storage unavailable", ErrInternal)
		}
		cat, err := s.cats.GetChannelCategory(ctx, categoryID)
		if err != nil {
			return categoryTarget{}, fmt.Errorf("%w: failed to fetch category: %w", ErrInternal, err)
		}
		if cat == nil {
			return categoryTarget{}, fmt.Errorf("category_id does not exist%.0w", ErrBadRequest)
		}
		return categoryTarget{id: categoryID}, nil
	}
	if byName == nil {
		return categoryTarget{}, nil
	}
	clean, err := cleanChannelField(*byName, MaxChannelCategoryLen, "category")
	if err != nil {
		return categoryTarget{}, err
	}
	if clean == "" {
		return categoryTarget{name: &clean}, nil
	}
	if s.cats == nil {
		return categoryTarget{}, fmt.Errorf("%w: category storage unavailable", ErrInternal)
	}
	found, err := s.cats.FindChannelCategoryByName(ctx, clean)
	if err != nil {
		return categoryTarget{}, fmt.Errorf("%w: failed to look up category: %w", ErrInternal, err)
	}
	if found == nil {
		return categoryTarget{name: &clean, fresh: true}, nil
	}
	return categoryTarget{id: found.ID, name: &clean}, nil
}

// auditCreatedCategory covers a category a channel write created through the legacy
// string (bypassing the category routes): it writes the category_create audit row and
// returns the fresh list, or nil when created is 0. The channel write already committed,
// so a failure here is logged and the list dropped.
func (s *ChannelService) auditCreatedCategory(tail context.Context, actorID, created int64) []db.ChannelCategory {
	if created == 0 || s.cats == nil {
		return nil
	}
	cat, err := s.cats.GetChannelCategory(tail, created)
	if err != nil || cat == nil {
		slog.Warn("created category could not be read back", "category_id", created, "error", err)
		return nil
	}
	slog.Info("channel category created", "actor_id", actorID, "category_id", created)
	db.WriteAudit(tail, s.st, actorID, "category_create", "category", created,
		fmt.Sprintf("created category %s", cat.Name))
	cats, err := s.cats.ListChannelCategories(tail)
	if err != nil {
		slog.Warn("category list unavailable after create", "category_id", created, "error", err)
		return nil
	}
	return cats
}

// resolveUpdateTarget is resolveCategoryTarget for an update. A category merely carried
// forward (KeepCategory, no legacy name) that no longer exists resolves to uncategorized,
// not ErrBadRequest: the caller never asked for it.
func (s *ChannelService) resolveUpdateTarget(ctx context.Context, req AdminChannelUpdate, legacy *string) (categoryTarget, error) {
	target, err := s.resolveCategoryTarget(ctx, req.CategoryID, legacy)
	if err != nil && req.KeepCategory && req.Category == nil && req.CategoryID > 0 && errors.Is(err, ErrBadRequest) {
		return categoryTarget{}, nil
	}
	return target, err
}
