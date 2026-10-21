package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// seedForumPost inserts a post (a thread under a forum), as migration 075
// shapes one.
func seedForumPost(t *testing.T, database *db.DB, id, forumID int64) {
	t.Helper()
	seedThread(t, database, id, forumID)
}

// verdicts is every predicate a post must answer exactly as its forum does,
// by user, over the channel as the service resolves it.
func verdicts(t *testing.T, permSvc *PermissionService, database *db.DB, userID, channelID int64) map[string]string {
	t.Helper()
	ctx := context.Background()
	ch, err := database.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel(%d): %v", channelID, err)
	}
	sub, err := channelSubject(ctx, database, permSvc, userID, ch, false)
	if err != nil {
		t.Fatalf("channelSubject(%d): %v", channelID, err)
	}
	sub.Channel.NSFW = ch.NSFW
	str := func(err error) string {
		if err == nil {
			return "ok"
		}
		return err.Error()
	}
	return map[string]string{
		"view":    str(permissions.CanViewChannel(sub)),
		"send":    str(permissions.CanSendMessage(sub)),
		"react":   str(permissions.CanAddReaction(sub)),
		"pin":     str(permissions.CanPinMessage(sub)),
		"content": str(permissions.CanReadContent(sub)),
	}
}

// TestForumPostInheritsForum holds the 6.9d claim that a forum post needs no
// resolver change: for every override layer and channel flag, the post's
// verdict for view, send, react, pin and read-content equals its forum's,
// except that a locked post refuses members a send and a reaction.
func TestForumPostInheritsForum(t *testing.T) {
	const forum, post, userID = 12, 22, 2
	cases := []struct {
		name      string
		setup     func(t *testing.T, database *db.DB)
		lockDiffs bool // the post itself is locked: send and react differ
		wantForum map[string]string
	}{
		{name: "forum allows", setup: func(*testing.T, *db.DB) {}, wantForum: map[string]string{"view": "ok", "send": "ok"}},
		{name: "forum denies by role override", setup: func(t *testing.T, d *db.DB) {
			seedChannelOverride(t, d, permissions.MemberRoleID, forum, 0, permissions.ReadMessages)
		}, wantForum: map[string]string{"view": "missing", "send": "missing"}},
		{name: "forum denies by user override", setup: func(t *testing.T, d *db.DB) {
			seedChannelUserOverride(t, d, userID, forum, 0, permissions.ReadMessages)
		}, wantForum: map[string]string{"view": "missing", "send": "missing"}},
		{name: "forum allows by user override over a role deny", setup: func(t *testing.T, d *db.DB) {
			seedChannelOverride(t, d, permissions.MemberRoleID, forum, 0, permissions.ReadMessages)
			seedChannelUserOverride(t, d, userID, forum, permissions.ReadMessages, 0)
		}, wantForum: map[string]string{"view": "ok", "send": "ok"}},
		{name: "forum NSFW unacknowledged", setup: func(t *testing.T, d *db.DB) {
			if _, err := d.ExecContext(context.Background(), `UPDATE channels SET nsfw = 1 WHERE id = ?`, forum); err != nil {
				t.Fatal(err)
			}
		}, wantForum: map[string]string{"view": "ok", "content": permissions.ErrNSFWUnacknowledged.Error()}},
		{name: "forum archived", setup: func(t *testing.T, d *db.DB) {
			if _, err := d.ExecContext(context.Background(), `UPDATE channels SET archived = 1 WHERE id = ?`, forum); err != nil {
				t.Fatal(err)
			}
		}, wantForum: map[string]string{"send": permissions.ErrArchived.Error()}},
		{name: "post locked", lockDiffs: true, setup: func(t *testing.T, d *db.DB) {
			if _, err := d.ExecContext(context.Background(), `UPDATE channels SET thread_locked = 1 WHERE id = ?`, post); err != nil {
				t.Fatal(err)
			}
		}, wantForum: map[string]string{"view": "ok", "send": "ok"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, permSvc, database := newOverrideFixture(t)
			// The fixture's role cannot react; give it the bit so the react
			// verdict means something.
			if _, err := database.ExecContext(context.Background(), `UPDATE roles SET permissions = permissions | ? WHERE id = ?`,
				permissions.AddReactions, permissions.MemberRoleID); err != nil {
				t.Fatal(err)
			}
			seedChannel(t, database, &db.Channel{ID: forum, Name: "ideas", Type: "forum"})
			seedForumPost(t, database, post, forum)
			tc.setup(t, database)
			permSvc.InvalidateAll()

			f := verdicts(t, permSvc, database, userID, forum)
			p := verdicts(t, permSvc, database, userID, post)
			for k, want := range tc.wantForum {
				if !strings.Contains(f[k], want) {
					t.Fatalf("forum %s = %q, want it to contain %q (the case is not testing what it says)", k, f[k], want)
				}
			}
			for k := range f {
				if tc.lockDiffs && (k == "send" || k == "react") {
					if !strings.Contains(p[k], permissions.ErrThreadLocked.Error()) {
						t.Errorf("locked post %s = %q, want ErrThreadLocked (forum: %q)", k, p[k], f[k])
					}
					continue
				}
				if p[k] != f[k] {
					t.Errorf("%s: post = %q, forum = %q, want the post to answer as its forum does", k, p[k], f[k])
				}
			}
		})
	}
}

