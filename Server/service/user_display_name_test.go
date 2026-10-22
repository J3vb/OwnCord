package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db/audittest"
)

func timeOutNickFixture(t *testing.T, f *nicknameFixture, target int64, expires time.Time) {
	t.Helper()
	if _, _, err := f.database.TimeoutUser(context.Background(), target, nickMod, nil, "cool off", expires); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
}

func TestUpdateProfile_DisplayNameRefusedWhileTimedOut(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	f.setRaw(ctx, t, nickMember, "Reset")
	timeOutNickFixture(t, f, nickMember, time.Now().Add(time.Hour))

	_, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{DisplayName: new("Mine")})
	if !errors.Is(err, ErrTimedOut) {
		t.Fatalf("err = %v, want ErrTimedOut", err)
	}
	if got := derefOr(f.nickname(ctx, t, nickMember), ""); got != "Reset" {
		t.Errorf("display_name = %q, want unchanged Reset", got)
	}
	// Clearing is a change too.
	if _, err = f.users.UpdateProfile(ctx, nickMember, ProfilePatch{DisplayName: new("")}); !errors.Is(err, ErrTimedOut) {
		t.Errorf("clear err = %v, want ErrTimedOut", err)
	}
}

func TestUpdateProfile_SameDisplayNameAllowedWhileTimedOut(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	f.setRaw(ctx, t, nickMember, "Reset")
	timeOutNickFixture(t, f, nickMember, time.Now().Add(time.Hour))

	if _, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{DisplayName: new("Reset"), About: new("hi")}); err != nil {
		t.Fatalf("resending the current value: %v", err)
	}
	// nil and "" are the same unset: an unset name resent as "" passes.
	if _, err := f.users.UpdateProfile(ctx, nickOther, ProfilePatch{DisplayName: new("")}); err != nil {
		t.Fatalf("unset resent as empty: %v", err)
	}
}

func TestUpdateProfile_OtherAvatarAboutAllowedWhileTimedOut(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	timeOutNickFixture(t, f, nickMember, time.Now().Add(time.Hour))

	before, err := f.database.GetUserByID(ctx, nickMember)
	if err != nil || before == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	// The client resends the current username with every save.
	u, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{
		Username: before.Username, Avatar: new("https://cdn.example.net/a.png"), About: new("about me"),
	})
	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if derefOr(u.About, "") != "about me" || derefOr(u.Avatar, "") == "" {
		t.Errorf("row = %+v, want avatar and about applied", u)
	}
}

// With the nickname reset the username is the shown name, so it is held too.
func TestUpdateProfile_UsernameRefusedWhileTimedOut(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	timeOutNickFixture(t, f, nickMember, time.Now().Add(time.Hour))

	_, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{Username: "renamed3", About: new("x")})
	if !errors.Is(err, ErrTimedOut) {
		t.Fatalf("err = %v, want ErrTimedOut", err)
	}
	u, err := f.database.GetUserByID(ctx, nickMember)
	if err != nil || u == nil || u.Username == "renamed3" || derefOr(u.About, "") == "x" {
		t.Errorf("row = %+v (err %v), want the whole patch refused", u, err)
	}
}

func TestUpdateProfile_DisplayNameAllowedAfterTimeoutLifted(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	timeOutNickFixture(t, f, nickMember, time.Now().Add(time.Hour))
	if _, err := f.database.LiftTimeout(ctx, nickMember, nickMod); err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}

	if _, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{Username: "renamed4", DisplayName: new("Free")}); err != nil {
		t.Fatalf("lifted timeout must not block: %v", err)
	}
}

func TestUpdateProfile_DisplayNameAllowedAfterTimeoutExpired(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	timeOutNickFixture(t, f, nickMember, time.Now().Add(-time.Hour))

	if _, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{DisplayName: new("Free")}); err != nil {
		t.Fatalf("expired timeout must not block: %v", err)
	}
	if got := derefOr(f.nickname(ctx, t, nickMember), ""); got != "Free" {
		t.Errorf("display_name = %q, want Free", got)
	}
}

func TestDisplayName_EqualsOtherUsernameRefused(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	for _, name := range []string{"u4", "U4", "u4 "} {
		if _, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{DisplayName: new(name)}); !errors.Is(err, ErrBadRequest) {
			t.Errorf("self %q: err = %v, want ErrBadRequest", name, err)
		}
		if _, err := f.mod.SetNickname(ctx, nickMod, nickMember, new(name)); !errors.Is(err, ErrBadRequest) {
			t.Errorf("moderator %q: err = %v, want ErrBadRequest", name, err)
		}
	}
	if got := f.nickname(ctx, t, nickMember); got != nil {
		t.Errorf("display_name = %q, want unset", *got)
	}
	// Authorization still comes first: no bit, Forbidden.
	if _, err := f.mod.SetNickname(ctx, nickOther, nickMember, new("u4")); !errors.Is(err, ErrForbidden) {
		t.Errorf("no bit: err = %v, want ErrForbidden", err)
	}
}

func TestDisplayName_OwnUsernameAllowed(t *testing.T) {
	f := newNicknameFixture(t)
	ctx := context.Background()
	if _, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{DisplayName: new("U3")}); err != nil {
		t.Fatalf("self: %v", err)
	}
	if _, err := f.mod.SetNickname(ctx, nickMod, nickOther, new("u4")); err != nil {
		t.Fatalf("moderator: %v", err)
	}
}

func TestUpdateProfile_AuditRecordsDisplayNameChange(t *testing.T) {
	f := newNicknameFixture(t)
	rec := audittest.Install(t, f.database)
	ctx := context.Background()

	for _, name := range []string{"Bob", "Alice", ""} {
		if _, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{DisplayName: new(name)}); err != nil {
			t.Fatalf("UpdateProfile(%q): %v", name, err)
		}
	}
	if _, err := f.users.UpdateProfile(ctx, nickMember, ProfilePatch{About: new("x")}); err != nil {
		t.Fatalf("about only: %v", err)
	}
	want := []string{
		`username=u3 display_name (none) -> "Bob"`,
		`username=u3 display_name "Bob" -> "Alice"`,
		`username=u3 display_name "Alice" -> (none)`,
		`username=u3`,
	}
	deadline := time.Now().Add(5 * time.Second)
	var got []string
	for time.Now().Before(deadline) {
		got = got[:0]
		for _, e := range rec.Entries() {
			if e.Action == "profile_update" {
				got = append(got, e.Detail)
			}
		}
		if len(got) >= len(want) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("details = %q, want %q", got, want)
	}
}
