package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func previewChange(t *testing.T, svc *RetentionService, actor int64, c RetentionChange) *ProposedRetentionPreview {
	t.Helper()
	p, err := svc.Policy(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	preview, err := svc.PreviewChange(context.Background(), actor, c, p.Revision)
	if err != nil {
		t.Fatal(err)
	}
	return preview
}

func TestRetentionProposedPreviewMath(t *testing.T) {
	for _, tc := range []struct {
		name       string
		scope      string
		days       *int
		deleted    int64
		indefinite int64
		pinned     int64
		channels   int
	}{
		{"shorter server", "server", new(14), 2, 3, 1, 1},
		{"longer server", "server", new(60), 0, 3, 1, 0},
		{"indefinite server", "server", new(0), 0, 7, 0, 0},
		{"remove indefinite override", "channel", nil, 2, 0, 1, 2},
		{"replace indefinite override", "channel", new(14), 3, 0, 1, 2},
		{"keep indefinite override", "channel", new(0), 1, 3, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			database := newTestDB(t)
			dir := t.TempDir()
			uid, _ := database.CreateUser(ctx, "preview-owner", "hash", 1)
			other, _ := database.CreateUser(ctx, "preview-member", "hash", 4)
			general, _ := seedRetentionChannel(t, database, "preview-general", uid, dir, 3)
			forever, _ := seedRetentionChannel(t, database, "preview-forever", uid, dir, 2)
			// At 30 days exactly, old 0 is exempt by the strict cutoff. Old 1
			// is pinned, while old 2 is a tombstone that is still due.
			if _, err := database.ExecContext(ctx, `UPDATE messages SET pinned = (content = 'old 1'), deleted = (content = 'old 2') WHERE channel_id = ?`, general); err != nil {
				t.Fatal(err)
			}
			dm, _, err := database.GetOrCreateDMChannel(ctx, uid, other)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := database.CreateMessage(ctx, dm.ID, uid, "private", nil); err != nil {
				t.Fatal(err)
			}
			if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "30"}); err != nil {
				t.Fatal(err)
			}
			if err := database.SetChannelRetention(ctx, forever, 0, uid); err != nil {
				t.Fatal(err)
			}
			svc := newRetention(t, database, dir)
			change := RetentionChange{Scope: tc.scope, Days: tc.days}
			if tc.scope == "channel" {
				change.ChannelID = forever
			}
			before, _ := svc.Policy(ctx)
			preview := previewChange(t, svc, uid, change)
			if preview.WouldDelete != tc.deleted || preview.Indefinite != tc.indefinite || preview.Pinned != tc.pinned || preview.AffectedChannels != tc.channels || preview.DirectMessages != 1 {
				t.Fatalf("preview = %+v, effect = %+v", preview, preview.RetentionChangeEffect)
			}
			if preview.ObservedAt != retentionNow.Format(time.RFC3339) || preview.Revision != before.Revision || preview.Token == "" {
				t.Fatalf("missing observation binding: %+v", preview)
			}
			for _, ch := range preview.Channels {
				if ch.ChannelID == dm.ID {
					t.Fatal("preview exposed a DM channel")
				}
			}
			after, _ := svc.Policy(ctx)
			if after.Revision != before.Revision || countMessages(t, database, general) != 4 || countMessages(t, database, forever) != 3 {
				t.Fatal("preview changed persisted policy or messages")
			}
			if err := svc.ApplyChange(ctx, uid, change, preview.Token); err != nil {
				t.Fatal(err)
			}
			rep, err := svc.Tick(ctx)
			if err != nil || int64(rep.Messages) != preview.WouldDelete || rep.Channels != preview.AffectedChannels {
				t.Fatalf("applied sweep = %+v, %v; preview = %+v", rep, err, preview)
			}
		})
	}
}

func TestRetentionPreviewBindingAndStaleRevision(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	uid, _ := database.CreateUser(ctx, "preview-owner", "hash", 1)
	svc := NewRetentionService(database)
	svc.SetClock(func() time.Time { return retentionNow })
	c := RetentionChange{Scope: "server", Days: new(14)}
	preview := previewChange(t, svc, uid, c)
	for _, tc := range []struct {
		name  string
		actor int64
		c     RetentionChange
		token string
	}{
		{"missing", uid, c, ""},
		{"tampered", uid, c, "x" + preview.Token},
		{"other actor", uid + 1, c, preview.Token},
		{"different window", uid, RetentionChange{Scope: "server", Days: new(1)}, preview.Token},
		{"different scope", uid, RetentionChange{Scope: "channel", ChannelID: 1, Days: c.Days}, preview.Token},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := svc.ApplyChange(ctx, tc.actor, tc.c, tc.token); !errors.Is(err, ErrBadRequest) {
				t.Fatalf("apply = %v, want bad request", err)
			}
		})
	}
	svc.SetClock(func() time.Time { return retentionNow.Add(16 * time.Minute) })
	if err := svc.ApplyChange(ctx, uid, c, preview.Token); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expired preview = %v", err)
	}
	svc.SetClock(func() time.Time { return retentionNow })
	// A -> B -> A is still stale, even inside the same timestamp second.
	for _, days := range []string{"60", "0"} {
		if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: days}); err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.ApplyChange(ctx, uid, c, preview.Token); !errors.Is(err, ErrConflict) || !strings.Contains(err.Error(), "nothing was saved") {
		t.Fatalf("stale apply = %v", err)
	}
	if _, err := svc.PreviewChange(ctx, uid, c, preview.Revision); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale editor preview = %v", err)
	}
	p, _ := svc.Policy(ctx)
	if p.ServerDays != 0 {
		t.Fatalf("rejected edit changed policy: %+v", p)
	}
	if err := svc.ApplyChange(ctx, uid, c, previewChange(t, svc, uid, c).Token); err != nil {
		t.Fatal(err)
	}
}