func newForumSettingsService(t *testing.T) (*ChannelService, *db.DB, *db.Channel) {
	t.Helper()
	svc, _, database := newOverrideFixture(t)
	seedChannel(t, database, &db.Channel{ID: 12, Name: "ideas", Type: "forum"})
	forum, err := svc.ResolveGuildChannel(context.Background(), 12)
	if err != nil {
		t.Fatalf("a forum must resolve on the admin surface: %v", err)
	}
	return svc, database, forum
}

func TestAdminUpdateForumSettings(t *testing.T) {
	svc, database, forum := newForumSettingsService(t)
	ctx := context.Background()

	got, err := svc.AdminUpdateForumSettings(ctx, 7, forum, ForumSettingsInput{
		RequireTag:                true,
		DefaultAutoArchiveMinutes: 1440,
		Tags:                      []ForumTagInput{{Name: "  <b>bug</b> "}, {Name: "idea", Emoji: "💡"}},
	})
	if err != nil {
		t.Fatalf("AdminUpdateForumSettings: %v", err)
	}
	if got.Forum == nil || !got.Forum.RequireTag || got.Forum.DefaultAutoArchiveMinutes != 1440 ||
		len(got.Forum.Tags) != 2 || got.Forum.Tags[0].Name != "bug" || got.Forum.Tags[1].Emoji != "💡" {
		t.Fatalf("settings = %+v", got.Forum)
	}
	entries, err := database.GetAuditLog(ctx, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	audited := false
	for _, e := range entries {
		audited = audited || (e.Action == "channel_update" && e.ActorID == 7 && strings.Contains(e.Detail, "forum settings"))
	}
	if !audited {
		t.Error("no audit row for the settings change")
	}

	// A second write replaces: rename keeps the id, an omitted tag is deleted.
	first := got.Forum.Tags[0].ID
	got, err = svc.AdminUpdateForumSettings(ctx, 7, forum, ForumSettingsInput{
		DefaultAutoArchiveMinutes: 4320,
		Tags:                      []ForumTagInput{{ID: first, Name: "defect"}},
	})
	if err != nil || len(got.Forum.Tags) != 1 || got.Forum.Tags[0].ID != first || got.Forum.Tags[0].Name != "defect" || got.Forum.RequireTag {
		t.Fatalf("replace = %+v, %v", got.Forum, err)
	}
}

// Every validation refusal answers ErrBadRequest and writes nothing.
func TestAdminUpdateForumSettings_RefusalsWriteNothing(t *testing.T) {
	svc, database, forum := newForumSettingsService(t)
	ctx := context.Background()
	if _, err := svc.AdminUpdateForumSettings(ctx, 7, forum, ForumSettingsInput{
		RequireTag: true, DefaultAutoArchiveMinutes: 60, Tags: []ForumTagInput{{Name: "keep"}},
	}); err != nil {
		t.Fatal(err)
	}
	twenty1 := make([]ForumTagInput, MaxForumTags+1)
	for i := range twenty1 {
		twenty1[i] = ForumTagInput{Name: string(rune('a' + i))}
	}
	cases := map[string]ForumSettingsInput{
		"bad archive period":        {DefaultAutoArchiveMinutes: 5},
		"too many tags":             {DefaultAutoArchiveMinutes: 60, Tags: twenty1},
		"empty name":                {DefaultAutoArchiveMinutes: 60, Tags: []ForumTagInput{{Name: " <i></i> "}}},
		"name over 20 runes":        {DefaultAutoArchiveMinutes: 60, Tags: []ForumTagInput{{Name: strings.Repeat("é", MaxForumTagNameLen+1)}}},
		"names equal ignoring case": {DefaultAutoArchiveMinutes: 60, Tags: []ForumTagInput{{Name: "Bug"}, {Name: "bUG"}}},
		"control character emoji":   {DefaultAutoArchiveMinutes: 60, Tags: []ForumTagInput{{Name: "x", Emoji: "a\x01"}}},
		"negative id":               {DefaultAutoArchiveMinutes: 60, Tags: []ForumTagInput{{ID: -1, Name: "x"}}},
		"unknown id":                {DefaultAutoArchiveMinutes: 60, Tags: []ForumTagInput{{ID: 9999, Name: "x"}}},
		"id used twice":             {DefaultAutoArchiveMinutes: 60, Tags: []ForumTagInput{{ID: 1, Name: "x"}, {ID: 1, Name: "y"}}},
	}
	for name, in := range cases {
		if _, err := svc.AdminUpdateForumSettings(ctx, 7, forum, in); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", name, err)
		}
	}
	now, err := database.GetChannel(ctx, forum.ID)
	if err != nil || now.Forum == nil || !now.Forum.RequireTag || now.Forum.DefaultAutoArchiveMinutes != 60 ||
		len(now.Forum.Tags) != 1 || now.Forum.Tags[0].Name != "keep" {
		t.Errorf("a refused write changed the forum: %+v, %v", now.Forum, err)
	}

	// Only a forum takes settings.
	text, err := svc.ResolveGuildChannel(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AdminUpdateForumSettings(ctx, 7, text, ForumSettingsInput{DefaultAutoArchiveMinutes: 60}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("settings on a text channel: err = %v, want ErrBadRequest", err)
	}
}

// A forum holds no messages: a send is refused after the permission check, so
// a member who cannot read it learns nothing about its type, and typing is
// dropped silently.
func TestSendAndTypingIntoForumRefused(t *testing.T) {
	msgSvc, database := newTestMessageService(t)
	seedChannel(t, database, &db.Channel{ID: 40, Name: "ideas", Type: "forum"})
	seedChannel(t, database, &db.Channel{ID: 41, Name: "hidden", Type: "forum"})
	seedChannelOverride(t, database, permissions.MemberRoleID, 41, 0, permissions.ReadMessages)
	ctx := context.Background()

	_, err := msgSvc.SendMessage(ctx, SendMessageParams{ChannelID: 40, UserID: 1, Username: "alice", Content: "hi"})
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("send into a forum: err = %v, want ErrBadRequest", err)
	}
	_, err = msgSvc.SendMessage(ctx, SendMessageParams{ChannelID: 41, UserID: 1, Username: "alice", Content: "hi"})
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("send into a forum the member cannot read: err = %v, want ErrForbidden, not a type disclosure", err)
	}
	if n := msgSvcCount(t, database, 40); n != 0 {
		t.Errorf("%d messages written into the forum", n)
	}

	chSvc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	if ch, err := chSvc.HandleTyping(ctx, 1, 40, nil); ch != nil || err != nil {
		t.Errorf("typing in a forum = %v, %v, want a silent drop", ch, err)
	}
	if ch, err := chSvc.HandleTyping(ctx, 1, 10, nil); ch == nil || err != nil {
		t.Errorf("typing in a text channel = %v, %v, want it to resolve", ch, err)
	}
}

