package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// WP 6.8c: the recipient's "Allow DMs" setting applies to every 1:1 sink
// through RequireDMReachable. Fixture: alice (1) and bob (2) share the 1:1 DM
// 50 and neither trusts the other (newDMFixture).

func setAllowDMs(t *testing.T, database *db.DB, userID int64, allow bool) {
	t.Helper()
	if err := database.SetUserPrivacy(context.Background(), userID, db.UserPrivacy{AllowMemberDMs: allow, MessageRequests: true}); err != nil {
		t.Fatalf("SetUserPrivacy(%d, %v): %v", userID, allow, err)
	}
}

// TestDMPrivacy_UntrustedSendRefused_NoRowsWritten: with DMs off, an untrusted
// sender's send is refused in the precheck, so no message, no request and no
// trust row exists and the caller gets no result to fan out.
func TestDMPrivacy_UntrustedSendRefused_NoRowsWritten(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	setAllowDMs(t, database, 2, false)

	result, err := svc.Messages.SendMessage(context.Background(), SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	})
	if !errors.Is(err, ErrBlocked) {
		t.Fatalf("SendMessage = %v, want ErrBlocked", err)
	}
	if result != nil {
		t.Errorf("SendMessage returned a result %+v with its refusal; nothing may be fanned out", result)
	}
	for _, table := range []string{"messages", "message_requests", "trusted_senders"} {
		if n := countRows(t, database, `SELECT COUNT(*) FROM `+table); n != 0 {
			t.Errorf("%s rows = %d, want 0", table, n)
		}
	}
}

// TestDMPrivacy_TrustedSourcesStillReach: every trust source keeps a pair
// reachable when the recipient has DMs off.
func TestDMPrivacy_TrustedSourcesStillReach(t *testing.T) {
	for _, source := range []string{"accepted", "sent_first", "grandfathered"} {
		t.Run(source, func(t *testing.T) {
			database, svc := newMessageRequestFixture(t)
			ctx := context.Background()
			setAllowDMs(t, database, 2, false)
			if err := database.TrustSender(ctx, 2, 1, source); err != nil {
				t.Fatalf("TrustSender: %v", err)
			}

			result, err := svc.Messages.SendMessage(ctx, SendMessageParams{
				ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
			})
			if err != nil {
				t.Fatalf("SendMessage from a %s sender: %v", source, err)
			}
			if len(result.RequestCreatedFor) != 0 {
				t.Errorf("RequestCreatedFor = %v, want none for a trusted sender", result.RequestCreatedFor)
			}
			if n := countRows(t, database, `SELECT COUNT(*) FROM messages WHERE channel_id = 50`); n != 1 {
				t.Errorf("messages rows = %d, want 1", n)
			}
			if _, err := svc.DMs.CreateDM(ctx, 1, 2); err != nil {
				t.Errorf("CreateDM to a recipient with DMs off that trusts the caller (%s): %v", source, err)
			}
		})
	}
}

