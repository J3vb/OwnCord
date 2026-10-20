package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// Only a live voice channel may be the AFK channel. Every refusal leaves the
// existing flag where it was.
func TestSetAFKChannel_RefusesTextDMAndArchived(t *testing.T) {
	ctx := context.Background()
	svc, database := newChannelAdminService(t)
	actor, _ := database.CreateUser(ctx, "afk-admin", "hash", 1)
	other, _ := database.CreateUser(ctx, "afk-peer", "hash", 1)

	voice, _ := database.CreateChannel(ctx, "lounge", "voice", "", "", 0)
	text, _ := database.CreateChannel(ctx, "general", "text", "", "", 1)
	announce, _ := database.CreateChannel(ctx, "news", "announcement", "", "", 2)
	archived, _ := database.CreateChannel(ctx, "old", "voice", "", "", 3)
	if err := database.AdminUpdateChannel(ctx, archived, db.ChannelUpdate{Name: "old", Archived: true}); err != nil {
		t.Fatal(err)
	}
	dm, _, err := database.GetOrCreateDMChannel(ctx, actor, other)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := svc.SetAFKChannel(ctx, actor, &voice); err != nil {
		t.Fatalf("a live voice channel was refused: %v", err)
	}
	for name, tc := range map[string]struct {
		id   int64
		want error
	}{
		"text":         {text, ErrBadRequest},
		"announcement": {announce, ErrBadRequest},
		"archived":     {archived, ErrBadRequest},
		"dm":           {dm.ID, ErrNotFound},
		"missing":      {99999, ErrNotFound},
	} {
		id := tc.id
		if _, err := svc.SetAFKChannel(ctx, actor, &id); !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", name, err, tc.want)
		}
	}
	if got, err := database.GetAFKChannel(ctx); err != nil || got == nil || got.ID != voice {
		t.Fatalf("a refused request moved the flag: got %+v err=%v, want channel %d", got, err, voice)
	}
}

// The swap returns both rows so the caller can broadcast them, audits once,
// and a no-op request returns nothing to broadcast.
func TestSetAFKChannel_ReturnsBothChannelsAndAudits(t *testing.T) {
	ctx := context.Background()
	svc, database := newChannelAdminService(t)
	actor, _ := database.CreateUser(ctx, "afk-admin", "hash", 1)
	a, _ := database.CreateChannel(ctx, "a", "voice", "", "", 0)
	b, _ := database.CreateChannel(ctx, "b", "voice", "", "", 1)

	if change, err := svc.SetAFKChannel(ctx, actor, &a); err != nil || change.Previous != nil || change.Current == nil || !change.Current.AFK {
		t.Fatalf("first set: %+v err=%v", change, err)
	}
	change, err := svc.SetAFKChannel(ctx, actor, &b)
	if err != nil || change.Previous == nil || change.Previous.ID != a || change.Previous.AFK ||
		change.Current == nil || change.Current.ID != b || !change.Current.AFK {
		t.Fatalf("switch: %+v err=%v", change, err)
	}
	if change, err := svc.SetAFKChannel(ctx, actor, &b); err != nil || change.Previous != nil || change.Current != nil {
		t.Fatalf("repeat set must change nothing: %+v err=%v", change, err)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'afk_channel_change'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("afk_channel_change audit rows = %d err=%v, want 2 (the repeat writes none)", n, err)
	}
}

// Only the five choices the admin card offers are stored, canonically, and a
// missing key leaves the default in force.
func TestSettingsPatch_AFKTimeoutAllowedValues(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	uid, _ := database.CreateUser(ctx, "settings-owner", "hash", 1)
	svc := NewSettingsService(database)

	for _, bad := range []string{"59", "0", "-300", "301", "5m", "", "3601", "1e3"} {
		if _, err := svc.Patch(ctx, uid, map[string]string{AFKTimeoutKey: bad}); err == nil {
			t.Errorf("%s=%q was accepted", AFKTimeoutKey, bad)
		}
	}
	settings, err := svc.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if v, present := settings[AFKTimeoutKey]; present {
		t.Fatalf("a refused patch wrote %s = %q", AFKTimeoutKey, v)
	}

	for _, good := range []string{"60", "300", "900", "1800", "3600"} {
		if _, err := svc.Patch(ctx, uid, map[string]string{AFKTimeoutKey: " " + good + " "}); err != nil {
			t.Errorf("%s=%q refused: %v", AFKTimeoutKey, good, err)
		}
	}
	if _, err := svc.Patch(ctx, uid, map[string]string{AFKTimeoutKey: "300"}); err != nil {
		t.Fatal(err)
	}
	settings, _ = svc.List(ctx)
	if settings[AFKTimeoutKey] != "300" {
		t.Fatalf("stored %s = %q, want 300", AFKTimeoutKey, settings[AFKTimeoutKey])
	}
}
