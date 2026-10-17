package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestAuthorizeGroupIcon_GateOrder(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()

	if err := f.dms.AuthorizeGroupIcon(ctx, fixtureMember2, f.dm); err != nil {
		t.Fatalf("a member must pass: %v", err)
	}
	if err := f.dms.AuthorizeGroupIcon(ctx, fixturePeerMod, f.dm); !errors.Is(err, ErrNotFound) {
		t.Errorf("non-member = %v, want ErrNotFound", err)
	}
	oneToOne, err := f.dms.CreateDM(ctx, fixtureMember, fixtureOwner)
	if err != nil {
		t.Fatalf("CreateDM: %v", err)
	}
	if err = f.dms.AuthorizeGroupIcon(ctx, fixtureMember, oneToOne.Channel.ID); !errors.Is(err, ErrBadRequest) {
		t.Errorf("1:1 = %v, want ErrBadRequest", err)
	}
	if _, err = f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if err = f.dms.AuthorizeGroupIcon(ctx, fixtureMember, f.dm); !errors.Is(err, ErrTimedOut) {
		t.Errorf("timed out = %v, want ErrTimedOut", err)
	}
}

func TestSetGroupIcon_RowFallbackTextAndAuthor(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	if err := f.database.CreateAttachment(ctx, "icon-a", fixtureMember2, "a.png", "s-a", "image/png", 1, nil, nil); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	icon := "icon-a"
	res, err := f.dms.SetGroupIcon(ctx, fixtureMember2, f.dm, &icon)
	if err != nil {
		t.Fatalf("SetGroupIcon: %v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0].Kind != "group_icon" || res.Rows[0].IconRemoved || res.Rows[0].Author == nil || res.Rows[0].Author.ID != fixtureMember2 {
		t.Fatalf("rows = %+v, want one group_icon authored by the actor", res.Rows)
	}
	if want := groupActorName(res.Rows[0].Author) + " changed the group icon."; res.Rows[0].Content != want {
		t.Errorf("content = %q, want %q", res.Rows[0].Content, want)
	}
	if len(res.Audience) != 3 {
		t.Errorf("audience = %v, want the 3 members", res.Audience)
	}

	res, err = f.dms.SetGroupIcon(ctx, fixtureMember, f.dm, nil)
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if len(res.Rows) != 1 || !res.Rows[0].IconRemoved || res.Rows[0].Content != groupActorName(res.Rows[0].Author)+" removed the group icon." {
		t.Errorf("clear rows = %+v", res.Rows)
	}
	if res, err = f.dms.SetGroupIcon(ctx, fixtureMember, f.dm, nil); err != nil || len(res.Rows) != 0 {
		t.Errorf("clear with no icon = %+v, %v; want no rows", res, err)
	}
	if _, err = f.dms.SetGroupIcon(ctx, fixturePeerMod, f.dm, &icon); !errors.Is(err, ErrNotFound) {
		t.Errorf("non-member set = %v, want ErrNotFound", err)
	}
}

func TestSetGroupIcon_TimedOutRefusedAndWritesNothing(t *testing.T) {
	f := newGroupMembershipFixture(t)
	ctx := context.Background()
	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if _, err := f.dms.SetGroupIcon(ctx, fixtureMember, f.dm, nil); !errors.Is(err, ErrTimedOut) {
		t.Errorf("clear while timed out = %v, want ErrTimedOut", err)
	}
	if f.rowCount(t) != 0 {
		t.Errorf("a refused icon change wrote a row")
	}
}

// The service builds icon URLs with AvatarFileURL and the db layer with
// GroupIconURL (db cannot import service): the two must agree.
func TestGroupIconURL_MatchesAvatarFileURL(t *testing.T) {
	for _, id := range []string{"a", "0f8e-4c", "icon.png"} {
		if got, want := db.GroupIconURL(id), AvatarFileURL(id); got != want {
			t.Errorf("GroupIconURL(%q) = %q, AvatarFileURL = %q", id, got, want)
		}
	}
	if db.GroupIconURL("") != "" {
		t.Errorf("GroupIconURL(\"\") must be empty")
	}
}
