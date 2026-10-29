package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ─── Category permission templates ─────────────────────────────────
//
// category_overrides and category_user_overrides (migration 076) are a template
// that channels in the category stay synced to. They are copied onto channels
// and never read when a permission is computed: permissions.EffectiveChannelPerms
// still sees only channel_overrides and channel_user_overrides.
//
// Every write here that touches more than one row runs in ONE writer
// transaction, and the set of channels it rewrites is read inside that
// transaction. A channel moved out of the category (or unsynced) by a racing
// write is therefore either already out of the set this write reads, or the
// write completes first and the move sees its result; no channel is ever left
// half-written. The authorization guard is a callback run inside the
// transaction, after the rows are read and before anything is written, so a
// refusal rolls everything back.

// ErrUncategorized means a sync was asked of a channel that has no category,
// so there is no template to sync it to.
var ErrUncategorized = errors.New("channel has no category")

// OverrideBits is one allow/deny pair.
type OverrideBits struct {
	Allow int64
	Deny  int64
}

// OverrideRow is the bits one role or user carries on a category or channel.
type OverrideRow struct {
	TargetID int64
	Allow    int64
	Deny     int64
}

// SyncedChannelBits is the row a synced channel already carries for the role
// or user a category write targets (zero when it has none).
type SyncedChannelBits struct {
	ChannelID int64
	Allow     int64
	Deny      int64
}

// CategoryOverrideScope is what a category override write is about to
// overwrite, read inside the write transaction: the bits already on the
// category row and on every synced channel's row for the same target.
type CategoryOverrideScope struct {
	Category OverrideBits
	Channels []SyncedChannelBits
}

// CategoryOverrideGuard authorizes a category override write from the rows it
// would overwrite. A non-nil error aborts the transaction with nothing written.
type CategoryOverrideGuard func(CategoryOverrideScope) error

// OverrideRows is a set of role rows and a set of user rows.
type OverrideRows struct {
	Roles []OverrideRow
	Users []OverrideRow
}

// ChannelSyncPlan is a channel's override rows replaced by its category's
// template: Removed is what the channel carried, Written is the template.
type ChannelSyncPlan struct {
	ChannelID  int64
	CategoryID int64
	Removed    OverrideRows
	Written    OverrideRows
}

// ChannelSyncGuard authorizes a replace-with-template from the rows it removes
// and writes. A non-nil error aborts the transaction with nothing written.
type ChannelSyncGuard func(ChannelSyncPlan) error

// overrideKind selects the role or the user flavour of the same operation.
type overrideKind struct {
	catGet func(ctx context.Context, q *dbgen.Queries, categoryID, target int64) (OverrideBits, error)
	catSet func(ctx context.Context, q *dbgen.Queries, categoryID, target int64, b OverrideBits) error
	catDel func(ctx context.Context, q *dbgen.Queries, categoryID, target int64) error
	chGet  func(ctx context.Context, q *dbgen.Queries, channelID, target int64) (OverrideBits, error)
	chSet  func(ctx context.Context, q *dbgen.Queries, channelID, target int64, b OverrideBits) error
	chDel  func(ctx context.Context, q *dbgen.Queries, channelID, target int64) error
}

func noRowsZero(b OverrideBits, err error) (OverrideBits, error) {
	if errors.Is(err, sql.ErrNoRows) {
		return OverrideBits{}, nil
	}
	return b, err
}

