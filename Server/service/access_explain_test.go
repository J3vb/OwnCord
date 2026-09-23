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

func decisionFor(t *testing.T, ds []permissions.Decision, a permissions.Action) permissions.Decision {
	t.Helper()
	for _, d := range ds {
		if d.Action == a {
			return d
		}
	}
	t.Fatalf("no decision for %s in %+v", a, ds)
	return permissions.Decision{}
}

func explain(t *testing.T, svc *ChannelService, ch *db.Channel, userID int64) AccessExplanation {
	t.Helper()
	res, err := svc.ExplainAccess(context.Background(), explainOwner, userID, ch, "")
	if err != nil {
		t.Fatalf("ExplainAccess: %v", err)
	}
	if len(res.Decisions) != len(permissions.Actions) {
		t.Fatalf("decisions = %d, want one per action", len(res.Decisions))
	}
	return res
}

func TestExplainAccess_AllowedWithBaseRoleTrace(t *testing.T) {
	svc, _, ch := seedExplainFixture(t)
	res := explain(t, svc, ch, explainAlice)
	send := decisionFor(t, res.Decisions, permissions.ActionSendMessage)
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
	if jv := decisionFor(t, res.Decisions, permissions.ActionJoinVoice); jv.Allowed || jv.Reason != permissions.ErrNotVoiceChannel.Error() {
		t.Fatalf("join_voice = %+v", jv)
	}
}

func TestExplainAccess_RoleDenyAndUserAllowLayers(t *testing.T) {
	svc, database, ch := seedExplainFixture(t)
	ctx := context.Background()
	if err := database.UpsertChannelOverride(ctx, ch.ID, explainRole, 0, permissions.SendMessages); err != nil {
		t.Fatal(err)
	}
	send := decisionFor(t, explain(t, svc, ch, explainAlice).Decisions, permissions.ActionSendMessage)
	if send.Allowed || !strings.Contains(send.Reason, "SEND_MESSAGES") {
		t.Fatalf("role deny: send = %+v", send)
	}
	if send.Bits[0].Bit != "SEND_MESSAGES" || send.Bits[0].RoleOverride != "deny" || send.Bits[0].Effective {
		t.Fatalf("role deny trace = %+v", send.Bits)
	}

	seedChannelUserOverride(t, database, explainAlice, ch.ID, permissions.SendMessages, 0)
	send = decisionFor(t, explain(t, svc, ch, explainAlice).Decisions, permissions.ActionSendMessage)
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
	res := explain(t, svc, ch, explainAlice)
	if !res.Restrictions.TimedOut {
		t.Fatal("restrictions do not report the timeout")
	}
	if send := decisionFor(t, res.Decisions, permissions.ActionSendMessage); send.Allowed || send.Reason != permissions.ErrTimedOut.Error() {
		t.Fatalf("timed out send = %+v", send)
	}
	if view := decisionFor(t, res.Decisions, permissions.ActionViewChannel); !view.Allowed {
		t.Fatalf("a timeout must not hide the channel: %+v", view)
	}

	if err := database.BanUser(ctx, explainBob, "spam", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	res = explain(t, svc, ch, explainBob)
	if !res.Restrictions.Banned {
		t.Fatal("restrictions do not report the ban")
	}
	for _, d := range res.Decisions {
		if d.Allowed || d.Reason != "account is banned" {
			t.Fatalf("banned member %s = %+v", d.Action, d)
		}
	}

	if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, ch.ID); err != nil {
		t.Fatal(err)
	}
	nsfw, err := svc.ResolveGuildChannel(ctx, ch.ID)
	if err != nil {
		t.Fatal(err)
	}
	res = explain(t, svc, nsfw, explainOwner)
	if rc := decisionFor(t, res.Decisions, permissions.ActionReadContent); rc.Allowed || rc.Reason != permissions.ErrNSFWUnacknowledged.Error() || !rc.AdministratorBypass {
		t.Fatalf("unacknowledged NSFW for the owner = %+v (consent has no admin bypass)", rc)
	}
	if _, err := database.AcknowledgeNSFW(ctx, explainOwner, ch.ID); err != nil {
		t.Fatal(err)
	}
	res = explain(t, svc, nsfw, explainOwner)
	if rc := decisionFor(t, res.Decisions, permissions.ActionReadContent); !rc.Allowed || !res.Restrictions.NSFWAcknowledged {
		t.Fatalf("acknowledged NSFW = %+v / %+v", rc, res.Restrictions)
	}
}

func TestExplainAccess_ActionFilterErrorsAndAudit(t *testing.T) {
	svc, database, ch := seedExplainFixture(t)
	ctx := context.Background()
	rec := audittest.Install(t, database)
	res, err := svc.ExplainAccess(ctx, explainOwner, explainAlice, ch, "add_reaction")
	if err != nil || len(res.Decisions) != 1 || res.Decisions[0].Action != permissions.ActionAddReaction {
		t.Fatalf("filtered = %+v, %v", res.Decisions, err)
	}
	if e := rec.Wait(t, "permission_explain"); e.ActorID != explainOwner || e.TargetID != explainAlice {
		t.Fatalf("audit = %+v", e)
	}
	if _, err := svc.ExplainAccess(ctx, explainOwner, explainAlice, ch, "fly"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("unknown action err = %v, want ErrBadRequest", err)
	}
	if _, err := svc.ExplainAccess(ctx, explainOwner, 9999, ch, ""); !errors.Is(err, ErrNotFound) {
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

	res, err := svc.PreviewOverride(ctx, explainOwner, ch, explainRole, 0, 0, permissions.ReadMessages)
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
	res, err := svc.PreviewOverride(ctx, explainOwner, ch, 0, explainBob, permissions.ReadMessages|1<<62, 0)
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
	res, err = svc.PreviewOverride(ctx, explainOwner, ch, explainRole, 0, 0, permissions.ReadMessages)
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
		if _, err := svc.PreviewOverride(ctx, explainOwner, ch, c.roleID, c.userID, 0, 0); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
}
