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
	failGetUserByID            bool
	failUpdateUserCustomStatus bool
}

func (f *faultyStore) GetUserByID(ctx context.Context, id int64) (*db.User, error) {
	if f.failGetUserByID {
		return nil, errors.New("injected GetUserByID failure")
	}
	return f.Store.GetUserByID(ctx, id)
}

func (f *faultyStore) UpdateUserCustomStatus(ctx context.Context, userID int64, customStatus *string) error {
	if f.failUpdateUserCustomStatus {
		return errors.New("injected UpdateUserCustomStatus failure")
	}
	return f.Store.UpdateUserCustomStatus(ctx, userID, customStatus)
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

// When customStatus != nil, UpdateUserStatus and UpdateUserCustomStatus are
// two independent writes. If the second fails after the first commits, the
// handler must not report total failure (which would broadcast nothing for
// a status change that in fact happened) — it must swallow the failure and
// return the true stored custom_status, not the unpersisted intended value.
// Regression for finding v104.
func TestHandlePresenceUpdate_CustomStatusWriteFailureSwallowedAfterStatusCommit(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	ctx := context.Background()

	fs := &faultyStore{Store: database, failUpdateUserCustomStatus: true}
	svc := NewChannelService(fs, NewPermissionService(database, permissions.NewChecker(database)))

	text := "in a meeting"
	got, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusDND, &text, nil)
	if err != nil {
		t.Fatalf("HandlePresenceUpdate: %v, want the status commit reported as success", err)
	}
	if got != nil {
		t.Fatalf("returned custom status = %v, want nil (the write never persisted, must not broadcast it)", *got)
	}

	u, gerr := database.GetUserByID(ctx, 1)
	if gerr != nil {
		t.Fatalf("GetUserByID: %v", gerr)
	}
	if u.Status != db.StatusDND {
		t.Fatalf("status = %q, want committed %q", u.Status, db.StatusDND)
	}
	if u.CustomStatus != nil {
		t.Fatalf("custom_status = %v, want unwritten (nil)", *u.CustomStatus)
	}
}

// The swallowed custom-status write failure must broadcast the text that is
// really stored, not nil: a nil custom_status on the wire is indistinguishable
// from "the user cleared it" (presencePayload has no omitempty), so reporting
// nil for a value the DB still holds wipes it on every client. Regression for
// v104's fix re-introducing v78 on its own failure path.
func TestHandlePresenceUpdate_CustomStatusWriteFailureKeepsStoredText(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	ctx := context.Background()

	stored := "on call"
	if err := database.UpdateUserCustomStatus(ctx, 1, &stored); err != nil {
		t.Fatalf("seed custom status: %v", err)
	}

	fs := &faultyStore{Store: database, failUpdateUserCustomStatus: true}
	svc := NewChannelService(fs, NewPermissionService(database, permissions.NewChecker(database)))

	text := "in a meeting"
	got, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusDND, &text, nil)
	if err != nil {
		t.Fatalf("HandlePresenceUpdate: %v, want the status commit reported as success", err)
	}
	if got == nil || *got != stored {
		t.Fatalf("returned custom status = %v, want the stored %q — nil would broadcast a bogus clear", got, stored)
	}

	u, gerr := database.GetUserByID(ctx, 1)
	if gerr != nil {
		t.Fatalf("GetUserByID: %v", gerr)
	}
	if u.CustomStatus == nil || *u.CustomStatus != stored {
		t.Fatalf("custom_status = %v, want unchanged %q", u.CustomStatus, stored)
	}
}