func TestRetentionConcurrentApplyHasOneWinner(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	uid, _ := database.CreateUser(ctx, "concurrent-owner", "hash", 1)
	services := []*RetentionService{NewRetentionService(database), NewRetentionService(database)}
	changes := []RetentionChange{{Scope: "server", Days: new(7)}, {Scope: "server", Days: new(90)}}
	previews := []*ProposedRetentionPreview{previewChange(t, services[0], uid, changes[0]), previewChange(t, services[1], uid, changes[1])}
	start := make(chan struct{})
	results := make([]error, 2)
	var wg sync.WaitGroup
	for i := range services {
		wg.Go(func() { <-start; results[i] = services[i].ApplyChange(ctx, uid, changes[i], previews[i].Token) })
	}
	close(start)
	wg.Wait()
	winners, conflicts, winnerDays := 0, 0, 0
	for i, err := range results {
		switch {
		case err == nil:
			winners++
			winnerDays = *changes[i].Days
		case errors.Is(err, ErrConflict):
			conflicts++
		default:
			t.Fatal(err)
		}
	}
	p, _ := services[0].Policy(ctx)
	if winners != 1 || conflicts != 1 || p.ServerDays != winnerDays {
		t.Fatalf("results=%v, policy=%+v", results, p)
	}
}

func TestRetentionPreviewInvalidationByEveryChannelWriter(t *testing.T) {
	for _, change := range []string{"insert", "update", "delete", "cascade"} {
		t.Run(change, func(t *testing.T) {
			ctx := context.Background()
			database := newTestDB(t)
			uid, _ := database.CreateUser(ctx, "revision-owner", "hash", 1)
			channel, err := database.CreateChannel(ctx, "revision-channel", "text", "", "", 0)
			if err != nil {
				t.Fatal(err)
			}
			if change != "insert" {
				if err := database.SetChannelRetention(ctx, channel, 0, uid); err != nil {
					t.Fatal(err)
				}
			}
			svc := NewRetentionService(database)
			c := RetentionChange{Scope: "server", Days: new(7)}
			p := previewChange(t, svc, uid, c)
			switch change {
			case "insert", "update":
				err = database.SetChannelRetention(ctx, channel, 14, uid)
			case "delete":
				_, err = database.DeleteChannelRetention(ctx, channel)
			case "cascade":
				_, err = database.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, channel)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := svc.ApplyChange(ctx, uid, c, p.Token); !errors.Is(err, ErrConflict) {
				t.Fatalf("%s failed to invalidate preview: %v", change, err)
			}
		})
	}
}

func TestRetentionPreviewValidation(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	uid, _ := database.CreateUser(ctx, "validation-owner", "hash", 1)
	other, _ := database.CreateUser(ctx, "validation-member", "hash", 4)
	dm, _, err := database.GetOrCreateDMChannel(ctx, uid, other)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewRetentionService(database)
	p, _ := svc.Policy(ctx)
	for _, c := range []RetentionChange{
		{}, {Scope: "server"}, {Scope: "server", ChannelID: 1, Days: new(7)},
		{Scope: "server", Days: new(-1)}, {Scope: "server", Days: new(RetentionMaxDays + 1)},
		{Scope: "channel", Days: new(7)}, {Scope: "channel", ChannelID: dm.ID, Days: new(7)},
	} {
		if _, err := svc.PreviewChange(ctx, uid, c, p.Revision); !errors.Is(err, ErrBadRequest) {
			t.Errorf("invalid preview %+v: %v", c, err)
		}
	}
	c := RetentionChange{Scope: "server", Days: new(RetentionMaxDays)}
	if _, err := svc.PreviewChange(ctx, uid, c, ""); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("missing revision = %v", err)
	}
	if _, err := svc.PreviewChange(ctx, uid, c, p.Revision); err != nil {
		t.Fatalf("maximum window = %v", err)
	}
}
