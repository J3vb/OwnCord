package db_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestProposedRetentionSnapshotAndAtomicApply(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	uid, _ := database.CreateUser(ctx, "policy-owner", "hash", 1)
	other, _ := database.CreateUser(ctx, "policy-member", "hash", 4)
	channel, _ := database.CreateChannel(ctx, "policy-channel", "text", "", "", 0)
	dm, _, err := database.GetOrCreateDMChannel(ctx, uid, other)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	seedAgedMessage(t, database, channel, uid, "old", now.Add(-31*24*time.Hour), false)
	seedAgedMessage(t, database, channel, uid, "pinned", now.Add(-31*24*time.Hour), true)
	seedAgedMessage(t, database, channel, uid, "boundary", now.Add(-30*24*time.Hour), false)
	seedAgedMessage(t, database, dm.ID, uid, "private", now.Add(-31*24*time.Hour), false)
	policy := func() *db.RetentionPolicySnapshot {
		t.Helper()
		p, err := database.RetentionPolicySnapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	server := db.RetentionChange{Scope: "server", Days: new(30)}
	p := policy()
	preview, err := database.PreviewRetentionChange(ctx, server, p.Revision, now)
	if err != nil || len(preview.Channels) != 1 || preview.Channels[0].WouldDelete != 1 || preview.Channels[0].ProtectedPinned != 1 || preview.DirectMessages != 1 {
		t.Fatalf("preview=%+v, err=%v", preview, err)
	}
	if got := policy(); got.Revision != p.Revision || got.ServerDays != 0 {
		t.Fatal("read-only preview changed policy")
	}
	detail, err := database.ApplyRetentionChange(ctx, uid, server, p.Revision)
	if err != nil || !strings.Contains(detail, "0 -> 30") {
		t.Fatalf("apply=%q, %v", detail, err)
	}
	if _, err := database.ApplyRetentionChange(ctx, other, server, p.Revision); !errors.Is(err, db.ErrConflict) {
		t.Fatalf("stale write=%v", err)
	}
	if _, err := database.PreviewRetentionChange(ctx, server, p.Revision, now); !errors.Is(err, db.ErrConflict) {
		t.Fatalf("stale preview=%v", err)
	}
	override := db.RetentionChange{Scope: "channel", ChannelID: channel, Days: new(0)}
	p = policy()
	if _, err := database.ApplyRetentionChange(ctx, uid, override, p.Revision); err != nil {
		t.Fatal(err)
	}
	p = policy()
	preview, err = database.PreviewRetentionChange(ctx, server, p.Revision, now)
	if err != nil || preview.Channels[0].ProtectedIndefinite != 3 || preview.Channels[0].WouldDelete != 0 {
		t.Fatalf("indefinite preview=%+v, %v", preview, err)
	}
	override.Days = nil
	preview, err = database.PreviewRetentionChange(ctx, override, p.Revision, now)
	if err != nil || preview.Channels[0].WouldDelete != 1 || preview.Channels[0].Source != "server" {
		t.Fatalf("remove indefinite=%+v, %v", preview, err)
	}
	if _, err := database.ApplyRetentionChange(ctx, uid, override, p.Revision); err != nil {
		t.Fatal(err)
	}
	p = policy()
	if _, err := database.ApplyRetentionChange(ctx, uid, override, p.Revision); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("remove absent override=%v", err)
	}
	for _, id := range []int64{channel, dm.ID, 999999} {
		change := db.RetentionChange{Scope: "channel", ChannelID: id, Days: new(7)}
		_, previewErr := database.PreviewRetentionChange(ctx, change, p.Revision, now)
		_, applyErr := database.ApplyRetentionChange(ctx, uid, change, p.Revision)
		switch id {
		case channel:
			if previewErr != nil || applyErr != nil {
				t.Fatalf("channel preview=%v apply=%v", previewErr, applyErr)
			}
			p = policy()
		case dm.ID:
			if !errors.Is(previewErr, db.ErrRetentionProtectedChannel) || !errors.Is(applyErr, db.ErrRetentionProtectedChannel) {
				t.Fatalf("DM preview=%v apply=%v", previewErr, applyErr)
			}
		default:
			if !errors.Is(previewErr, db.ErrNotFound) || !errors.Is(applyErr, db.ErrNotFound) {
				t.Fatalf("absent channel preview=%v apply=%v", previewErr, applyErr)
			}
		}
	}
}

func TestProposedRetentionFailsSafeForMalformedWindows(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	uid, _ := database.CreateUser(ctx, "malformed-owner", "hash", 1)
	channel, _ := database.CreateChannel(ctx, "malformed", "text", "", "", 0)
	other, _ := database.CreateChannel(ctx, "other", "text", "", "", 0)
	if err := database.SetChannelRetention(ctx, channel, db.RetentionMaxDays+1, uid); err != nil {
		t.Fatal(err)
	}
	if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "106752"}); err != nil {
		t.Fatal(err)
	}
	p, err := database.RetentionPolicySnapshot(ctx)
	if err != nil || p.ServerDays != 0 {
		t.Fatalf("malformed policy=%+v, %v", p, err)
	}
	preview, err := database.PreviewRetentionChange(ctx, db.RetentionChange{Scope: "channel", ChannelID: other, Days: new(1)}, p.Revision, time.Now())
	if err != nil || preview.Channels[0].Days != 0 {
		t.Fatalf("malformed override=%+v, %v", preview, err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := database.RetentionPolicySnapshot(ctx); err == nil {
		t.Fatal("closed store returned a policy")
	}
	if _, err := database.PreviewRetentionChange(ctx, db.RetentionChange{Scope: "server", Days: new(1)}, p.Revision, time.Now()); err == nil {
		t.Fatal("closed store returned a preview")
	}
	if _, err := database.ApplyRetentionChange(ctx, uid, db.RetentionChange{Scope: "server", Days: new(1)}, p.Revision); err == nil {
		t.Fatal("closed store accepted a write")
	}
}
