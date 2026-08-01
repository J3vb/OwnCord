package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// Phase 6 profile fields. The rules that matter here are the ones a handler
// could plausibly skip: sanitization, the length bounds, "omitted means
// unchanged", and "empty means cleared". They live in the service precisely so
// every transport gets them, so they are tested against the service.

func newUserSvc(t *testing.T) (*UserService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	return NewUserService(database), database
}

func TestUpdateProfile_SetsAndClearsDisplayNameAndAbout(t *testing.T) {
	svc, _ := newUserSvc(t)
	ctx := context.Background()

	name, about := "Ada L.", "counts on it"
	u, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &name, About: &about})
	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if u.DisplayName == nil || *u.DisplayName != name {
		t.Fatalf("display_name = %v, want %q", u.DisplayName, name)
	}
	if u.About == nil || *u.About != about {
		t.Fatalf("about = %v, want %q", u.About, about)
	}

	// A patch that mentions neither field must leave both standing — the
	// update writes every column, so this is the merge doing its job.
	u, err = svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada"})
	if err != nil {
		t.Fatalf("UpdateProfile (username only): %v", err)
	}
	if u.DisplayName == nil || u.About == nil {
		t.Fatalf("a username-only patch cleared other fields: %v / %v", u.DisplayName, u.About)
	}

	// An explicit empty string clears.
	empty := ""
	u, err = svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &empty, About: &empty})
	if err != nil {
		t.Fatalf("UpdateProfile (clear): %v", err)
	}
	if u.DisplayName != nil || u.About != nil {
		t.Fatalf("expected cleared, got %v / %v", u.DisplayName, u.About)
	}
}

func TestUpdateProfile_SanitizesAndTrims(t *testing.T) {
	svc, _ := newUserSvc(t)
	name := "  <b>Ada</b>  "
	about := "<script>alert(1)</script>hello"
	u, err := svc.UpdateProfile(context.Background(), 1, ProfilePatch{
		Username: "ada", DisplayName: &name, About: &about,
	})
	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if u.DisplayName == nil || *u.DisplayName != "Ada" {
		t.Errorf("display_name = %v, want %q", u.DisplayName, "Ada")
	}
	if u.About == nil || strings.Contains(*u.About, "<") {
		t.Errorf("about = %v, want markup stripped", u.About)
	}
}

func TestUpdateProfile_RejectsOverlongFields(t *testing.T) {
	svc, _ := newUserSvc(t)
	ctx := context.Background()

	tooLongName := strings.Repeat("a", MaxDisplayNameLen+1)
	if _, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &tooLongName}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("overlong display_name err = %v, want ErrBadRequest", err)
	}
	tooLongAbout := strings.Repeat("b", MaxAboutLen+1)
	if _, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", About: &tooLongAbout}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("overlong about err = %v, want ErrBadRequest", err)
	}

	// Exactly at the bound is accepted, and the bound counts runes rather than
	// bytes — otherwise a name in a non-Latin script would be a third as long.
	atBound := strings.Repeat("é", MaxDisplayNameLen)
	if _, err := svc.UpdateProfile(ctx, 1, ProfilePatch{Username: "ada", DisplayName: &atBound}); err != nil {
		t.Errorf("display_name at bound rejected: %v", err)
	}
}

func TestSetCustomStatus_RoundTripClearAndBound(t *testing.T) {
	svc, database := newUserSvc(t)
	ctx := context.Background()

	if err := svc.SetCustomStatus(ctx, 1, "  <i>debugging</i>  "); err != nil {
		t.Fatalf("SetCustomStatus: %v", err)
	}
	u, _ := database.GetUserByID(ctx, 1)
	if u.CustomStatus == nil || *u.CustomStatus != "debugging" {
		t.Fatalf("custom_status = %v, want sanitized+trimmed %q", u.CustomStatus, "debugging")
	}

	if err := svc.SetCustomStatus(ctx, 1, "   "); err != nil {
		t.Fatalf("SetCustomStatus (blank): %v", err)
	}
	u, _ = database.GetUserByID(ctx, 1)
	if u.CustomStatus != nil {
		t.Fatalf("whitespace-only text should clear, got %q", *u.CustomStatus)
	}

	if err := svc.SetCustomStatus(ctx, 1, strings.Repeat("x", MaxCustomStatusLen+1)); !errors.Is(err, ErrBadRequest) {
		t.Errorf("overlong custom_status err = %v, want ErrBadRequest", err)
	}
}

func TestClearCustomStatus(t *testing.T) {
	svc, database := newUserSvc(t)
	ctx := context.Background()
	if err := svc.SetCustomStatus(ctx, 1, "afk"); err != nil {
		t.Fatalf("SetCustomStatus: %v", err)
	}
	if err := svc.ClearCustomStatus(ctx, 1); err != nil {
		t.Fatalf("ClearCustomStatus: %v", err)
	}
	u, _ := database.GetUserByID(ctx, 1)
	if u.CustomStatus != nil {
		t.Fatalf("custom_status = %q, want nil", *u.CustomStatus)
	}
}

func TestAvatarFileURL(t *testing.T) {
	if got := AvatarFileURL("abc"); got != "/api/v1/files/abc" {
		t.Errorf("AvatarFileURL = %q", got)
	}
}

func TestHandlePresenceUpdate_AcceptsInvisibleAndCarriesCustomStatus(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	ctx := context.Background()

	text := "  <b>away</b>  "
	got, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusInvisible, &text, nil)
	if err != nil {
		t.Fatalf("HandlePresenceUpdate: %v", err)
	}
	if got == nil || *got != "away" {
		t.Fatalf("returned custom status = %v, want sanitized %q", got, "away")
	}
	u, _ := database.GetUserByID(ctx, 1)
	// Stored as chosen — the invisible -> offline collapse is a broadcast-time
	// concern, and storing it collapsed would make the next connect unable to
	// tell "appear offline" from "not connected".
	if u.Status != db.StatusInvisible {
		t.Fatalf("stored status = %q, want invisible", u.Status)
	}

	// A later status flip that carries no custom_status field must leave the
	// text alone AND still put it on the wire, or the auto-idle timer would
	// blank everyone else's copy several times an hour.
	got, err = svc.HandlePresenceUpdate(ctx, 1, db.StatusIdle, nil, nil)
	if err != nil {
		t.Fatalf("HandlePresenceUpdate (bare): %v", err)
	}
	if got == nil || *got != "away" {
		t.Fatalf("bare status flip returned %v, want the stored %q", got, "away")
	}
	u, _ = database.GetUserByID(ctx, 1)
	if u.CustomStatus == nil || *u.CustomStatus != "away" {
		t.Fatalf("bare status flip changed the stored text: %v", u.CustomStatus)
	}
}

func TestHandlePresenceUpdate_RejectsUnknownStatusAndOverlongText(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "ada", PasswordHash: "h"})
	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	ctx := context.Background()

	if _, err := svc.HandlePresenceUpdate(ctx, 1, "afk", nil, nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("unknown status err = %v, want ErrBadRequest", err)
	}
	long := strings.Repeat("x", MaxCustomStatusLen+1)
	if _, err := svc.HandlePresenceUpdate(ctx, 1, db.StatusOnline, &long, nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("overlong custom_status err = %v, want ErrBadRequest", err)
	}
	// The rejected call must not have committed the status either.
	u, _ := database.GetUserByID(ctx, 1)
	if u.Status == db.StatusOnline {
		t.Error("a rejected presence_update must not commit the status")
	}
}
