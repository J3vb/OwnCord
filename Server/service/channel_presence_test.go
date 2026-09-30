package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// faultyStore wraps a real Store and lets a test force specific methods to
// fail, so HandlePresenceUpdate's post-commit failure handling can be
// exercised without depending on a real DB fault.
type faultyStore struct {
	Store
	failGetUserByID        bool
	failUpdateUserPresence bool
	statusWrites           int
	presenceWrites         int
}

func (f *faultyStore) GetUserByID(ctx context.Context, id int64) (*db.User, error) {
	if f.failGetUserByID {
		return nil, errors.New("injected GetUserByID failure")
	}
	return f.Store.GetUserByID(ctx, id)
}

func (f *faultyStore) UpdateUserStatus(ctx context.Context, id int64, status string) error {
	f.statusWrites++
	return f.Store.UpdateUserStatus(ctx, id, status)
}

func (f *faultyStore) UpdateUserCustomStatus(context.Context, int64, *string) error {
	return errors.New("presence_update must write its custom status with the status, in one transaction")
}

func (f *faultyStore) UpdateUserPresence(ctx context.Context, id int64, status string, customStatus *string) error {
	f.presenceWrites++
	if f.failUpdateUserPresence {
		return errors.New("injected UpdateUserPresence failure")
	}
	return f.Store.UpdateUserPresence(ctx, id, status, customStatus)
}

// A bare status flip (no custom_status field) must read the currently stored
// text BEFORE writing the new status. If that read fails, nothing may
// commit: returning the status write anyway and broadcasting a nil
// custom_status would be wire-identical to "user cleared their status" and
// wipe every client's copy of text the DB still holds. Regression for
// finding v78.
func TestHandlePresenceUpdate_BareStatusReadFailureAbortsBeforeCommit(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	ctx := context.Background()

	if err := database.UpdateUserStatus(ctx, 1, db.StatusOnline); err != nil {
		t.Fatalf("seed status: %v", err)
	}
	text := "on call"
	if err := database.UpdateUserCustomStatus(ctx, 1, &text); err != nil {
		t.Fatalf("seed custom status: %v", err)
	}

	fs := &faultyStore{Store: database, failGetUserByID: true}
	svc := NewChannelService(fs, NewPermissionService(database, permissions.NewChecker(database)))

	got, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusIdle, nil, nil)
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("err = %v, want ErrInternal", err)
	}
	if got != nil {
		t.Fatalf("returned custom status = %v, want nil on abort", *got)
	}

	u, gerr := database.GetUserByID(ctx, 1)
	if gerr != nil {
		t.Fatalf("GetUserByID: %v", gerr)
	}
	if u.Status != db.StatusOnline {
		t.Fatalf("status = %q, want unchanged %q — a failed pre-write read must not let the status commit", u.Status, db.StatusOnline)
	}
	if u.CustomStatus == nil || *u.CustomStatus != "on call" {
		t.Fatalf("custom_status = %v, want unchanged %q", u.CustomStatus, "on call")
	}
}

// A presence_update carrying a custom status is one writer transaction, not
// two autocommits (P5-O08, folded into P5-S07): the status and the text commit
// together.
func TestHandlePresenceUpdate_CustomStatusIsOneWriterTransaction(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	ctx := context.Background()

	fs := &faultyStore{Store: database}
	svc := NewChannelService(fs, NewPermissionService(database, permissions.NewChecker(database)))

	text := "in a meeting"
	got, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusDND, &text, nil)
	if err != nil {
		t.Fatalf("HandlePresenceUpdate: %v", err)
	}
	if got == nil || *got != text {
		t.Fatalf("returned custom status = %v, want %q", got, text)
	}
	if fs.presenceWrites != 1 || fs.statusWrites != 0 {
		t.Fatalf("writes = %d presence + %d status, want exactly 1 combined write", fs.presenceWrites, fs.statusWrites)
	}
	u, _ := database.GetUserByID(ctx, 1)
	if u.Status != db.StatusDND || u.CustomStatus == nil || *u.CustomStatus != text {
		t.Fatalf("row = %q/%v, want dnd/%q", u.Status, u.CustomStatus, text)
	}
}

// The combined write either commits both halves or neither, so a failure is
// an error with nothing committed and nothing to broadcast: the stored status
// and text are untouched.
func TestHandlePresenceUpdate_CombinedWriteFailureCommitsNothing(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h", Status: db.StatusOnline})
	ctx := context.Background()

	stored := "on call"
	if err := database.UpdateUserCustomStatus(ctx, 1, &stored); err != nil {
		t.Fatalf("seed custom status: %v", err)
	}

	fs := &faultyStore{Store: database, failUpdateUserPresence: true}
	svc := NewChannelService(fs, NewPermissionService(database, permissions.NewChecker(database)))

	text := "in a meeting"
	got, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusDND, &text, nil)
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("err = %v, want ErrInternal", err)
	}
	if got != nil {
		t.Fatalf("returned custom status = %v, want nil on failure", *got)
	}
	u, _ := database.GetUserByID(ctx, 1)
	if u.Status != db.StatusOnline || u.CustomStatus == nil || *u.CustomStatus != stored {
		t.Fatalf("row = %q/%v, want the untouched online/%q", u.Status, u.CustomStatus, stored)
	}
}
