package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// B2-5 parity tables for the ws call sites that decide a security property:
// each site is run against the canonical permissions predicate over the same
// fixture, in both the PermissionService-wired and the bare-hub branch, so
// the two resolution paths and the rule can never disagree (S-12).

// parityOverrideCases are the override layers every ws parity table walks:
// each one flips a bit the predicates consult.
var parityOverrideCases = []struct {
	name        string
	allow, deny int64 // role layer
	uAllow      int64 // user layer
	uDeny       int64
}{
	{"no override", 0, 0, 0, 0},
	{"role deny SEND", 0, permissions.SendMessages, 0, 0},
	{"role deny READ", 0, permissions.ReadMessages, 0, 0},
	{"role deny CONNECT", 0, permissions.ConnectVoice, 0, 0},
	{"role deny MUTE", 0, permissions.MuteMembers, 0, 0},
	{"role allow MANAGE", permissions.ManageMessages, 0, 0, 0},
	{"user deny SEND", 0, 0, 0, permissions.SendMessages},
	{"user deny READ", 0, 0, 0, permissions.ReadMessages},
	{"user deny MUTE", 0, 0, 0, permissions.MuteMembers},
	{"user allow MANAGE", 0, 0, permissions.ManageMessages, 0},
	{"user allow beats role deny", 0, permissions.SendMessages, permissions.SendMessages, 0},
}

// setParityOverrides installs one case's layers for (role, user) on the
// channel and drops the permission cache so the service branch re-reads.
func setParityOverrides(t *testing.T, database *db.DB, permSvc *service.PermissionService, chID, roleID, userID int64, c struct {
	name        string
	allow, deny int64
	uAllow      int64
	uDeny       int64
},
) {
	t.Helper()
	ctx := context.Background()
	if err := database.UpsertChannelOverride(ctx, chID, roleID, c.allow, c.deny); err != nil {
		t.Fatalf("%s: UpsertChannelOverride: %v", c.name, err)
	}
	if err := database.UpsertChannelUserOverride(ctx, chID, userID, c.uAllow, c.uDeny); err != nil {
		t.Fatalf("%s: UpsertChannelUserOverride: %v", c.name, err)
	}
	permSvc.InvalidateAll()
}

// paritySubject resolves the subject the way the test wants it, straight from
// the Checker, so the site under test is compared against an independent
// resolution rather than its own.
func paritySubject(t *testing.T, database *db.DB, userID int64, ch *db.Channel) permissions.Subject {
	t.Helper()
	ctx := context.Background()
	role, err := database.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		t.Fatalf("GetRoleForUser(%d): %v", userID, err)
	}
	sub, err := permissions.NewChecker(database).Subject(ctx, role.Permissions, role.ID, userID, ch.ID)
	if err != nil {
		t.Fatalf("Checker.Subject: %v", err)
	}
	sub.Channel = channelRef(ch)
	return sub
}

