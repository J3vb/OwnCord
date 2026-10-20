package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// GetUserNote returns the note owner keeps about target, or "" when there is
// none. The query is keyed by owner, so one user's notes are never readable
// through another's id.
func (d *DB) GetUserNote(ctx context.Context, ownerID, targetID int64) (string, error) {
	note, err := d.q.GetUserNote(ctx, dbgen.GetUserNoteParams{OwnerID: ownerID, TargetID: targetID})
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("GetUserNote: %w", err)
	}
	return note, nil
}

// UpsertUserNote stores the note in one statement. It reports false when the
// target no longer exists, so a note is never written for an erased account.
func (d *DB) UpsertUserNote(ctx context.Context, ownerID, targetID int64, note string) (bool, error) {
	n, err := d.q.UpsertUserNote(ctx, dbgen.UpsertUserNoteParams{OwnerID: ownerID, TargetID: targetID, Note: note})
	if err != nil {
		return false, fmt.Errorf("UpsertUserNote: %w", err)
	}
	return n > 0, nil
}

// DeleteUserNote removes the note owner keeps about target; a missing row is
// not an error.
func (d *DB) DeleteUserNote(ctx context.Context, ownerID, targetID int64) error {
	if err := d.q.DeleteUserNote(ctx, dbgen.DeleteUserNoteParams{OwnerID: ownerID, TargetID: targetID}); err != nil {
		return fmt.Errorf("DeleteUserNote: %w", err)
	}
	return nil
}

// UserExists reports whether a users row with the given id exists.
func (d *DB) UserExists(ctx context.Context, id int64) (bool, error) {
	var one int
	err := d.reader.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = ?`, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("UserExists: %w", err)
	}
	return true, nil
}
