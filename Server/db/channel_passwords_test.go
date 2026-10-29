package db_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func setChannelPassword(t *testing.T, d *db.DB, ch *db.Channel, change *db.ChannelPasswordChange) {
	t.Helper()
	err := d.AdminUpdateChannel(context.Background(), ch.ID, db.ChannelUpdate{
		Name: ch.Name, Topic: ch.Topic, CategoryID: ch.CategoryID, SlowMode: ch.SlowMode,
		Position: ch.Position, VoiceMaxUsers: ch.VoiceMaxUsers, VoiceMaxVideo: ch.VoiceMaxVideo,
		Password: change,
	})
	if err != nil {
		t.Fatalf("AdminUpdateChannel: %v", err)
	}
}

func newPasswordChannel(t *testing.T, d *db.DB, name, chType string) *db.Channel {
	t.Helper()
	id, err := d.CreateChannel(context.Background(), name, chType, "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	ch, err := d.GetChannel(context.Background(), id)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	return ch
}

// The grant is written only while the channel still has the version the
// caller checked the password against.
func TestGrantChannelPassword_OnlyWhileVersionIsCurrent(t *testing.T) {
	ctx := context.Background()
	d := openMigratedMemory(t)
	ch := newPasswordChannel(t, d, "pw-grant", "voice")
	uid := seedThreadUser(t, d, "pw-grant-user")

	setChannelPassword(t, d, ch, &db.ChannelPasswordChange{Hash: "hash-one"})
	_, version, found, err := d.ChannelPasswordState(ctx, ch.ID)
	if err != nil || !found {
		t.Fatalf("ChannelPasswordState: found=%v err=%v", found, err)
	}

	// The password changes between the hash read and the grant write.
	setChannelPassword(t, d, ch, &db.ChannelPasswordChange{Hash: "hash-two"})
	written, err := d.GrantChannelPassword(ctx, ch.ID, uid, version)
	if err != nil {
		t.Fatal(err)
	}
	if written {
		t.Fatal("a grant for a stale version was written")
	}
	if ok, _ := d.HasChannelPasswordGrant(ctx, ch.ID, uid); ok {
		t.Fatal("a refused grant left a row behind")
	}

	// With the current version it is written, and found.
	hash, version, _, _ := d.ChannelPasswordState(ctx, ch.ID)
	if hash != "hash-two" {
		t.Fatalf("hash = %q, want hash-two", hash)
	}
	if written, err = d.GrantChannelPassword(ctx, ch.ID, uid, version); err != nil || !written {
		t.Fatalf("current-version grant: written=%v err=%v", written, err)
	}
	if ok, _ := d.HasChannelPasswordGrant(ctx, ch.ID, uid); !ok {
		t.Fatal("grant not found after it was written")
	}

	// A change makes the grant stop counting, and so does a removal.
	setChannelPassword(t, d, ch, &db.ChannelPasswordChange{Hash: "hash-three"})
	if ok, _ := d.HasChannelPasswordGrant(ctx, ch.ID, uid); ok {
		t.Fatal("grant for an older password still counts")
	}
	_, version, _, _ = d.ChannelPasswordState(ctx, ch.ID)
	if written, _ = d.GrantChannelPassword(ctx, ch.ID, uid, version); !written {
		t.Fatal("re-grant for the new password refused")
	}
	setChannelPassword(t, d, ch, &db.ChannelPasswordChange{Clear: true})
	if ok, _ := d.HasChannelPasswordGrant(ctx, ch.ID, uid); ok {
		t.Fatal("grant counts on a channel whose password was removed")
	}
	if written, _ = d.GrantChannelPassword(ctx, ch.ID, uid, version+1); written {
		t.Fatal("a grant was written on a channel with no password")
	}
}

func TestChannelPassword_VoiceOnlyAndNeverInTheChannelRow(t *testing.T) {
	ctx := context.Background()
	d := openMigratedMemory(t)
	text := newPasswordChannel(t, d, "pw-text", "text")
	voice := newPasswordChannel(t, d, "pw-voice", "voice")

	setChannelPassword(t, d, text, &db.ChannelPasswordChange{Hash: "$2a$10$texthashtexthashtexthash"})
	if hash, _, _, _ := d.ChannelPasswordState(ctx, text.ID); hash != "" {
		t.Fatal("a text channel stored a password")
	}

	setChannelPassword(t, d, voice, &db.ChannelPasswordChange{Hash: "$2a$10$voicehashvoicehashvoice"})
	got, err := d.GetChannel(ctx, voice.ID)
	if err != nil || got == nil || !got.PasswordProtected {
		t.Fatalf("GetChannel: %+v err=%v, want PasswordProtected", got, err)
	}
	list, err := d.ListChannels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for i := range list {
		raw, _ := json.Marshal(list[i])
		if strings.Contains(string(raw), "$2a$") || strings.Contains(string(raw), "password_hash") {
			t.Fatalf("channel JSON leaks the hash: %s", raw)
		}
		if list[i].ID == voice.ID && !list[i].PasswordProtected {
			t.Fatal("ListChannels lost PasswordProtected")
		}
	}
}

// Deleting the channel or the user removes the grants.
func TestChannelPasswordGrants_CascadeOnDelete(t *testing.T) {
	ctx := context.Background()
	d := openMigratedMemory(t)
	ch := newPasswordChannel(t, d, "pw-cascade", "voice")
	uid := seedThreadUser(t, d, "pw-cascade-user")
	setChannelPassword(t, d, ch, &db.ChannelPasswordChange{Hash: "h"})
	_, version, _, _ := d.ChannelPasswordState(ctx, ch.ID)
	if written, err := d.GrantChannelPassword(ctx, ch.ID, uid, version); err != nil || !written {
		t.Fatalf("grant: %v %v", written, err)
	}
	if err := d.AdminDeleteChannel(ctx, ch.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := d.QueryRowContext(ctx, `SELECT COUNT(*) FROM channel_password_grants`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("grants left after channel delete = %d err=%v", n, err)
	}
}