// TestRefreshChannelVisibilityCanSend_Parity: the composer refresh verdict is
// CanSendMessage in both branches, for text and announcement channels.
func TestRefreshChannelVisibilityCanSend_Parity(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "refresh-parity-user")
	textID := mustCreateVoiceChannel(t, database, "refresh-parity-text")
	if _, err := database.ExecContext(ctx, `UPDATE channels SET type = 'text' WHERE id = ?`, textID); err != nil {
		t.Fatalf("retype: %v", err)
	}
	newsID := mustCreateVoiceChannel(t, database, "refresh-parity-news")
	if _, err := database.ExecContext(ctx, `UPDATE channels SET type = 'announcement' WHERE id = ?`, newsID); err != nil {
		t.Fatalf("retype: %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	permSvc := service.NewPermissionService(database, h.permChecker)

	for _, chID := range []int64{textID, newsID} {
		ch, err := database.GetChannel(ctx, chID)
		if err != nil || ch == nil {
			t.Fatalf("GetChannel(%d): %v", chID, err)
		}
		for _, c := range parityOverrideCases {
			setParityOverrides(t, database, permSvc, chID, harvestVoiceRoleID, uid, c)
			want := permissions.CanSendMessage(paritySubject(t, database, uid, ch)) == nil

			h.perms = nil
			if got := h.refreshChannelVisibilityCanSend(ctx, ch, uid); got != want {
				t.Errorf("%s/%s bare hub: refreshChannelVisibilityCanSend = %v, CanSendMessage = %v", ch.Type, c.name, got, want)
			}
			h.perms = permSvc
			if got := h.refreshChannelVisibilityCanSend(ctx, ch, uid); got != want {
				t.Errorf("%s/%s service: refreshChannelVisibilityCanSend = %v, CanSendMessage = %v", ch.Type, c.name, got, want)
			}
		}
	}
}

// viewParityFixture is a bare hub with one registered client on a text
// channel plus a second, archived channel, shared by the view-property
// parity tables below.
type viewParityFixture struct {
	h        *Hub
	database *db.DB
	permSvc  *service.PermissionService
	user     *db.User
	textID   int64
	oldID    int64 // archived
	client   *Client
	send     chan []byte
}

func newViewParityFixture(t *testing.T) *viewParityFixture {
	t.Helper()
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "view-parity-user")
	textID := mustCreateVoiceChannel(t, database, "view-parity-text")
	oldID := mustCreateVoiceChannel(t, database, "view-parity-old")
	if _, err := database.ExecContext(ctx, `UPDATE channels SET type = 'text' WHERE id IN (?, ?)`, textID, oldID); err != nil {
		t.Fatalf("retype: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET archived = 1 WHERE id = ?`, oldID); err != nil {
		t.Fatalf("archive: %v", err)
	}
	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	send := make(chan []byte, 64)
	c := NewTestClientWithUser(h, user, textID, send)
	h.RegisterNowForTest(c)
	return &viewParityFixture{
		h: h, database: database, permSvc: service.NewPermissionService(database, h.permChecker),
		user: user, textID: textID, oldID: oldID, client: c, send: send,
	}
}

func (f *viewParityFixture) channel(t *testing.T, id int64) *db.Channel {
	t.Helper()
	ch, err := f.database.GetChannel(context.Background(), id)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel(%d): %v", id, err)
	}
	return ch
}

// eachBranch runs fn once with the bare hub and once with the cached
// PermissionService wired, labelling the branch.
func (f *viewParityFixture) eachBranch(fn func(branch string)) {
	f.h.perms = nil
	fn("bare")
	f.h.perms = f.permSvc
	fn("service")
}

// TestApplySetChannelID_Parity: the post-Subscribe revalidation keeps the
// subscription exactly when CanAdmitSession allows it — for every override
// layer, and for an archived channel.
func TestApplySetChannelID_Parity(t *testing.T) {
	f := newViewParityFixture(t)
	for _, chID := range []int64{f.textID, f.oldID} {
		ch := f.channel(t, chID)
		for _, c := range parityOverrideCases {
			setParityOverrides(t, f.database, f.permSvc, chID, harvestVoiceRoleID, f.user.ID, c)
			want := permissions.CanAdmitSession(paritySubject(t, f.database, f.user.ID, ch)) == nil
			f.eachBranch(func(branch string) {
				f.h.applySetChannelID(f.client, 0) // a same-channel focus is a no-op; refocus from scratch
				f.h.applySetChannelID(f.client, chID)
				if got := f.h.SubscribedToChannelTopicForTest(f.client, chID); got != want {
					t.Errorf("chan=%d/%s/%s: subscribed = %v, CanAdmitSession = %v", chID, c.name, branch, got, want)
				}
			})
		}
	}
}

// TestChannelReadAudience_Parity: a connected user is in a channel's read
// audience exactly when CanViewChannel allows it.
func TestChannelReadAudience_Parity(t *testing.T) {
	f := newViewParityFixture(t)
	ctx := context.Background()
	for _, chID := range []int64{f.textID, f.oldID} {
		ch := f.channel(t, chID)
		for _, c := range parityOverrideCases {
			setParityOverrides(t, f.database, f.permSvc, chID, harvestVoiceRoleID, f.user.ID, c)
			want := permissions.CanViewChannel(paritySubject(t, f.database, f.user.ID, ch)) == nil
			f.eachBranch(func(branch string) {
				got := false
				for _, uid := range f.h.channelReadAudience(ctx, chID) {
					if uid == f.user.ID {
						got = true
					}
				}
				if got != want {
					t.Errorf("chan=%d/%s/%s: in audience = %v, CanViewChannel = %v", chID, c.name, branch, got, want)
				}
			})
		}
	}
}

// voiceParityFixture adds to the view fixture a voice channel, an archived
// voice channel, and a DM with a second user (optionally blocking).
type voiceParityFixture struct {
	*viewParityFixture
	voiceID, oldVoiceID, dmID int64
	other                     int64
}

