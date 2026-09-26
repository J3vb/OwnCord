package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// RI-06: the explanation and the preview answer from the canonical
// predicates over live state, and the preview writes nothing.

const (
	explainAlice = int64(201)
	explainBob   = int64(202)
	explainOwner = int64(203)
	explainRole  = int64(31)
)

func seedExplainFixture(t *testing.T) (*ChannelService, *db.DB, *db.Channel) {
	t.Helper()
	database := newTestDB(t)
	svc := NewChannelService(database, NewPermissionService(database, permissions.NewChecker(database)))
	seedRole(t, database, &db.Role{ID: explainRole, Name: "explain-member", Position: 10,
		Permissions: permissions.ReadMessages | permissions.SendMessages | permissions.AddReactions | permissions.ConnectVoice})
	seedUserRole(t, database, explainAlice, explainRole)
	seedUserRole(t, database, explainBob, explainRole)
	seedUserRole(t, database, explainOwner, permissions.OwnerRoleID)
	seedChannel(t, database, &db.Channel{ID: 80, Name: "general", Type: "text"})
	ch, err := svc.ResolveGuildChannel(context.Background(), 80)
	if err != nil {
		t.Fatalf("ResolveGuildChannel: %v", err)
	}
	return svc, database, ch
}

// ownerRole is the actor for most rows: an Administrator outranks everyone.
var ownerRole = &db.Role{ID: permissions.OwnerRoleID, Permissions: permissions.Administrator, Position: 100}

func explain(t *testing.T, svc *ChannelService, ch *db.Channel, userID int64, a permissions.Action) (AccessExplanation, permissions.Decision) {
	t.Helper()
	res, err := svc.ExplainAccess(context.Background(), explainOwner, ownerRole, userID, ch, string(a))
	if err != nil {
		t.Fatalf("ExplainAccess: %v", err)
	}
	if len(res.Decisions) != 1 || res.Decisions[0].Action != a {
		t.Fatalf("decisions = %+v, want the one %s", res.Decisions, a)
	}
	return res, res.Decisions[0]
}

func TestExplainAccess_AllowedWithBaseRoleTrace(t *testing.T) {
	svc, _, ch := seedExplainFixture(t)
	res, send := explain(t, svc, ch, explainAlice, permissions.ActionSendMessage)
	if !send.Allowed || send.Reason != "" {
		t.Fatalf("send = %+v, want allowed", send)
	}
	if len(send.Bits) != 2 || !send.Bits[0].Base || !send.Bits[0].Effective {
		t.Fatalf("send bits = %+v, want READ and SEND held by the base role", send.Bits)
	}
	if res.RoleName != "explain-member" || res.Username == "" {
		t.Fatalf("identity = %+v", res)
	}
	// A text channel has no voice room: the predicate's own reason, not a bit.
	if _, jv := explain(t, svc, ch, explainAlice, permissions.ActionJoinVoice); jv.Allowed || jv.Reason != permissions.ErrNotVoiceChannel.Error() {
		t.Fatalf("join_voice = %+v", jv)
	}
}

func TestExplainAccess_RoleDenyAndUserAllowLayers(t *testing.T) {
	svc, database, ch := seedExplainFixture(t)
	ctx := context.Background()
	if err := database.UpsertChannelOverride(ctx, ch.ID, explainRole, 0, permissions.SendMessages); err != nil {
		t.Fatal(err)
	}
	_, send := explain(t, svc, ch, explainAlice, permissions.ActionSendMessage)
	if send.Allowed || !strings.Contains(send.Reason, "SEND_MESSAGES") {
		t.Fatalf("role deny: send = %+v", send)
	}
	if send.Bits[0].Bit != "SEND_MESSAGES" || send.Bits[0].RoleOverride != "deny" || send.Bits[0].Effective {
		t.Fatalf("role deny trace = %+v", send.Bits)
	}

	seedChannelUserOverride(t, database, explainAlice, ch.ID, permissions.SendMessages, 0)
	_, send = explain(t, svc, ch, explainAlice, permissions.ActionSendMessage)
	if !send.Allowed || send.Bits[0].UserOverride != "allow" {
		t.Fatalf("user allow over role deny: send = %+v", send)
	}
}