//nolint:dupl // parallel descriptor over the role-keyed generated queries
var roleOverrideKind = overrideKind{
	catGet: func(ctx context.Context, q *dbgen.Queries, categoryID, target int64) (OverrideBits, error) {
		r, err := q.GetCategoryRoleOverride(ctx, dbgen.GetCategoryRoleOverrideParams{CategoryID: categoryID, RoleID: target})
		return noRowsZero(OverrideBits{Allow: r.Allow, Deny: r.Deny}, err)
	},
	catSet: func(ctx context.Context, q *dbgen.Queries, categoryID, target int64, b OverrideBits) error {
		return q.UpsertCategoryRoleOverride(ctx, dbgen.UpsertCategoryRoleOverrideParams{CategoryID: categoryID, RoleID: target, Allow: b.Allow, Deny: b.Deny})
	},
	catDel: func(ctx context.Context, q *dbgen.Queries, categoryID, target int64) error {
		return q.DeleteCategoryRoleOverride(ctx, dbgen.DeleteCategoryRoleOverrideParams{CategoryID: categoryID, RoleID: target})
	},
	chGet: func(ctx context.Context, q *dbgen.Queries, channelID, target int64) (OverrideBits, error) {
		r, err := q.GetChannelPermission(ctx, dbgen.GetChannelPermissionParams{ChannelID: channelID, RoleID: target})
		return noRowsZero(OverrideBits{Allow: r.Allow, Deny: r.Deny}, err)
	},
	chSet: func(ctx context.Context, q *dbgen.Queries, channelID, target int64, b OverrideBits) error {
		return q.UpsertChannelPermission(ctx, dbgen.UpsertChannelPermissionParams{ChannelID: channelID, RoleID: target, Allow: b.Allow, Deny: b.Deny})
	},
	chDel: func(ctx context.Context, q *dbgen.Queries, channelID, target int64) error {
		return q.DeleteChannelPermission(ctx, dbgen.DeleteChannelPermissionParams{ChannelID: channelID, RoleID: target})
	},
}

//nolint:dupl // parallel descriptor over the user-keyed generated queries
var userOverrideKind = overrideKind{
	catGet: func(ctx context.Context, q *dbgen.Queries, categoryID, target int64) (OverrideBits, error) {
		r, err := q.GetCategoryUserOverride(ctx, dbgen.GetCategoryUserOverrideParams{CategoryID: categoryID, UserID: target})
		return noRowsZero(OverrideBits{Allow: r.Allow, Deny: r.Deny}, err)
	},
	catSet: func(ctx context.Context, q *dbgen.Queries, categoryID, target int64, b OverrideBits) error {
		return q.UpsertCategoryUserOverride(ctx, dbgen.UpsertCategoryUserOverrideParams{CategoryID: categoryID, UserID: target, Allow: b.Allow, Deny: b.Deny})
	},
	catDel: func(ctx context.Context, q *dbgen.Queries, categoryID, target int64) error {
		return q.DeleteCategoryUserOverride(ctx, dbgen.DeleteCategoryUserOverrideParams{CategoryID: categoryID, UserID: target})
	},
	chGet: func(ctx context.Context, q *dbgen.Queries, channelID, target int64) (OverrideBits, error) {
		r, err := q.GetChannelUserPermission(ctx, dbgen.GetChannelUserPermissionParams{ChannelID: channelID, UserID: target})
		return noRowsZero(OverrideBits{Allow: r.Allow, Deny: r.Deny}, err)
	},
	chSet: func(ctx context.Context, q *dbgen.Queries, channelID, target int64, b OverrideBits) error {
		return q.UpsertChannelUserPermission(ctx, dbgen.UpsertChannelUserPermissionParams{ChannelID: channelID, UserID: target, Allow: b.Allow, Deny: b.Deny})
	},
	chDel: func(ctx context.Context, q *dbgen.Queries, channelID, target int64) error {
		return q.DeleteChannelUserPermission(ctx, dbgen.DeleteChannelUserPermissionParams{ChannelID: channelID, UserID: target})
	},
}