// dmSinkErrors runs every service-level 1:1 sink as alice (1) toward bob (2)
// and returns each outcome by sink name. alice's message is seeded first so
// edit, react and pin have a target.
func dmSinkErrors(t *testing.T, database *db.DB, svc *Services) map[string]error {
	t.Helper()
	ctx := context.Background()
	msgID, err := database.CreateMessage(ctx, 50, 1, "hello", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	out := map[string]error{}
	_, out["send"] = svc.Messages.SendMessage(ctx, SendMessageParams{ChannelID: 50, UserID: 1, Username: "alice", Content: "again"})
	_, out["edit"] = svc.Messages.EditMessage(ctx, 1, msgID, "edited")
	_, out["react"] = svc.Messages.AddReaction(ctx, 1, msgID, "👍")
	_, out["pin"] = svc.Messages.SetMessagePinned(ctx, 1, 50, msgID, true)
	_, out["ring"] = svc.DMs.RingTargets(ctx, 1, 50)
	_, out["create"] = svc.DMs.CreateDM(ctx, 1, 2)
	return out
}

// TestDMPrivacy_EditReactPinRingVoiceRefused: one table over every DMBlocked
// sink this package owns (voice join and token refresh are covered in ws).
func TestDMPrivacy_EditReactPinRingVoiceRefused(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	setAllowDMs(t, database, 2, false)

	for sink, err := range dmSinkErrors(t, database, svc) {
		if sink == "create" {
			if !errors.Is(err, ErrForbidden) {
				t.Errorf("%s = %v, want ErrForbidden", sink, err)
			}
			continue
		}
		if !errors.Is(err, ErrBlocked) {
			t.Errorf("%s = %v, want ErrBlocked", sink, err)
		}
	}
}

// TestDMPrivacy_RefusalMatchesBlock: for each sink the refusal under "DMs off"
// is the same kind and the same text as under "blocked by the recipient" and
// "the sender blocked the recipient".
func TestDMPrivacy_RefusalMatchesBlock(t *testing.T) {
	scenarios := []struct {
		name  string
		setup func(t *testing.T, database *db.DB)
	}{
		{"privacy_off", func(t *testing.T, d *db.DB) { setAllowDMs(t, d, 2, false) }},
		{"blocked_by_recipient", func(t *testing.T, d *db.DB) {
			if err := d.BlockUser(context.Background(), 2, 1); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}
		}},
		{"sender_blocked_recipient", func(t *testing.T, d *db.DB) {
			if err := d.BlockUser(context.Background(), 1, 2); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}
		}},
	}
	results := make([]map[string]error, len(scenarios))
	for i, sc := range scenarios {
		database, svc := newMessageRequestFixture(t)
		sc.setup(t, database)
		results[i] = dmSinkErrors(t, database, svc)
	}
	for sink, base := range results[0] {
		if base == nil {
			t.Fatalf("%s was not refused under privacy_off", sink)
		}
		for i := 1; i < len(scenarios); i++ {
			other := results[i][sink]
			if other == nil {
				t.Fatalf("%s was not refused under %s", sink, scenarios[i].name)
			}
			if base.Error() != other.Error() {
				t.Errorf("%s: %s = %q, privacy_off = %q; want identical", sink, scenarios[i].name, other.Error(), base.Error())
			}
			if errors.Is(base, ErrBlocked) != errors.Is(other, ErrBlocked) || errors.Is(base, ErrForbidden) != errors.Is(other, ErrForbidden) {
				t.Errorf("%s: %s error kind differs from privacy_off", sink, scenarios[i].name)
			}
		}
	}
}