func TestExplainAccess_NonRoleRestrictions(t *testing.T) {
	svc, database, ch := seedExplainFixture(t)
	ctx := context.Background()

	if _, _, err := database.TimeoutUser(ctx, explainAlice, explainOwner, nil, "cool off", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	res, send := explain(t, svc, ch, explainAlice, permissions.ActionSendMessage)
	if !res.Restrictions.TimedOut {
		t.Fatal("restrictions do not report the timeout")
	}
	if send.Allowed || send.Reason != permissions.ErrTimedOut.Error() {
		t.Fatalf("timed out send = %+v", send)
	}
	if _, view := explain(t, svc, ch, explainAlice, permissions.ActionViewChannel); !view.Allowed {
		t.Fatalf("a timeout must not hide the channel: %+v", view)
	}

	if err := database.BanUser(ctx, explainBob, "spam", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	for _, a := range permissions.Actions {
		res, d := explain(t, svc, ch, explainBob, a)
		if !res.Restrictions.Banned {
			t.Fatal("restrictions do not report the ban")
		}
		if d.Allowed || d.Reason != "account is banned" {
			t.Fatalf("banned member %s = %+v", a, d)
		}
	}

	if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, ch.ID); err != nil {
		t.Fatal(err)
	}
	nsfw, err := svc.ResolveGuildChannel(ctx, ch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, rc := explain(t, svc, nsfw, explainOwner, permissions.ActionReadContent); rc.Allowed || rc.Reason != permissions.ErrNSFWUnacknowledged.Error() || !rc.AdministratorBypass {
		t.Fatalf("unacknowledged NSFW for the owner = %+v (consent has no admin bypass)", rc)
	}
	if _, err := database.AcknowledgeNSFW(ctx, explainOwner, ch.ID); err != nil {
		t.Fatal(err)
	}
	if res, rc := explain(t, svc, nsfw, explainOwner, permissions.ActionReadContent); !rc.Allowed || !res.Restrictions.NSFWAcknowledged {
		t.Fatalf("acknowledged NSFW = %+v / %+v", rc, res.Restrictions)
	}
}

func TestExplainAccess_ActionFilterErrorsAndAudit(t *testing.T) {
	svc, database, ch := seedExplainFixture(t)
	ctx := context.Background()
	rec := audittest.Install(t, database)
	res, err := svc.ExplainAccess(ctx, explainOwner, ownerRole, explainAlice, ch, "add_reaction")
	if err != nil || len(res.Decisions) != 1 || res.Decisions[0].Action != permissions.ActionAddReaction {
		t.Fatalf("filtered = %+v, %v", res.Decisions, err)
	}
	if e := rec.Wait(t, "permission_explain"); e.ActorID != explainOwner || e.TargetID != explainAlice {
		t.Fatalf("audit = %+v", e)
	}
	for _, a := range []string{"fly", ""} {
		if _, err := svc.ExplainAccess(ctx, explainOwner, ownerRole, explainAlice, ch, a); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("action %q err = %v, want ErrBadRequest", a, err)
		}
	}
	if _, err := svc.ExplainAccess(ctx, explainOwner, ownerRole, 9999, ch, "add_reaction"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown user err = %v, want ErrNotFound", err)
	}
}

func TestPreviewOverride_RoleLayerListsOnlyChangedMembers(t *testing.T) {
	svc, database, ch := seedExplainFixture(t)
	ctx := context.Background()
	// Bob keeps READ through his own allow, so hiding the channel from the
	// role changes Alice's access and not his.
	seedChannelUserOverride(t, database, explainBob, ch.ID, permissions.ReadMessages, 0)
	rec := audittest.Install(t, database)

	res, err := svc.PreviewOverride(ctx, explainOwner, ownerRole, ch, explainRole, 0, 0, permissions.ReadMessages)
	if err != nil {
		t.Fatalf("PreviewOverride: %v", err)
	}
	if res.Evaluated != 2 || len(res.Members) != 1 || res.Members[0].UserID != explainAlice {
		t.Fatalf("preview = %+v, want only Alice changed of 2", res)
	}
	got := map[permissions.Action]bool{}
	for _, c := range res.Members[0].Changes {
		if !c.Before || c.After || c.AfterReason == "" {
			t.Fatalf("change = %+v, want allowed -> denied with a reason", c)
		}
		got[c.Action] = true
	}
	for _, a := range []permissions.Action{permissions.ActionViewChannel, permissions.ActionReadContent, permissions.ActionSendMessage, permissions.ActionAddReaction} {
		if !got[a] {
			t.Errorf("missing change for %s in %+v", a, res.Members[0].Changes)
		}
	}
	if allow, deny, err := database.GetChannelPermissions(ctx, ch.ID, explainRole); err != nil || allow != 0 || deny != 0 {
		t.Fatalf("preview persisted an override: (%#x,%#x) %v", allow, deny, err)
	}
	if e := rec.Wait(t, "permission_preview"); e.TargetID != ch.ID || !strings.Contains(e.Detail, "1 of 2") {
		t.Fatalf("audit = %+v", e)
	}
}

func TestPreviewOverride_UserLayerAndValidation(t *testing.T) {
	svc, database, ch := seedExplainFixture(t)
	ctx := context.Background()
	if err := database.UpsertChannelOverride(ctx, ch.ID, explainRole, 0, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	// Garbage bits are clamped like the save path clamps them.
	res, err := svc.PreviewOverride(ctx, explainOwner, ownerRole, ch, 0, explainBob, permissions.ReadMessages|1<<62, 0)
	if err != nil {
		t.Fatalf("PreviewOverride: %v", err)
	}
	if res.Allow != permissions.ReadMessages || res.Evaluated != 1 || len(res.Members) != 1 || res.Members[0].UserID != explainBob {
		t.Fatalf("user preview = %+v", res)
	}
	if c := res.Members[0].Changes[0]; c.Before || !c.After {
		t.Fatalf("change = %+v, want denied -> allowed", c)
	}
	// A proposal identical to the current state changes nobody.
	res, err = svc.PreviewOverride(ctx, explainOwner, ownerRole, ch, explainRole, 0, 0, permissions.ReadMessages)
	if err != nil || len(res.Members) != 0 || res.Evaluated != 2 {
		t.Fatalf("no-op preview = %+v, %v", res, err)
	}

	for _, c := range []struct {
		name           string
		roleID, userID int64
		want           error
	}{
		{"neither", 0, 0, ErrBadRequest},
		{"both", explainRole, explainBob, ErrBadRequest},
		{"unknown role", 9999, 0, ErrNotFound},
		{"unknown user", 0, 9999, ErrNotFound},
	} {
		if _, err := svc.PreviewOverride(ctx, explainOwner, ownerRole, ch, c.roleID, c.userID, 0, 0); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
}

func TestExplainAccess_AdministratorHasNoBitTrace(t *testing.T) {
	svc, database, ch := seedExplainFixture(t)
	if err := database.UpsertChannelOverride(context.Background(), ch.ID, permissions.OwnerRoleID, 0, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	// The override is never consulted for an Administrator, so no trace
	// claims the layer has no opinion.
	if _, d := explain(t, svc, ch, explainOwner, permissions.ActionViewChannel); !d.Allowed || !d.AdministratorBypass || d.Bits != nil {
		t.Fatalf("admin view = %+v, want allowed with no bit trace", d)
	}
}

// Explain and the preview disclose members' restriction state, so they
// follow the override editor's rank rules.
func TestExplainAndUserPreview_RefuseTargetsRankedAtOrAbove(t *testing.T) {
	svc, database, ch := seedExplainFixture(t)
	ctx := context.Background()
	mod := &db.Role{ID: 32, Name: "explain-mod", Position: 50, Permissions: permissions.ManageChannels | permissions.ReadMessages}
	seedRole(t, database, mod)
	const peer = int64(204)
	seedUserRole(t, database, peer, mod.ID)

	if _, err := svc.ExplainAccess(ctx, peer, mod, explainAlice, ch, "view_channel"); err != nil {
		t.Fatalf("explain lower-ranked member: %v", err)
	}
	if _, err := svc.PreviewOverride(ctx, peer, mod, ch, 0, explainAlice, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("preview lower-ranked member: %v", err)
	}
	if _, err := svc.PreviewOverride(ctx, peer, mod, ch, explainRole, 0, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("role-layer preview: %v", err)
	}
	for _, target := range []int64{explainOwner, peer} {
		if _, err := svc.ExplainAccess(ctx, peer, mod, target, ch, "view_channel"); !errors.Is(err, ErrForbidden) {
			t.Errorf("explain user %d err = %v, want ErrForbidden", target, err)
		}
		if _, err := svc.PreviewOverride(ctx, peer, mod, ch, 0, target, 0, 0); !errors.Is(err, ErrForbidden) {
			t.Errorf("preview user %d err = %v, want ErrForbidden", target, err)
		}
	}
	for _, role := range []int64{mod.ID, permissions.OwnerRoleID} {
		if _, err := svc.PreviewOverride(ctx, peer, mod, ch, role, 0, 0, permissions.ReadMessages); !errors.Is(err, ErrForbidden) {
			t.Errorf("preview role %d err = %v, want ErrForbidden", role, err)
		}
	}
}
