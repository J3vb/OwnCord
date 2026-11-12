package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// Syncing a channel to its category's template: the sync endpoint, a channel PATCH with
// sync_permissions, and (replacing nothing) a create inside a category. Replacing rows is
// authorized like writing them: the escalation guard covers the union of rows removed and
// written, hierarchy rules every role and member named. Create checks nothing: copying a
// template is no grant by the creator, since the template was guarded when written.

// ErrPermsChanged reports a sync found override rows it had not checked because they
// changed between check and write. Nothing was written; retry. Also an ErrConflict.
var ErrPermsChanged = errors.New("channel permissions changed while syncing, try again")

type syncApproval struct {
	roles map[int64]struct{}
	users map[int64]struct{}
}

func planRows(p db.ChannelSyncPlan) []db.OverrideRow {
	rows := make([]db.OverrideRow, 0, len(p.Removed.Roles)+len(p.Removed.Users)+len(p.Written.Roles)+len(p.Written.Users))
	rows = append(rows, p.Removed.Roles...)
	rows = append(rows, p.Removed.Users...)
	rows = append(rows, p.Written.Roles...)
	rows = append(rows, p.Written.Users...)
	return rows
}

// prepareSync resolves, before the write transaction, who the replace would touch, applies
// the hierarchy rules, and returns the guard for inside the transaction. The guard does no
// store reads (the writer connection is held): it verifies the shown rows were checked
// and runs the escalation guard over their union; a refusal is also recorded in *refused.
func (s *channelOverrides) prepareSync(ctx context.Context, actorRole *db.Role, channelID, categoryID int64, refused *error) (db.ChannelSyncGuard, error) {
	cp, err := s.catPermStore()
	if err != nil {
		return nil, err
	}
	if actorRole == nil {
		return nil, fmt.Errorf("not authenticated%.0w", ErrForbidden)
	}
	preview, err := cp.PreviewChannelSync(ctx, channelID, categoryID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read channel permissions: %w", ErrInternal, err)
	}
	ok := syncApproval{roles: map[int64]struct{}{}, users: map[int64]struct{}{}}
	for _, rows := range [][]db.OverrideRow{preview.Removed.Roles, preview.Written.Roles} {
		for _, r := range rows {
			if _, done := ok.roles[r.TargetID]; done {
				continue
			}
			if _, err := s.resolveCategoryRoleTarget(ctx, actorRole, r.TargetID); err != nil {
				return nil, err
			}
			ok.roles[r.TargetID] = struct{}{}
		}
	}
	for _, rows := range [][]db.OverrideRow{preview.Removed.Users, preview.Written.Users} {
		for _, r := range rows {
			if _, done := ok.users[r.TargetID]; done {
				continue
			}
			if _, err := s.resolveCategoryUserTarget(ctx, actorRole, r.TargetID); err != nil {
				return nil, err
			}
			ok.users[r.TargetID] = struct{}{}
		}
	}
	return func(plan db.ChannelSyncPlan) error {
		fail := func(err error) error {
			*refused = err
			return err
		}
		for _, r := range append(append([]db.OverrideRow{}, plan.Removed.Roles...), plan.Written.Roles...) {
			if _, done := ok.roles[r.TargetID]; !done {
				return fail(fmt.Errorf("%w%.0w", ErrPermsChanged, ErrConflict))
			}
		}
		for _, r := range append(append([]db.OverrideRow{}, plan.Removed.Users...), plan.Written.Users...) {
			if _, done := ok.users[r.TargetID]; !done {
				return fail(fmt.Errorf("%w%.0w", ErrPermsChanged, ErrConflict))
			}
		}
		var allow, deny int64
		for _, r := range planRows(plan) {
			allow |= r.Allow
			deny |= r.Deny
		}
		if err := requireGrantableChannelOverride(actorRole, allow, deny); err != nil {
			return fail(err)
		}
		return nil
	}, nil
}

func (s *channelOverrides) effectOfPlan(ctx context.Context, plan db.ChannelSyncPlan) PermEffect {
	roleIDs := make([]int64, 0, len(plan.Removed.Roles)+len(plan.Written.Roles))
	userIDs := make([]int64, 0, len(plan.Removed.Users)+len(plan.Written.Users))
	for _, r := range append(append([]db.OverrideRow{}, plan.Removed.Roles...), plan.Written.Roles...) {
		roleIDs = append(roleIDs, r.TargetID)
	}
	for _, r := range append(append([]db.OverrideRow{}, plan.Removed.Users...), plan.Written.Users...) {
		userIDs = append(userIDs, r.TargetID)
	}
	return s.effectOfRows(ctx, roleIDs, userIDs)
}

func (s *channelOverrides) auditSync(ctx context.Context, actorID int64, ch *db.Channel, plan db.ChannelSyncPlan) {
	slog.Info("channel permissions synced", "actor_id", actorID, "channel_id", ch.ID, "category_id", plan.CategoryID,
		"removed", len(plan.Removed.Roles)+len(plan.Removed.Users), "written", len(plan.Written.Roles)+len(plan.Written.Users))
	db.WriteAudit(ctx, s.st, actorID, "channel_perms_sync", "channel", ch.ID,
		fmt.Sprintf("synced #%s to its category (replaced %d override(s) with %d)", ch.Name,
			len(plan.Removed.Roles)+len(plan.Removed.Users), len(plan.Written.Roles)+len(plan.Written.Users)))
}

