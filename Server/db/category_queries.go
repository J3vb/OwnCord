package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ChannelCategory is a row of channel_categories (migration 072). It lives
// here rather than in models.go because the models.go json-tag count is
// ratcheted (service/datastore_ratchet_test.go).
type ChannelCategory struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
}

func categoryFromGen(r dbgen.ChannelCategory) ChannelCategory {
	return ChannelCategory{ID: r.ID, Name: r.Name, Position: int(r.Position)}
}

// ListChannelCategories returns every category ordered by (position, id).
func (d *DB) ListChannelCategories(ctx context.Context) ([]ChannelCategory, error) {
	rows, err := d.q.ListChannelCategories(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListChannelCategories: %w", err)
	}
	out := make([]ChannelCategory, 0, len(rows))
	for i := range rows {
		out = append(out, categoryFromGen(rows[i]))
	}
	return out, nil
}

// GetChannelCategory returns the category with the given id, or nil when it
// does not exist.
func (d *DB) GetChannelCategory(ctx context.Context, id int64) (*ChannelCategory, error) {
	r, err := d.q.GetChannelCategory(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetChannelCategory: %w", err)
	}
	c := categoryFromGen(r)
	return &c, nil
}

// FindChannelCategoryByName returns the category whose name equals name
// ignoring ASCII case, or nil when there is none.
func (d *DB) FindChannelCategoryByName(ctx context.Context, name string) (*ChannelCategory, error) {
	r, err := d.q.FindChannelCategoryByName(ctx, name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("FindChannelCategoryByName: %w", err)
	}
	c := categoryFromGen(r)
	return &c, nil
}