func msgSvcCount(t *testing.T, database *db.DB, channelID int64) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, channelID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A forum is focusable (its view subscribes to its posts' changes) and writes
// no read state; a post of it is refused like any thread.
func TestForumFocusAdmittedPostRefused(t *testing.T) {
	channels, _, database := newOverrideFixture(t)
	ctx := context.Background()
	seedChannel(t, database, &db.Channel{ID: 12, Name: "ideas", Type: "forum"})
	seedForumPost(t, database, 22, 12)
	if ch, err := channels.HandleChannelFocus(ctx, 1, 12); err != nil || ch == nil || ch.Type != "forum" {
		t.Errorf("HandleChannelFocus(forum) = %v, %v", ch, err)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM read_states WHERE channel_id = 12`).Scan(&n); err != nil || n != 0 {
		t.Errorf("focusing a forum wrote %d read_states rows (%v)", n, err)
	}
	if _, err := channels.AdmitChannelFocus(ctx, 1, 22); !errors.Is(err, ErrNotFound) {
		t.Errorf("AdmitChannelFocus(post) = %v, want ErrNotFound", err)
	}
	if _, err := channels.ResolveGuildChannel(ctx, 22); !errors.Is(err, ErrBadRequest) {
		t.Errorf("ResolveGuildChannel(post) = %v, want ErrBadRequest", err)
	}
}