// SyncChannelPermissions re-syncs one channel to its category's template: its overrides
// are replaced and it is marked synced, in one transaction. ErrBadRequest without a
// category; ErrForbidden when the actor could not have written the rows removed or written.
func (s *channelOverrides) SyncChannelPermissions(ctx context.Context, actorID int64, actorRole *db.Role, ch *db.Channel) (PermEffect, error) {
	cp, err := s.catPermStore()
	if err != nil {
		return PermEffect{}, err
	}
	if ch.CategoryID == 0 {
		return PermEffect{}, fmt.Errorf("channel has no category to sync with%.0w", ErrBadRequest)
	}
	var refused error
	guard, err := s.prepareSync(ctx, actorRole, ch.ID, ch.CategoryID, &refused)
	if err != nil {
		return PermEffect{}, err
	}
	plan, err := cp.SyncChannelPermissions(ctx, ch.ID, guard)
	if mapped := mapSyncErr(err, refused); mapped != nil {
		return PermEffect{}, mapped
	}
	tail := context.WithoutCancel(ctx)
	s.auditSync(tail, actorID, ch, plan)
	effect := s.effectOfPlan(tail, plan)
	s.invalidatePermEffect(effect)
	s.notifyAudience(ch)
	return effect, nil
}

func mapSyncErr(err, refused error) error {
	switch {
	case err == nil:
		return nil
	case refused != nil:
		return refused
	case errors.Is(err, db.ErrNotFound):
		return fmt.Errorf("channel not found%.0w", ErrNotFound)
	case errors.Is(err, db.ErrUncategorized):
		return fmt.Errorf("channel has no category to sync with%.0w", ErrBadRequest)
	default:
		return fmt.Errorf("%w: failed to sync channel permissions: %w", ErrInternal, err)
	}
}

// templateEffect names who to invalidate after a channel was created as a copy of its
// template: holders of every role and every member it has a row for. Without it cached
// overrides would not know the new channel's rows until the cache expires.
func (s *channelOverrides) templateEffect(ctx context.Context, categoryID int64) PermEffect {
	if categoryID == 0 || s.cperm == nil {
		return PermEffect{}
	}
	roles, err := s.cperm.ListCategoryRoleOverrides(ctx, categoryID)
	if err != nil {
		return PermEffect{Applied: true, AffectedAll: true}
	}
	users, err := s.cperm.ListCategoryUserOverrides(ctx, categoryID)
	if err != nil {
		return PermEffect{Applied: true, AffectedAll: true}
	}
	var roleIDs, userIDs []int64
	for _, r := range roles {
		if r.Allow|r.Deny != 0 {
			roleIDs = append(roleIDs, r.RoleID)
		}
	}
	for _, u := range users {
		userIDs = append(userIDs, u.UserID)
	}
	return s.effectOfRows(ctx, roleIDs, userIDs)
}

// AdminListChannelsSynced is AdminListChannels with each channel's sync flag.
func (s *ChannelService) AdminListChannelsSynced(ctx context.Context) ([]AdminChannel, error) {
	chs, err := s.AdminListChannels(ctx)
	if err != nil {
		return nil, err
	}
	synced := map[int64]bool{}
	if s.cperm != nil {
		ids, err := s.cperm.ListSyncedChannelIDs(ctx)
		if err != nil {
			return nil, fmt.Errorf("%w: failed to list synced channels: %w", ErrInternal, err)
		}
		for _, id := range ids {
			synced[id] = true
		}
	}
	out := make([]AdminChannel, 0, len(chs))
	for i := range chs {
		out = append(out, AdminChannel{Channel: chs[i], PermissionsSynced: synced[chs[i].ID]})
	}
	return out, nil
}

func (s *channelOverrides) prepareUpdateSync(ctx context.Context, req AdminChannelUpdate, channelID, categoryID int64, update *db.ChannelUpdate, refused *error) error {
	if !req.SyncPermissions {
		return nil
	}
	if categoryID == 0 {
		return fmt.Errorf("sync_permissions needs an existing category%.0w", ErrBadRequest)
	}
	guard, err := s.prepareSync(ctx, req.ActorRole, channelID, categoryID, refused)
	if err != nil {
		return err
	}
	update.SyncGuard = guard
	return nil
}

// afterUpdateSync audits a committed sync and drops cached permissions of everyone its
// replaced rows name; the effect says whether any row changed so the caller refreshes the audience.
func (s *channelOverrides) afterUpdateSync(ctx context.Context, actorID int64, ch *db.Channel, req AdminChannelUpdate, plan db.ChannelSyncPlan) PermEffect {
	if !req.SyncPermissions {
		return PermEffect{}
	}
	s.auditSync(ctx, actorID, ch, plan)
	effect := s.effectOfPlan(ctx, plan)
	s.invalidatePermEffect(effect)
	return effect
}