func newVoiceParityFixture(t *testing.T) *voiceParityFixture {
	t.Helper()
	f := newViewParityFixture(t)
	ctx := context.Background()
	voiceID := mustCreateVoiceChannel(t, f.database, "voice-parity")
	oldVoiceID := mustCreateVoiceChannel(t, f.database, "voice-parity-old")
	if _, err := f.database.ExecContext(ctx, `UPDATE channels SET archived = 1 WHERE id = ?`, oldVoiceID); err != nil {
		t.Fatalf("archive: %v", err)
	}
	other := seedHarvestVoiceUser(t, f.database, "voice-parity-other")
	res, err := f.database.ExecContext(ctx, `INSERT INTO channels (name, type, position) VALUES ('dm-parity', 'dm', 0)`)
	if err != nil {
		t.Fatalf("insert dm: %v", err)
	}
	dmID, _ := res.LastInsertId()
	for _, uid := range []int64{f.user.ID, other} {
		if _, err := f.database.ExecContext(ctx, `INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)`, dmID, uid); err != nil {
			t.Fatalf("insert dm participant: %v", err)
		}
	}
	return &voiceParityFixture{viewParityFixture: f, voiceID: voiceID, oldVoiceID: oldVoiceID, dmID: dmID, other: other}
}

// setBlocked makes other block the fixture user (or clears the block).
func (f *voiceParityFixture) setBlocked(t *testing.T, blocked bool) {
	t.Helper()
	ctx := context.Background()
	if _, err := f.database.ExecContext(ctx, `DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?`, f.other, f.user.ID); err != nil {
		t.Fatalf("clear block: %v", err)
	}
	if blocked {
		if _, err := f.database.ExecContext(ctx, `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)`, f.other, f.user.ID); err != nil {
			t.Fatalf("insert block: %v", err)
		}
	}
}

// joinWant is the independent CanJoinVoice verdict for the fixture user on
// ch: Checker-resolved bits plus DM state read straight from the tables.
func (f *voiceParityFixture) joinWant(t *testing.T, ch *db.Channel, blocked bool) error {
	t.Helper()
	sub := paritySubject(t, f.database, f.user.ID, ch)
	if ch.Type == "dm" {
		sub.DMParticipant = true
		sub.DMBlocked = blocked
	}
	return permissions.CanJoinVoice(sub)
}

// TestChannelSubject_Parity: the shared resolver every voice site feeds the
// predicates agrees with an independent resolution in both branches,
// including DM membership and block state.
func TestChannelSubject_Parity(t *testing.T) {
	f := newVoiceParityFixture(t)
	ctx := context.Background()
	for _, chID := range []int64{f.voiceID, f.oldVoiceID, f.dmID} {
		ch := f.channel(t, chID)
		for _, blocked := range []bool{false, true} {
			f.setBlocked(t, blocked)
			for _, c := range parityOverrideCases {
				setParityOverrides(t, f.database, f.permSvc, chID, harvestVoiceRoleID, f.user.ID, c)
				want := paritySubject(t, f.database, f.user.ID, ch)
				if ch.Type == "dm" {
					want.DMParticipant = true
					want.DMBlocked = blocked
				}
				f.eachBranch(func(branch string) {
					got, err := channelSubject(ctx, f.database, f.h.permChecker, f.h.perms, f.user.ID, ch, true)
					if err != nil {
						t.Fatalf("chan=%d/%s/%s: channelSubject: %v", chID, c.name, branch, err)
					}
					if got != want {
						t.Errorf("chan=%d/blocked=%v/%s/%s: channelSubject = %+v, want %+v", chID, blocked, c.name, branch, got, want)
					}
				})
			}
		}
	}
}

