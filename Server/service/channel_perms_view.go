package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Saving overrides on a channel (its own rows, a category template that reaches it, a
// sync to the template) also needs the editor's own access there: the owner and an
// Administrator always, anyone else only on a channel they can currently read
// (permissions.CanEditChannelOverrides). The bit and hierarchy guards still apply.

// errOverrideNoView is the refusal for an override edit on a channel the editor cannot read.
const errOverrideNoView = "cannot manage permissions on a channel you cannot view"

// requireOverrideView refuses an override edit on channelID unless the actor may edit there.
func (s *channelOverrides) requireOverrideView(ctx context.Context, actorID int64, actorRole *db.Role, channelID int64) error {
	if actorRole == nil {
		return fmt.Errorf("not authenticated%.0w", ErrForbidden)
	}
	if permissions.CanEditAnyChannelOverrides(actorRole.Permissions, actorRole.ID, actorRole.Position) {
		return nil
	}
	if s.perms == nil {
		return fmt.Errorf("%w: permission service unavailable", ErrInternal)
	}
	sub, err := s.perms.Subject(ctx, actorID, channelID)
	if err != nil {
		return fmt.Errorf("%w: failed to resolve channel access: %w", ErrInternal, err)
	}
	if err := permissions.CanEditChannelOverrides(sub, actorRole.ID, actorRole.Position); err != nil {
		return fmt.Errorf("%s%.0w", errOverrideNoView, ErrForbidden)
	}
	return nil
}

// categoryViewGate checks, before a template write, every channel synced with the
// category, and returns the test the in-transaction guard applies to the channels the
// write actually reaches: a channel synced in between was not checked, so the write is
// refused as a conflict to retry.
func (s *channelOverrides) categoryViewGate(ctx context.Context, cp CategoryPermStore, actorID int64, actorRole *db.Role, categoryID int64) (func(channelID int64) bool, error) {
	if actorRole == nil {
		return nil, fmt.Errorf("not authenticated%.0w", ErrForbidden)
	}
	if permissions.CanEditAnyChannelOverrides(actorRole.Permissions, actorRole.ID, actorRole.Position) {
		return func(int64) bool { return true }, nil
	}
	ids, err := cp.ListSyncedChannelIDs(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list synced channels: %w", ErrInternal, err)
	}
	checked := make(map[int64]struct{})
	for _, id := range ids {
		ch, err := s.st.GetChannel(ctx, id)
		if err != nil {
			return nil, fmt.Errorf("%w: failed to fetch channel: %w", ErrInternal, err)
		}
		if ch == nil || ch.CategoryID != categoryID {
			continue
		}
		if err := s.requireOverrideView(ctx, actorID, actorRole, id); err != nil {
			return nil, err
		}
		checked[id] = struct{}{}
	}
	return func(channelID int64) bool {
		_, ok := checked[channelID]
		return ok
	}, nil
}