// CreateChannelCategory appends a category after the last one. A name another
// category already has (ignoring case) is ErrConflict.
func (d *DB) CreateChannelCategory(ctx context.Context, name string) (*ChannelCategory, error) {
	var out ChannelCategory
	err := d.inWriteTx(ctx, "CreateChannelCategory", func(q *dbgen.Queries) error {
		res, err := q.InsertChannelCategory(ctx, name)
		if err != nil {
			if IsUniqueConstraintError(err) {
				return ErrConflict
			}
			return err
		}
		id, err := res.LastInsertId()
		if err != nil {
			return err
		}
		row, err := q.GetChannelCategory(ctx, id)
		if err != nil {
			return err
		}
		out = categoryFromGen(row)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RenameChannelCategory renames a category. ErrNotFound when it is gone,
// ErrConflict when another category already has the name (ignoring case).
// Renaming a category to a different spelling of its own name is allowed.
func (d *DB) RenameChannelCategory(ctx context.Context, id int64, name string) error {
	return d.inWriteTx(ctx, "RenameChannelCategory", func(q *dbgen.Queries) error {
		n, err := q.RenameChannelCategory(ctx, dbgen.RenameChannelCategoryParams{Name: name, ID: id})
		if err != nil {
			if IsUniqueConstraintError(err) {
				return ErrConflict
			}
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// ReorderChannelCategories rewrites every category's position to its index in
// ids. The set must be exactly the current set of category ids, or nothing is
// written and ErrConflict is returned: an editor holding a stale list (a
// category was added or deleted by another manager) must reload instead of
// silently reordering a different set. The read and the writes share one
// transaction on the single writer connection, so two racing reorders
// serialise and the second compares against what the first committed.
func (d *DB) ReorderChannelCategories(ctx context.Context, ids []int64) error {
	return d.inWriteTx(ctx, "ReorderChannelCategories", func(q *dbgen.Queries) error {
		cur, err := q.ListChannelCategories(ctx)
		if err != nil {
			return err
		}
		if len(cur) != len(ids) {
			return ErrConflict
		}
		have := make([]int64, len(cur))
		for i := range cur {
			have[i] = cur[i].ID
		}
		want := slices.Clone(ids)
		slices.Sort(have)
		slices.Sort(want)
		if !slices.Equal(have, want) {
			return ErrConflict
		}
		for i, id := range ids {
			if _, err := q.SetChannelCategoryPosition(ctx, dbgen.SetChannelCategoryPositionParams{
				Position: int64(i),
				ID:       id,
			}); err != nil {
				return err
			}
		}
		return nil
	})
}

// DeleteChannelCategory removes a category and, by cascade, its permission
// template. Its channels keep every other field, including the override rows
// they carry, and become uncategorized (ON DELETE SET NULL) and unsynced.
// ErrNotFound when it is already gone.
func (d *DB) DeleteChannelCategory(ctx context.Context, id int64) error {
	return d.inWriteTx(ctx, "DeleteChannelCategory", func(q *dbgen.Queries) error {
		if err := q.UnsyncCategoryChannels(ctx, &id); err != nil {
			return err
		}
		n, err := q.DeleteChannelCategory(ctx, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// NewChannel is a channel create request at the db layer. CategoryID wins over
// CategoryName when both are set. CategoryName is resolved ignoring case and
// created when missing; both empty means no category.
type NewChannel struct {
	Name         string
	Type         string
	Topic        string
	Position     int
	CategoryID   int64
	CategoryName string
	// CreatedCategory, when non-nil, receives the id of the category this
	// write created because CategoryName matched none, and is left alone
	// otherwise. The caller owes that creation an audit row and a manager
	// broadcast, since it bypassed the category routes.
	CreatedCategory *int64
}

// CreateChannelIn inserts a channel and returns its id. Resolving or creating
// the category and the insert share one transaction on the writer connection,
// so a concurrent rename or delete of the category cannot interleave: the new
// channel lands on the one category row by id. An unknown CategoryID is
// ErrNotFound and writes nothing.
func (d *DB) CreateChannelIn(ctx context.Context, c NewChannel) (int64, error) {
	var id, createdID int64
	err := d.inWriteTx(ctx, "CreateChannel", func(q *dbgen.Queries) error {
		catID, created, err := resolveCategoryTx(ctx, q, c.CategoryID, c.CategoryName, false)
		if err != nil {
			return err
		}
		createdID = created
		res, err := q.CreateChannel(ctx, dbgen.CreateChannelParams{
			Name:       c.Name,
			Type:       c.Type,
			CategoryID: catID,
			Topic:      strToNullPtr(c.Topic),
			Position:   int64(c.Position),
		})
		if err != nil {
			return err
		}
		id, err = res.LastInsertId()
		if err != nil {
			return err
		}
		if catID == nil {
			return nil
		}
		// The channel starts as a copy of its category's template and synced
		// to it, in this same transaction.
		return copyTemplateToNewChannelTx(ctx, q, id, *catID)
	})
	if err != nil {
		return 0, err
	}
	if c.CreatedCategory != nil && createdID != 0 {
		*c.CreatedCategory = createdID
	}
	return id, nil
}

// resolveCategoryTx maps a (category id, legacy name) pair to the id to store:
// nil for none. An id must exist (ErrNotFound otherwise, or none when
// ifExists); a name is matched ignoring case and created at the end when
// missing, in which case created is that new row's id.
func resolveCategoryTx(ctx context.Context, q *dbgen.Queries, id int64, name string, ifExists bool) (catID *int64, created int64, err error) {
	if id > 0 {
		if _, err := q.GetChannelCategory(ctx, id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				if ifExists {
					return nil, 0, nil
				}
				return nil, 0, ErrNotFound
			}
			return nil, 0, err
		}
		return &id, 0, nil
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, 0, nil
	}
	row, err := q.FindChannelCategoryByName(ctx, name)
	if err == nil {
		rid := row.ID
		return &rid, 0, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, 0, err
	}
	res, err := q.InsertChannelCategory(ctx, name)
	if err != nil {
		return nil, 0, err
	}
	rid, err := res.LastInsertId()
	if err != nil {
		return nil, 0, err
	}
	return &rid, rid, nil
}