// applyCategoryOverride is the one write behind the four public category
// override mutations. In one transaction it reads the category, the category's
// row for the target and every synced channel's row for the target, runs the
// guard over that scope, then writes (or, with clear, deletes) the category
// row and the same row on each synced channel. It returns the ids of the
// channels it rewrote.
func (d *DB) applyCategoryOverride(ctx context.Context, op string, k overrideKind, categoryID, target int64, bits OverrideBits, clear bool, guard CategoryOverrideGuard) ([]int64, error) {
	var touched []int64
	err := d.inWriteTx(ctx, op, func(q *dbgen.Queries) error {
		if _, err := q.GetChannelCategory(ctx, categoryID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		cur, err := k.catGet(ctx, q, categoryID, target)
		if err != nil {
			return err
		}
		ids, err := q.ListSyncedChannelIDsInCategory(ctx, &categoryID)
		if err != nil {
			return err
		}
		scope := CategoryOverrideScope{Category: cur, Channels: make([]SyncedChannelBits, 0, len(ids))}
		for _, id := range ids {
			b, err := k.chGet(ctx, q, id, target)
			if err != nil {
				return err
			}
			scope.Channels = append(scope.Channels, SyncedChannelBits{ChannelID: id, Allow: b.Allow, Deny: b.Deny})
		}
		if guard != nil {
			if err := guard(scope); err != nil {
				return err
			}
		}
		if clear {
			if err := k.catDel(ctx, q, categoryID, target); err != nil {
				return err
			}
		} else if err := k.catSet(ctx, q, categoryID, target, bits); err != nil {
			return err
		}
		for _, id := range ids {
			if clear {
				err = k.chDel(ctx, q, id, target)
			} else {
				err = k.chSet(ctx, q, id, target, bits)
			}
			if err != nil {
				return err
			}
		}
		touched = ids
		return nil
	})
	if err != nil {
		return nil, err
	}
	return touched, nil
}

// WriteCategoryRoleOverride sets a role's template row on a category and the
// same row on every synced channel in it, in one transaction. ErrNotFound when
// the category is gone. It returns the rewritten channels' ids.
func (d *DB) WriteCategoryRoleOverride(ctx context.Context, categoryID, roleID, allow, deny int64, guard CategoryOverrideGuard) ([]int64, error) {
	return d.applyCategoryOverride(ctx, "WriteCategoryRoleOverride", roleOverrideKind, categoryID, roleID, OverrideBits{Allow: allow, Deny: deny}, false, guard)
}

// ClearCategoryRoleOverride removes a role's template row and its row on every
// synced channel in the category, in one transaction.
func (d *DB) ClearCategoryRoleOverride(ctx context.Context, categoryID, roleID int64, guard CategoryOverrideGuard) ([]int64, error) {
	return d.applyCategoryOverride(ctx, "ClearCategoryRoleOverride", roleOverrideKind, categoryID, roleID, OverrideBits{}, true, guard)
}

// WriteCategoryUserOverride is WriteCategoryRoleOverride for a member.
func (d *DB) WriteCategoryUserOverride(ctx context.Context, categoryID, userID, allow, deny int64, guard CategoryOverrideGuard) ([]int64, error) {
	return d.applyCategoryOverride(ctx, "WriteCategoryUserOverride", userOverrideKind, categoryID, userID, OverrideBits{Allow: allow, Deny: deny}, false, guard)
}

// ClearCategoryUserOverride is ClearCategoryRoleOverride for a member.
func (d *DB) ClearCategoryUserOverride(ctx context.Context, categoryID, userID int64, guard CategoryOverrideGuard) ([]int64, error) {
	return d.applyCategoryOverride(ctx, "ClearCategoryUserOverride", userOverrideKind, categoryID, userID, OverrideBits{}, true, guard)
}

// loadSyncPlan reads the rows a replace-with-template would remove (the
// channel's own) and write (the category's template).
func loadSyncPlan(ctx context.Context, q *dbgen.Queries, channelID, categoryID int64) (ChannelSyncPlan, error) {
	plan := ChannelSyncPlan{ChannelID: channelID, CategoryID: categoryID}
	roles, err := q.GetChannelOverrides(ctx, channelID)
	if err != nil {
		return ChannelSyncPlan{}, err
	}
	for _, r := range roles {
		plan.Removed.Roles = append(plan.Removed.Roles, OverrideRow{TargetID: r.RoleID, Allow: r.Allow, Deny: r.Deny})
	}
	users, err := q.GetChannelUserOverrides(ctx, channelID)
	if err != nil {
		return ChannelSyncPlan{}, err
	}
	for _, u := range users {
		plan.Removed.Users = append(plan.Removed.Users, OverrideRow{TargetID: u.UserID, Allow: u.Allow, Deny: u.Deny})
	}
	tRoles, err := q.ListCategoryRoleOverrideRows(ctx, categoryID)
	if err != nil {
		return ChannelSyncPlan{}, err
	}
	for _, r := range tRoles {
		plan.Written.Roles = append(plan.Written.Roles, OverrideRow{TargetID: r.RoleID, Allow: r.Allow, Deny: r.Deny})
	}
	tUsers, err := q.ListCategoryUserOverrideRows(ctx, categoryID)
	if err != nil {
		return ChannelSyncPlan{}, err
	}
	for _, u := range tUsers {
		plan.Written.Users = append(plan.Written.Users, OverrideRow{TargetID: u.UserID, Allow: u.Allow, Deny: u.Deny})
	}
	return plan, nil
}

// PreviewChannelSync reads, outside any transaction, the rows syncing the
// channel to the category would remove and write. A caller resolves who those
// rows name (role and member hierarchy) from it BEFORE the write transaction,
// so the guard it passes in stays free of store reads: the writer connection
// is held for the whole transaction.
func (d *DB) PreviewChannelSync(ctx context.Context, channelID, categoryID int64) (ChannelSyncPlan, error) {
	plan, err := loadSyncPlan(ctx, d.q, channelID, categoryID)
	if err != nil {
		return ChannelSyncPlan{}, fmt.Errorf("PreviewChannelSync: %w", err)
	}
	return plan, nil
}

// replaceWithTemplateTx replaces a channel's role and user override rows with
// the category's template and marks the channel synced. The guard sees the
// removed and the written rows before anything changes. It runs inside the
// caller's transaction.
func replaceWithTemplateTx(ctx context.Context, q *dbgen.Queries, channelID, categoryID int64, guard ChannelSyncGuard) (ChannelSyncPlan, error) {
	plan, err := loadSyncPlan(ctx, q, channelID, categoryID)
	if err != nil {
		return ChannelSyncPlan{}, err
	}
	if guard != nil {
		if err := guard(plan); err != nil {
			return ChannelSyncPlan{}, err
		}
	}
	if err := q.DeleteChannelRoleOverrides(ctx, channelID); err != nil {
		return ChannelSyncPlan{}, err
	}
	if err := q.DeleteChannelUserOverrides(ctx, channelID); err != nil {
		return ChannelSyncPlan{}, err
	}
	if err := copyTemplateToNewChannelTx(ctx, q, channelID, categoryID); err != nil {
		return ChannelSyncPlan{}, err
	}
	return plan, nil
}

// SyncChannelPermissions re-syncs one channel to its category's template in
// one transaction. The channel's category is read inside it. ErrNotFound when
// the channel is gone, ErrUncategorized when it has no category.
func (d *DB) SyncChannelPermissions(ctx context.Context, channelID int64, guard ChannelSyncGuard) (ChannelSyncPlan, error) {
	var plan ChannelSyncPlan
	err := d.inWriteTx(ctx, "SyncChannelPermissions", func(q *dbgen.Queries) error {
		catID, err := q.GetChannelCategoryID(ctx, channelID)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if catID == nil {
			return ErrUncategorized
		}
		plan, err = replaceWithTemplateTx(ctx, q, channelID, *catID, guard)
		return err
	})
	if err != nil {
		return ChannelSyncPlan{}, err
	}
	return plan, nil
}

// copyTemplateToNewChannelTx gives a freshly created channel its category's
// template and marks it synced. It runs inside the create transaction and does
// not consult any guard: the template was authorized when it was written.
func copyTemplateToNewChannelTx(ctx context.Context, q *dbgen.Queries, channelID, categoryID int64) error {
	args := dbgen.CopyCategoryRoleOverridesToChannelParams{ChannelID: channelID, CategoryID: categoryID}
	if err := q.CopyCategoryRoleOverridesToChannel(ctx, args); err != nil {
		return err
	}
	if err := q.CopyCategoryUserOverridesToChannel(ctx, dbgen.CopyCategoryUserOverridesToChannelParams(args)); err != nil {
		return err
	}
	return q.SetChannelPermissionsSynced(ctx, dbgen.SetChannelPermissionsSyncedParams{PermissionsSynced: 1, ID: channelID})
}

// ListCategoryRoleOverrides returns every role together with its template
// bits on the category (zero when it has no row), ordered like
// ListChannelRoleOverrides.
func (d *DB) ListCategoryRoleOverrides(ctx context.Context, categoryID int64) ([]ChannelRoleOverride, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT r.id, r.name, r.position, r.permissions,
		        COALESCE(o.allow, 0), COALESCE(o.deny, 0)
		 FROM roles r
		 LEFT JOIN category_overrides o ON o.role_id = r.id AND o.category_id = ?
		 ORDER BY r.position DESC, r.id ASC`,
		categoryID,
	)
	if err != nil {
		return nil, fmt.Errorf("ListCategoryRoleOverrides: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := []ChannelRoleOverride{}
	for rows.Next() {
		var o ChannelRoleOverride
		if scanErr := rows.Scan(&o.RoleID, &o.RoleName, &o.Position, &o.Permissions, &o.Allow, &o.Deny); scanErr != nil {
			return nil, fmt.Errorf("ListCategoryRoleOverrides scan: %w", scanErr)
		}
		result = append(result, o)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListCategoryRoleOverrides rows: %w", rows.Err())
	}
	return result, nil
}

// ListCategoryUserOverrides returns the per-user template rows on a category
// joined with the users' names, ordered by username.
func (d *DB) ListCategoryUserOverrides(ctx context.Context, categoryID int64) ([]ChannelUserOverride, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT u.id, u.username, u.role_id, o.allow, o.deny
		 FROM category_user_overrides o
		 JOIN users u ON u.id = o.user_id
		 WHERE o.category_id = ?
		 ORDER BY u.username COLLATE NOCASE ASC`,
		categoryID,
	)
	if err != nil {
		return nil, fmt.Errorf("ListCategoryUserOverrides: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := []ChannelUserOverride{}
	for rows.Next() {
		var o ChannelUserOverride
		if scanErr := rows.Scan(&o.UserID, &o.Username, &o.RoleID, &o.Allow, &o.Deny); scanErr != nil {
			return nil, fmt.Errorf("ListCategoryUserOverrides scan: %w", scanErr)
		}
		result = append(result, o)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListCategoryUserOverrides rows: %w", rows.Err())
	}
	return result, nil
}

// ListSyncedChannelIDs returns the ids of every channel whose overrides are
// kept in sync with its category.
func (d *DB) ListSyncedChannelIDs(ctx context.Context) ([]int64, error) {
	ids, err := d.q.ListSyncedChannelIDs(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListSyncedChannelIDs: %w", err)
	}
	return ids, nil
}

// ChannelPermissionsSynced reports whether a channel is synced to its
// category. A channel that does not exist is not synced.
func (d *DB) ChannelPermissionsSynced(ctx context.Context, channelID int64) (bool, error) {
	v, err := d.q.GetChannelPermissionsSynced(ctx, channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("ChannelPermissionsSynced: %w", err)
	}
	return v != 0, nil
}
