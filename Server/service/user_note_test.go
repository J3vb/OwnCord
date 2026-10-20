package service

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeNoteStore struct {
	notes  map[[2]int64]string
	exists bool
}

func (f *fakeNoteStore) GetUserNote(_ context.Context, o, t int64) (string, error) {
	return f.notes[[2]int64{o, t}], nil
}
func (f *fakeNoteStore) UpsertUserNote(_ context.Context, o, t int64, n string) (bool, error) {
	f.notes[[2]int64{o, t}] = n
	return f.exists, nil
}
func (f *fakeNoteStore) DeleteUserNote(_ context.Context, o, t int64) error {
	delete(f.notes, [2]int64{o, t})
	return nil
}
func (f *fakeNoteStore) UserExists(context.Context, int64) (bool, error) { return f.exists, nil }

func TestUserNoteService_PutBoundsBeforeCleaning(t *testing.T) {
	st := &fakeNoteStore{notes: map[[2]int64]string{}, exists: true}
	svc := NewUserNoteService(st)
	if _, err := svc.Put(context.Background(), 1, 2, strings.Repeat(" ", MaxUserNoteRunes*4+1)); !errors.Is(err, ErrBadRequest) {
		t.Errorf("oversized raw note err = %v, want ErrBadRequest", err)
	}
	if got, err := svc.Put(context.Background(), 1, 2, " hi "); err != nil || got != "hi" {
		t.Errorf("Put = %q, %v", got, err)
	}
	st.exists = false
	if _, err := svc.Put(context.Background(), 1, 3, "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing target err = %v, want ErrNotFound", err)
	}
}