// TestVoiceJoinPrecheck_Parity: the voice_join gate refuses exactly when
// CanJoinVoice refuses, with the frame joinDenial maps that reason to; when
// the predicate allows, the only refusal left is the fixture having no
// LiveKit (VOICE_ERROR), which proves the gate was passed.
func TestVoiceJoinPrecheck_Parity(t *testing.T) {
	f := newVoiceParityFixture(t)
	f.h.limiter = nil // the table would trip the per-user join limit
	ctx := context.Background()
	for _, chID := range []int64{f.voiceID, f.oldVoiceID, f.textID, f.dmID} {
		ch := f.channel(t, chID)
		for _, blocked := range []bool{false, true} {
			f.setBlocked(t, blocked)
			for _, c := range parityOverrideCases {
				setParityOverrides(t, f.database, f.permSvc, chID, harvestVoiceRoleID, f.user.ID, c)
				want := f.joinWant(t, ch, blocked)
				f.eachBranch(func(branch string) {
					for len(f.send) > 0 {
						<-f.send
					}
					_, _, ok := f.h.voiceJoinPrecheck(ctx, f.client, json.RawMessage(fmt.Sprintf(`{"channel_id":%d}`, chID)))
					if ok {
						t.Fatalf("chan=%d/%s/%s: precheck passed with no LiveKit configured", chID, c.name, branch)
					}
					var env struct {
						Payload struct {
							Code string `json:"code"`
						} `json:"payload"`
					}
					select {
					case raw := <-f.send:
						if err := json.Unmarshal(raw, &env); err != nil {
							t.Fatalf("unmarshal: %v", err)
						}
					case <-time.After(2 * time.Second):
						t.Fatalf("chan=%d/%s/%s: no error frame", chID, c.name, branch)
					}
					wantCode := ErrCodeVoiceError // allowed: refused only by the missing LiveKit
					if want != nil {
						wantCode = joinDenial(want).Code
					}
					if env.Payload.Code != wantCode {
						t.Errorf("chan=%d/blocked=%v/%s/%s: frame %s, CanJoinVoice says %v (want %s)", chID, blocked, c.name, branch, env.Payload.Code, want, wantCode)
					}
				})
			}
		}
	}
}

// TestVoiceStillAllowed_Parity: the sweep's re-check is CanJoinVoice over the
// live subject, so it evicts exactly what the join gate would now refuse.
func TestVoiceStillAllowed_Parity(t *testing.T) {
	f := newVoiceParityFixture(t)
	ctx := context.Background()
	for _, chID := range []int64{f.voiceID, f.oldVoiceID, f.dmID} {
		ch := f.channel(t, chID)
		for _, blocked := range []bool{false, true} {
			f.setBlocked(t, blocked)
			for _, c := range parityOverrideCases {
				setParityOverrides(t, f.database, f.permSvc, chID, harvestVoiceRoleID, f.user.ID, c)
				want := f.joinWant(t, ch, blocked) == nil
				got, err := f.h.voiceStillAllowed(ctx, f.user.ID, chID)
				if err != nil {
					t.Fatalf("chan=%d/%s: voiceStillAllowed: %v", chID, c.name, err)
				}
				if got != want {
					t.Errorf("chan=%d/blocked=%v/%s: voiceStillAllowed = %v, CanJoinVoice = %v", chID, blocked, c.name, got, want)
				}
			}
		}
	}
	if got, err := f.h.voiceStillAllowed(ctx, f.user.ID, 999999); err != nil || got {
		t.Errorf("deleted channel: allowed=%v err=%v, want a refusal with no error", got, err)
	}
}

// TestRefreshChannelVisibility_Parity: the fan-out sends channel_create
// exactly when CanViewChannel allows and channel_delete otherwise.
func TestRefreshChannelVisibility_Parity(t *testing.T) {
	f := newViewParityFixture(t)
	for _, chID := range []int64{f.textID, f.oldID} {
		ch := f.channel(t, chID)
		for _, c := range parityOverrideCases {
			setParityOverrides(t, f.database, f.permSvc, chID, harvestVoiceRoleID, f.user.ID, c)
			want := MsgTypeChannelDelete
			if permissions.CanViewChannel(paritySubject(t, f.database, f.user.ID, ch)) == nil {
				want = MsgTypeChannelCreate
			}
			f.eachBranch(func(branch string) {
				f.h.RefreshChannelVisibility(ch)
				var env struct {
					Type string `json:"type"`
				}
				select {
				case raw := <-f.send:
					if err := json.Unmarshal(raw, &env); err != nil {
						t.Fatalf("unmarshal: %v", err)
					}
				case <-time.After(2 * time.Second):
					t.Fatalf("chan=%d/%s/%s: no frame from RefreshChannelVisibility", chID, c.name, branch)
				}
				if env.Type != want {
					t.Errorf("chan=%d/%s/%s: got %s, CanViewChannel says %s", chID, c.name, branch, env.Type, want)
				}
			})
		}
	}
}