// TestDMPrivacy_FlipDuringSendStagesRequest: the setting flips off after the
// send's precheck passed. That send is staged as a pending request and is not
// delivered; the next send is refused.
func TestDMPrivacy_FlipDuringSendStagesRequest(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()
	svc.Messages.afterFirstContactTrustCheck = func() { setAllowDMs(t, database, 2, false) }
	defer func() { svc.Messages.afterFirstContactTrustCheck = nil }()

	result, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "first",
	})
	if err != nil {
		t.Fatalf("in-flight SendMessage: %v", err)
	}
	if len(result.RequestCreatedFor) != 1 {
		t.Fatalf("RequestCreatedFor = %v, want one staged request", result.RequestCreatedFor)
	}
	for _, pid := range result.ParticipantIDs {
		if pid == 2 {
			t.Error("the in-flight send was delivered to a recipient who had turned DMs off")
		}
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM message_requests WHERE state = 'pending'`); n != 1 {
		t.Errorf("pending message_requests = %d, want 1", n)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM dm_open_state WHERE user_id = 2 AND channel_id = 50`); n != 0 {
		t.Errorf("the recipient's DM was opened (%d rows)", n)
	}

	svc.Messages.afterFirstContactTrustCheck = nil
	// alice now holds a sent_first row for bob, but bob holds none for alice.
	if _, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "second",
	}); !errors.Is(err, ErrBlocked) {
		t.Fatalf("next SendMessage = %v, want ErrBlocked", err)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM messages WHERE channel_id = 50`); n != 1 {
		t.Errorf("messages rows = %d, want 1 (only the in-flight send)", n)
	}
}

// TestDMPrivacy_AcceptByOpenWhenSenderOff: the recipient of an undecided
// request opens the DM while the original sender has DMs off. The sender
// initiated, so trusts the recipient (sent_first) and the open is allowed.
func TestDMPrivacy_AcceptByOpenWhenSenderOff(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()

	result, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hello bob",
	})
	if err != nil || len(result.RequestCreatedFor) != 1 {
		t.Fatalf("first send: result = %+v, err = %v; want one staged request", result, err)
	}
	setAllowDMs(t, database, 1, false)

	opened, err := svc.DMs.CreateDM(ctx, 2, 1)
	if err != nil {
		t.Fatalf("CreateDM by the recipient while the sender has DMs off: %v", err)
	}
	if opened.AcceptedRequest == nil {
		t.Error("opening the DM did not accept the undecided request")
	}
	if _, err := svc.Messages.SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 2, Username: "bob", Content: "hi alice",
	}); err != nil {
		t.Errorf("reply from the accepting recipient: %v", err)
	}
}

// TestDMPrivacy_GroupDMUnaffected: an existing group keeps working for a
// member who has DMs off, in both directions.
func TestDMPrivacy_GroupDMUnaffected(t *testing.T) {
	database, svc := newMessageRequestFixture(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 3, Username: "carol"})
	seedUserRole(t, database, 3, 4)

	group, err := svc.DMs.CreateGroupDM(ctx, 1, []int64{2, 3}, "")
	if err != nil {
		t.Fatalf("CreateGroupDM: %v", err)
	}
	setAllowDMs(t, database, 2, false)
	setAllowDMs(t, database, 3, false)

	for _, sender := range []struct {
		id   int64
		name string
	}{{1, "alice"}, {2, "bob"}} {
		if _, err := svc.Messages.SendMessage(ctx, SendMessageParams{
			ChannelID: group.Channel.ID, UserID: sender.id, Username: sender.name, Content: "in the group",
		}); err != nil {
			t.Errorf("group send by %s: %v", sender.name, err)
		}
	}
	if err := RequireDMReachable(ctx, database, 1, group.Channel.ID); err != nil {
		t.Errorf("RequireDMReachable on a group = %v, want nil", err)
	}
}

// privacyReadErrStore fails only the privacy read.
type privacyReadErrStore struct{ Store }

func (privacyReadErrStore) DMRefusesSender(context.Context, int64, int64) (bool, error) {
	return false, errors.New("privacy read failed")
}

// TestDMPrivacy_ReadErrorFailsClosed: a failed privacy read refuses as
// ErrInternal, never ErrBlocked, so it cannot read as a refusal by the other
// party.
func TestDMPrivacy_ReadErrorFailsClosed(t *testing.T) {
	database, permSvc := newDMFixture(t)
	st := privacyReadErrStore{Store: database}
	ctx := context.Background()

	err := RequireDMReachable(ctx, st, 1, 50)
	if !errors.Is(err, ErrInternal) || errors.Is(err, ErrBlocked) {
		t.Errorf("RequireDMReachable = %v, want ErrInternal and not ErrBlocked", err)
	}
	_, err = NewMessageService(st, permSvc, nil).SendMessage(ctx, SendMessageParams{
		ChannelID: 50, UserID: 1, Username: "alice", Content: "hi",
	})
	if !errors.Is(err, ErrInternal) || errors.Is(err, ErrBlocked) {
		t.Errorf("SendMessage = %v, want ErrInternal and not ErrBlocked", err)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM messages`); n != 0 {
		t.Errorf("messages rows = %d, want 0", n)
	}
	_, err = NewDMService(st, permSvc).CreateDM(ctx, 1, 2)
	if !errors.Is(err, ErrInternal) || errors.Is(err, ErrBlocked) || errors.Is(err, ErrForbidden) {
		t.Errorf("CreateDM = %v, want ErrInternal only", err)
	}
}
