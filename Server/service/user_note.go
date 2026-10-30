package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

var _ UserNoteStore = (*db.DB)(nil)

// MaxUserNoteRunes caps a private profile note (migration 069).
const MaxUserNoteRunes = 256

// UserNoteStore is the data access the note service needs. *db.DB satisfies
// it; it is deliberately not part of Store.
type UserNoteStore interface {
	GetUserNote(ctx context.Context, ownerID, targetID int64) (string, error)
	UpsertUserNote(ctx context.Context, ownerID, targetID int64, note string) (bool, error)
	DeleteUserNote(ctx context.Context, ownerID, targetID int64) error
	UserExists(ctx context.Context, id int64) (bool, error)
}

// UserNoteService keeps one private note per (owner, target). Every call is
// keyed by the owner, and nothing here reads another user's notes.
type UserNoteService struct {
	st UserNoteStore
}

// NewUserNoteService creates a UserNoteService.
func NewUserNoteService(st UserNoteStore) *UserNoteService {
	return &UserNoteService{st: st}
}

// Get returns the owner's note about target, "" when there is none. It does
// not reveal whether the target exists.
func (s *UserNoteService) Get(ctx context.Context, ownerID, targetID int64) (string, error) {
	note, err := s.st.GetUserNote(ctx, ownerID, targetID)
	if err != nil {
		return "", fmt.Errorf("get user note: %w", err)
	}
	return note, nil
}

// Put bounds, cleans and caps note, then stores it, or deletes the row when it
// is empty after trimming. It returns the stored value. An unknown target is
// ErrNotFound and an oversized note is ErrBadRequest. The write is one
// statement, so concurrent writers need no lock and the last write wins.
func (s *UserNoteService) Put(ctx context.Context, ownerID, targetID int64, note string) (string, error) {
	cleaned, err := cleanTextBounded(note, MaxUserNoteRunes, "note")
	if err != nil {
		return "", err
	}
	exists, err := s.st.UserExists(ctx, targetID)
	if err != nil {
		return "", fmt.Errorf("put user note: %w", err)
	}
	if !exists {
		return "", fmt.Errorf("%w: user %d", ErrNotFound, targetID)
	}
	if cleaned == "" {
		if err := s.st.DeleteUserNote(ctx, ownerID, targetID); err != nil {
			return "", fmt.Errorf("put user note: %w", err)
		}
		return "", nil
	}
	ok, err := s.st.UpsertUserNote(ctx, ownerID, targetID, cleaned)
	if err != nil {
		return "", fmt.Errorf("put user note: %w", err)
	}
	if !ok {
		return "", fmt.Errorf("%w: user %d", ErrNotFound, targetID)
	}
	return cleaned, nil
}
