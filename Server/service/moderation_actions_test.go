package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// moderationActionsFixture is the B5-9 matrix's hierarchy: owner (1, pos
// 100, Administrator) > mod (2, pos 80, MODERATE_MEMBERS|BAN_MEMBERS|
// KICK_MEMBERS|MUTE_MEMBERS) = peermod (5, pos 80, same) > member (3, pos
// 40) = member2 (4, pos 40). ModerationService and MessageService share one
// PermissionService and one *db.DB, and moderation.messages is wired
// (service.New's own shape) so ActOnReport's removal branch works.
type moderationActionsFixture struct {
	mod      *ModerationService
	messages *MessageService
	database *db.DB
}

const (
	fixtureOwner   = int64(1)
	fixtureMod     = int64(2)
	fixtureMember  = int64(3)
	fixtureMember2 = int64(4)
	fixturePeerMod = int64(5)
	fixtureChannel = int64(100)
)

// newModerationActionsFixture builds the shared fixture below. Its seed
// calls (seedRole/seedUser/seedUserRole, seed_test.go) always use
// context.Background() internally, the same package-wide pattern every
// other service test fixture already follows.
//
//nolint:contextcheck // see above
func newModerationActionsFixture(t *testing.T) *moderationActionsFixture {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: 1, Name: "owner", Permissions: permissions.Administrator, Position: 100})
	seedRole(t, database, &db.Role{ID: 2, Name: "mod",
		Permissions: permissions.ModerateMembers | permissions.BanMembers | permissions.KickMembers | permissions.MuteMembers |
			permissions.ManageMessages | permissions.ReadMessages,
		Position: 80})
	seedRole(t, database, &db.Role{ID: 3, Name: "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AddReactions | permissions.ConnectVoice,
		Position:    40})
	for userID, roleID := range map[int64]int64{
		fixtureOwner: 1, fixtureMod: 2, fixturePeerMod: 2, fixtureMember: 3, fixtureMember2: 3,
	} {
		seedUser(t, database, &db.User{ID: userID, Username: fmt.Sprintf("u%d", userID), Status: "offline"})
		seedUserRole(t, database, userID, roleID)
	}
	seedChannel(t, database, &db.Channel{ID: fixtureChannel, Name: "general", Type: "text"})

	checker := permissions.NewChecker(database)
	perms := NewPermissionService(database, checker)
	mod := NewModerationService(database, perms)
	messages := NewMessageService(database, perms, nil)
	mod.messages = messages
	return &moderationActionsFixture{mod: mod, messages: messages, database: database}
}

// ── The matrix (scorecard Q5) ───────────────────────────────────────────────

// TestModeration_Self: every action on oneself is refused.
func TestModeration_Self(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	if _, err := f.mod.Warn(ctx, fixtureMod, fixtureMod, "self", nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("self warn: want ErrBadRequest, got %v", err)
	}
	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMod, "self", time.Hour, nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("self timeout: want ErrBadRequest, got %v", err)
	}
	if err := f.mod.ForceLogout(ctx, fixtureMod, fixtureMod); !errors.Is(err, ErrBadRequest) {
		t.Errorf("self kick: want ErrBadRequest, got %v", err)
	}
	if err := f.mod.BanUser(ctx, fixtureMod, fixtureMod, "self", nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("self ban: want ErrBadRequest, got %v", err)
	}
}

// TestModeration_Peer: a peer of equal role position is refused by
// requireOutranks, before existence would matter.
func TestModeration_Peer(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	if _, err := f.mod.Warn(ctx, fixtureMod, fixturePeerMod, "peer", nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("peer warn: want ErrForbidden, got %v", err)
	}
	if _, err := f.mod.Timeout(ctx, fixtureMod, fixturePeerMod, "peer", time.Hour, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("peer timeout: want ErrForbidden, got %v", err)
	}
	if err := f.mod.ForceLogout(ctx, fixtureMod, fixturePeerMod); !errors.Is(err, ErrForbidden) {
		t.Errorf("peer kick: want ErrForbidden, got %v", err)
	}
	if err := f.mod.BanUser(ctx, fixtureMod, fixturePeerMod, "peer", nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("peer ban: want ErrForbidden, got %v", err)
	}
}

// TestModeration_Superior: a member has no MODERATE_MEMBERS at all, and even
// holding it would not reach past a higher-ranked target.
func TestModeration_Superior(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	if _, err := f.mod.Warn(ctx, fixtureMember, fixtureMod, "up", nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("member warning a mod: want ErrForbidden, got %v", err)
	}
	if _, err := f.mod.Timeout(ctx, fixtureMember, fixtureMod, "up", time.Hour, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("member timing out a mod: want ErrForbidden, got %v", err)
	}
}

// TestModeration_OwnerTarget: the owner outranks everyone, so every kind
// refuses the owner as target even from a moderator with the right bit.
func TestModeration_OwnerTarget(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	if _, err := f.mod.Warn(ctx, fixtureMod, fixtureOwner, "coup", nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("warn owner: want ErrForbidden, got %v", err)
	}
	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureOwner, "coup", time.Hour, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("timeout owner: want ErrForbidden, got %v", err)
	}
	if err := f.mod.ForceLogout(ctx, fixtureMod, fixtureOwner); !errors.Is(err, ErrForbidden) {
		t.Errorf("kick owner: want ErrForbidden, got %v", err)
	}
	if err := f.mod.BanUser(ctx, fixtureMod, fixtureOwner, "coup", nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("ban owner: want ErrForbidden, got %v", err)
	}
}

// TestModeration_ConcurrentRoleChange is the property test: the rank
// comparison and the write run against the SAME live read (recordModeration
// Action re-reads role position inside the transaction that also performs
// the insert), so whichever role state actually holds at write time governs
// — not whatever a caller read earlier. The writer pool is a single
// connection (db.DB.writer.SetMaxOpenConns(1)), so a real second writer
// cannot interleave mid-statement; driving both orderings sequentially
// exercises the exact guarantee that gives. Db's
// TestBanUserWithAction_ConcurrentRoleChangeCannotPreemptAnInFlightDecision
// (P2-12, Codex review) is the complementary proof with a REAL second
// goroutine forced to contend for that one connection via a barrier inside
// the transaction, rather than two sequential calls in this one.
func TestModeration_ConcurrentRoleChange(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	// Ordering 1: the target is promoted to the actor's own rank BEFORE the
	// write reaches the database (modelling a role change that lands between
	// ModerationService's own — cached — hierarchy check and the write).
	seedUserRole(t, f.database, fixtureMember, 2) // promote member to "mod" (pos 80)
	if _, err := f.database.TimeoutUser(ctx, fixtureMember, fixtureMod, nil, "promoted mid-flight", time.Now().Add(time.Hour)); !errors.Is(err, db.ErrOutranked) {
		t.Fatalf("promoted target: want db.ErrOutranked, got %v", err)
	}
	rows, err := f.database.ListModerationActionsForTarget(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("a refused write left %d ledger row(s) — refused must mean nothing landed", len(rows))
	}

	// Ordering 2: the reciprocal — demoted back below the actor's rank, the
	// identical call now succeeds, proving the refusal above tracked LIVE
	// state rather than being a permanent block on this pair.
	seedUserRole(t, f.database, fixtureMember, 3) // back to "member" (pos 40)
	if _, err := f.database.TimeoutUser(ctx, fixtureMember, fixtureMod, nil, "not promoted", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser after demotion: %v", err)
	}
}

// TestModeration_ReasonBounded: the ledger's reason is bounded to 500 runes
// and rejects control characters — the audit denylist never sees the reason
// at all (Warn/Timeout write a fixed phrase), so the bound is proved on the
// stored ledger value directly.
func TestModeration_ReasonBounded(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	tooLong := make([]byte, reasonMaxRunes+1)
	for i := range tooLong {
		tooLong[i] = 'a'
	}
	if _, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, string(tooLong), nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("over-long reason: want ErrBadRequest, got %v", err)
	}
	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, string(tooLong), time.Hour, nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("over-long timeout reason: want ErrBadRequest, got %v", err)
	}
	if _, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "control\x00char", nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("control character: want ErrBadRequest, got %v", err)
	}

	// At the bound, exactly, succeeds and is stored verbatim.
	atBound := make([]byte, reasonMaxRunes)
	for i := range atBound {
		atBound[i] = 'b'
	}
	id, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, string(atBound), nil)
	if err != nil {
		t.Fatalf("at-bound reason: %v", err)
	}
	rows, err := f.database.ListModerationActionsForTarget(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.ID == id {
			found = true
			if r.Reason != string(atBound) {
				t.Errorf("stored reason length = %d, want %d", len(r.Reason), len(atBound))
			}
		}
	}
	if !found {
		t.Fatal("warning row not found after a successful Warn")
	}
}

// TestModeration_AuditDetailsSafe proves the audit rows for every action
// pass the denylist — in particular that a reason shaped like a secret never
// reaches audit_log, because Warn/Timeout write a fixed phrase there and
// never the reason text itself.
func TestModeration_AuditDetailsSafe(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	const secretReason = "password: hunter2, token abcdefghijklmnopqrstuvwxyz0123456789ABCD"

	rec := audittest.Install(t, f.database)

	if _, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, secretReason, nil); err != nil {
		t.Fatalf("Warn: %v", err)
	}
	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember2, secretReason, time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if err := f.mod.ForceLogout(ctx, fixtureMod, fixtureMember); err != nil {
		t.Fatalf("ForceLogout: %v", err)
	}
	if err := f.mod.BanUser(ctx, fixtureMod, fixtureMember2, secretReason, nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	rec.Wait(t, "user_warn")
	audittest.AssertSafeDetails(t, rec.Entries(), secretReason, "hunter2")
}

// ── Every action writes a ledger row, in the same transaction as its effect ─

// TestModeration_EveryActionWritesALedgerRow injects a failure in
// recordModerationAction/recordLedgerRow AFTER the effect's own write (an
// actor id of 0 — the absence-proof guard every kind carries) and shows the
// effect rolls back too, for all five kinds: the ledger row is never
// optional, and neither the effect nor the row lands alone.
func TestModeration_EveryActionWritesALedgerRow(t *testing.T) {
	ctx := context.Background()

	t.Run("warning", func(t *testing.T) {
		f := newModerationActionsFixture(t)
		if _, err := f.database.WarnUser(ctx, fixtureMember, 0, nil, "x"); !errors.Is(err, db.ErrOutranked) {
			t.Fatalf("want db.ErrOutranked, got %v", err)
		}
		rows, _ := f.database.ListModerationActionsForTarget(ctx, fixtureMember)
		if len(rows) != 0 {
			t.Fatalf("ledger rows = %d, want 0", len(rows))
		}
	})

	t.Run("timeout", func(t *testing.T) {
		f := newModerationActionsFixture(t)
		if _, err := f.database.TimeoutUser(ctx, fixtureMember, 0, nil, "x", time.Now().Add(time.Hour)); !errors.Is(err, db.ErrOutranked) {
			t.Fatalf("want db.ErrOutranked, got %v", err)
		}
		active, err := f.database.HasActiveTimeout(ctx, fixtureMember)
		if err != nil {
			t.Fatalf("HasActiveTimeout: %v", err)
		}
		if active {
			t.Fatal("a refused timeout write left an active timeout — the effect did not roll back")
		}
	})

	t.Run("ban", func(t *testing.T) {
		f := newModerationActionsFixture(t)
		if _, err := f.database.BanUserWithAction(ctx, fixtureMember, "x", nil, 0, nil); !errors.Is(err, db.ErrOutranked) {
			t.Fatalf("want db.ErrOutranked, got %v", err)
		}
		target, err := f.database.GetUserByID(ctx, fixtureMember)
		if err != nil {
			t.Fatalf("GetUserByID: %v", err)
		}
		if target.Banned {
			t.Fatal("a refused ledger write left the target banned — the effect did not roll back")
		}
	})

	t.Run("kick", func(t *testing.T) {
		f := newModerationActionsFixture(t)
		if _, err := f.database.CreateSession(ctx, fixtureMember, "moderation-atomicity-test", "test", "127.0.0.1"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		if _, err := f.database.ForceLogoutWithAction(ctx, fixtureMember, 0, nil, ""); !errors.Is(err, db.ErrOutranked) {
			t.Fatalf("want db.ErrOutranked, got %v", err)
		}
		sessions, err := f.database.GetUserSessions(ctx, fixtureMember)
		if err != nil {
			t.Fatalf("GetUserSessions: %v", err)
		}
		if len(sessions) != 1 {
			t.Fatalf("sessions after a refused kick = %d, want 1 (the effect did not roll back)", len(sessions))
		}
	})

	t.Run("removal", func(t *testing.T) {
		f := newModerationActionsFixture(t)
		msgID, err := f.database.CreateMessage(ctx, fixtureChannel, fixtureMember2, "hello", nil)
		if err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		if err := f.database.DeleteMessageWithRemoval(ctx, msgID, 0, true, fixtureMember2, nil, ""); !errors.Is(err, db.ErrOutranked) {
			t.Fatalf("want db.ErrOutranked, got %v", err)
		}
		msg, err := f.database.GetMessage(ctx, msgID)
		if err != nil {
			t.Fatalf("GetMessage: %v", err)
		}
		if msg.Deleted {
			t.Fatal("a refused ledger write left the message deleted — the effect did not roll back")
		}
	})
}

// ── The report-linked entry point ───────────────────────────────────────────

// TestModeration_ReportLinkedActionCarriesTheReportID drives ActOnReport
// across all five kinds and confirms each ledger row carries the report id
// it was linked to.
func TestModeration_ReportLinkedActionCarriesTheReportID(t *testing.T) {
	ctx := context.Background()

	cases := []struct {
		kind   string
		target int64
	}{
		{"warning", fixtureMember},
		{"timeout", fixtureMember},
		{"kick", fixtureMember},
		{"ban", fixtureMember},
	}
	for i, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			f := newModerationActionsFixture(t)
			reportID := int64(900 + i)
			result, err := f.mod.ActOnReport(ctx, ActOnReportParams{
				ActorID: fixtureMod, Kind: tc.kind, Reason: "linked", DurationSeconds: 3600,
				TargetID: tc.target, ReportID: reportID,
			})
			if err != nil {
				t.Fatalf("ActOnReport(%s): %v", tc.kind, err)
			}
			if result.Kind != tc.kind || result.TargetID != tc.target {
				t.Fatalf("ActOnReport(%s) result = %+v, want Kind=%s TargetID=%d", tc.kind, result, tc.kind, tc.target)
			}
			if tc.kind == "timeout" && result.Voice == "" {
				t.Fatalf("ActOnReport(timeout) result.Voice = %q, want a non-empty voice outcome (P2-7)", result.Voice)
			}
			rows, err := f.database.ListModerationActionsForReport(ctx, reportID)
			if err != nil {
				t.Fatalf("ListModerationActionsForReport: %v", err)
			}
			if len(rows) != 1 {
				t.Fatalf("rows for report %d = %d, want 1", reportID, len(rows))
			}
			if rows[0].ReportID == nil || *rows[0].ReportID != reportID {
				t.Fatalf("row report_id = %v, want %d", rows[0].ReportID, reportID)
			}
		})
	}

	t.Run("removal", func(t *testing.T) {
		f := newModerationActionsFixture(t)
		msgID, err := f.database.CreateMessage(ctx, fixtureChannel, fixtureMember2, "reported content", nil)
		if err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		const reportID = int64(999)
		result, err := f.mod.ActOnReport(ctx, ActOnReportParams{
			ActorID: fixtureMod, Kind: "removal", Reason: "linked removal",
			MessageID: msgID, ReportID: reportID,
		})
		if err != nil {
			t.Fatalf("ActOnReport(removal): %v", err)
		}
		// P2-7: enough transport info for the caller to broadcast
		// chat_bulk_deleted exactly like the direct purge route does.
		if result.Kind != "removal" || result.MessageID != msgID || result.ChannelID != fixtureChannel {
			t.Fatalf("ActOnReport(removal) result = %+v, want MessageID=%d ChannelID=%d", result, msgID, fixtureChannel)
		}
		rows, err := f.database.ListModerationActionsForReport(ctx, reportID)
		if err != nil {
			t.Fatalf("ListModerationActionsForReport: %v", err)
		}
		if len(rows) != 1 || rows[0].Kind != "removal" || rows[0].Reason != "linked removal" {
			t.Fatalf("rows = %+v, want one removal row reasoned %q", rows, "linked removal")
		}
		if rows[0].ReportID == nil || *rows[0].ReportID != reportID {
			t.Fatalf("row report_id = %v, want %d", rows[0].ReportID, reportID)
		}
		msg, err := f.database.GetMessage(ctx, msgID)
		if err != nil {
			t.Fatalf("GetMessage: %v", err)
		}
		if !msg.Deleted {
			t.Fatal("the reported message was not deleted")
		}
	})
}

// ── Timeout ──────────────────────────────────────────────────────────────────

// TestTimeout_BitesOnNextSendWithoutReconnect proves the restriction is live
// on the very next send: PermissionService.Subject's TimedOut lookup is
// live and uncached, so no reconnect (which would just re-run the same
// lookup) is needed.
func TestTimeout_BitesOnNextSendWithoutReconnect(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	if _, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: fixtureChannel, UserID: fixtureMember, Username: "u3", RoleName: "member", Content: "before",
	}); err != nil {
		t.Fatalf("send before timeout: %v", err)
	}

	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}

	if _, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: fixtureChannel, UserID: fixtureMember, Username: "u3", RoleName: "member", Content: "after",
	}); !errors.Is(err, ErrTimedOut) {
		t.Fatalf("send after timeout: want ErrTimedOut, got %v", err)
	}
}

// TestTimeout_BlocksMessageEdit is P1-2 (Codex review): editMessageCheckAccess
// used to check only DM membership/block for a DM edit, never the timeout —
// so a timed-out user could still broadcast new text by editing an old
// message even though a fresh send was refused. Routing edits through
// CanSendMessage (which carries TimedOut) closes it in a guild channel
// exactly as on send; the DM path shares the identical channelSubject/
// CanSendMessage call, so nothing about this fix is guild-only.
func TestTimeout_BlocksMessageEdit(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	sent, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: fixtureChannel, UserID: fixtureMember, Username: "u3", RoleName: "member", Content: "before",
	})
	if err != nil {
		t.Fatalf("send before timeout: %v", err)
	}

	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}

	if _, err := f.messages.EditMessage(ctx, fixtureMember, sent.MessageID, "after"); !errors.Is(err, ErrTimedOut) {
		t.Fatalf("EditMessage after timeout: want ErrTimedOut, got %v", err)
	}
}

// timeoutLookupErrorStore wraps a real Store and injects a failure on
// HasActiveTimeout only, for P2-11's fail-closed proof — every other method
// promotes straight through to the embedded implementation.
type timeoutLookupErrorStore struct {
	Store
	err error
}

func (s *timeoutLookupErrorStore) HasActiveTimeout(ctx context.Context, userID int64) (bool, error) {
	return false, s.err
}

// TestChannelSubject_TimeoutLookupErrorFailsClosedForDM is P2-11 (Codex
// review): channelSubject used to swallow a HasActiveTimeout lookup failure
// (inside PermissionService.Subject) and build a zero Subject with
// TimedOut=false — permissive for a DM, whose CanSendMessage/CanAddReaction
// consult DMParticipant/DMBlocked/TimedOut rather than RolePerms, unlike a
// non-DM channel's zero-bit Subject, which happens to fail closed anyway. A
// DM send with an unknown timeout state must be refused (fail closed), not
// silently let through as "not timed out".
func TestChannelSubject_TimeoutLookupErrorFailsClosedForDM(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	ch, _, err := f.database.GetOrCreateDMChannel(ctx, fixtureMember, fixtureMember2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	injected := errors.New("timeout lookup boom")
	errStore := &timeoutLookupErrorStore{Store: f.database, err: injected}
	errPerms := NewPermissionService(errStore, permissions.NewChecker(errStore))
	errMessages := NewMessageService(errStore, errPerms, nil)

	if _, err := errMessages.SendMessage(ctx, SendMessageParams{
		ChannelID: ch.ID, UserID: fixtureMember, Username: "u3", RoleName: "member", Content: "hi",
	}); !errors.Is(err, ErrInternal) {
		t.Fatalf("DM send with a failed timeout lookup: want ErrInternal (fail closed), got %v", err)
	}
}

// TestTimeout_BlocksReactionsAndVoiceJoin: the same restriction applies to
// reactions (through CanAddReaction) and to voice (through CanJoinVoice) —
// both consult the identical live Subject.TimedOut a send does.
func TestTimeout_BlocksReactionsAndVoiceJoin(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	msgID, err := f.database.CreateMessage(ctx, fixtureChannel, fixtureMember2, "react to me", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}

	if _, err := f.messages.AddReaction(ctx, fixtureMember, msgID, "x"); !errors.Is(err, ErrTimedOut) {
		t.Fatalf("AddReaction: want ErrTimedOut, got %v", err)
	}

	sub, err := f.mod.perms.Subject(ctx, fixtureMember, fixtureChannel)
	if err != nil {
		t.Fatalf("Subject: %v", err)
	}
	sub.Channel = permissions.ChannelRef{ID: fixtureChannel, Type: "voice"}
	if err := permissions.CanJoinVoice(sub); !errors.Is(err, permissions.ErrTimedOut) {
		t.Fatalf("CanJoinVoice: want ErrTimedOut, got %v", err)
	}
}

// fakeVoiceMuter records ApplyTimeoutMute calls, satisfying
// service.TimeoutVoiceMuter. applied controls what each call reports back
// (defaults to true, i.e. every attempted mute actually lands); set false to
// model a channel-switch race or a target with no live SFU participant.
type fakeVoiceMuter struct {
	calls   []bool // one entry per call, the `muted` argument
	applied bool
}

func newFakeVoiceMuter() *fakeVoiceMuter { return &fakeVoiceMuter{applied: true} }

func (f *fakeVoiceMuter) ApplyTimeoutMute(_ context.Context, _ int64, muted bool) bool {
	f.calls = append(f.calls, muted)
	return f.applied
}

// TestTimeout_VoiceHalf_ChannelScopedAuthorization is P1-3 (Codex review):
// the voice half's eligibility is permissions.CanModerateVoice over the
// actor's Subject in the TARGET's CURRENT voice channel — channel-level
// MUTE_MEMBERS, not a bare server-wide bit — and it is skipped outright when
// the target is not in any voice channel at all, since there is then no
// channel to authorize against.
func TestTimeout_VoiceHalf_ChannelScopedAuthorization(t *testing.T) {
	ctx := context.Background()

	t.Run("actor authorized, target in voice: applied", func(t *testing.T) {
		f := newModerationActionsFixture(t)
		if err := f.database.JoinVoiceChannel(ctx, fixtureMember, fixtureChannel); err != nil {
			t.Fatalf("JoinVoiceChannel: %v", err)
		}
		muter := newFakeVoiceMuter()
		f.mod.SetVoiceMuter(muter)
		result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
		if err != nil {
			t.Fatalf("Timeout: %v", err)
		}
		if result.VoiceSkipped {
			t.Fatal("VoiceSkipped = true, want false: actor holds MUTE_MEMBERS in the target's channel and the mute was applied")
		}
		if len(muter.calls) != 1 || !muter.calls[0] {
			t.Fatalf("voice muter calls = %v, want exactly one mute(true)", muter.calls)
		}
	})

	t.Run("actor lacks channel-level MUTE_MEMBERS: skipped", func(t *testing.T) {
		f := newModerationActionsFixture(t)
		if err := f.database.JoinVoiceChannel(ctx, fixtureMember, fixtureChannel); err != nil {
			t.Fatalf("JoinVoiceChannel: %v", err)
		}
		// A channel-level deny strips MUTE_MEMBERS in THIS channel alone —
		// the actor's server-wide role bit is untouched, proving the check is
		// channel-scoped and not the old bare-bit shortcut.
		//nolint:contextcheck // seedChannelOverride always uses context.Background() internally, matching seedRole/seedUser
		seedChannelOverride(t, f.database, 2, fixtureChannel, 0, permissions.MuteMembers)
		muter := newFakeVoiceMuter()
		f.mod.SetVoiceMuter(muter)
		result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
		if err != nil {
			t.Fatalf("Timeout: %v", err)
		}
		if !result.VoiceSkipped {
			t.Fatal("VoiceSkipped = false, want true: a channel-level deny refuses CanModerateVoice here")
		}
		if len(muter.calls) != 0 {
			t.Fatalf("voice muter calls = %v, want none — a channel-denied moderator must not grant a mute", muter.calls)
		}
	})

	t.Run("target not in voice at all: skipped", func(t *testing.T) {
		f := newModerationActionsFixture(t)
		muter := newFakeVoiceMuter()
		f.mod.SetVoiceMuter(muter)
		result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
		if err != nil {
			t.Fatalf("Timeout: %v", err)
		}
		if !result.VoiceSkipped {
			t.Fatal("VoiceSkipped = false, want true: there is no voice channel to authorize against")
		}
		if len(muter.calls) != 0 {
			t.Fatalf("voice muter calls = %v, want none — nothing to mute", muter.calls)
		}
		// Text is still restricted regardless.
		if _, err := f.messages.SendMessage(ctx, SendMessageParams{
			ChannelID: fixtureChannel, UserID: fixtureMember, Username: "u3", RoleName: "member", Content: "after",
		}); !errors.Is(err, ErrTimedOut) {
			t.Fatalf("send after voice-skipped timeout: want ErrTimedOut, got %v", err)
		}
	})

	t.Run("authorized and in voice, but the SFU call did not land: skipped", func(t *testing.T) {
		f := newModerationActionsFixture(t)
		if err := f.database.JoinVoiceChannel(ctx, fixtureMember, fixtureChannel); err != nil {
			t.Fatalf("JoinVoiceChannel: %v", err)
		}
		muter := &fakeVoiceMuter{applied: false}
		f.mod.SetVoiceMuter(muter)
		result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
		if err != nil {
			t.Fatalf("Timeout: %v", err)
		}
		if !result.VoiceSkipped {
			t.Fatal("VoiceSkipped = false, want true: the muter reported it did not actually apply the mute (P3-14)")
		}
	})
}

// TestTimeout_ExpiryLiftsAutomatically: an expired timeout is simply not
// "active" any more — HasActiveTimeout's own WHERE clause (expires_at >
// datetime('now')) is what "lifts" it, with no separate sweep required for
// enforcement (only for the retention row's own cleanup, later).
func TestTimeout_ExpiryLiftsAutomatically(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	if _, err := f.database.TimeoutUser(ctx, fixtureMember, fixtureMod, nil, "already over", time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	active, err := f.database.HasActiveTimeout(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if active {
		t.Fatal("an expired timeout still reads as active")
	}
	if _, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: fixtureChannel, UserID: fixtureMember, Username: "u3", RoleName: "member", Content: "after expiry",
	}); err != nil {
		t.Fatalf("send after expiry: want success, got %v", err)
	}
}

// TestTimeout_LiftEarly: LiftTimeout ends an active timeout before its
// expiry, lifts the voice half (the target is in voice and the lifting
// actor separately passes CanModerateVoice there, P1-4), and the target can
// send again immediately.
func TestTimeout_LiftEarly(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	if err := f.database.JoinVoiceChannel(ctx, fixtureMember, fixtureChannel); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	muter := newFakeVoiceMuter()
	f.mod.SetVoiceMuter(muter)

	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if err := f.mod.LiftTimeout(ctx, fixtureMod, fixtureMember); err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if len(muter.calls) != 2 || muter.calls[0] != true || muter.calls[1] != false {
		t.Fatalf("voice muter calls = %v, want [true, false]", muter.calls)
	}
	active, err := f.database.HasActiveTimeout(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if active {
		t.Fatal("timeout still active after LiftTimeout")
	}
	if _, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: fixtureChannel, UserID: fixtureMember, Username: "u3", RoleName: "member", Content: "after lift",
	}); err != nil {
		t.Fatalf("send after lift: want success, got %v", err)
	}

	// Lifting again (nothing active) is NotFound, not a second success.
	if err := f.mod.LiftTimeout(ctx, fixtureMod, fixtureMember); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second lift: want ErrNotFound, got %v", err)
	}
}

// TestLiftTimeout_DoesNotClearAMuteItNeverApplied is P1-4's first branch: a
// timeout whose voice half was skipped (the target was never in voice) must
// not have LiftTimeout clear anything — there is no mute of this timeout's
// own to lift.
func TestLiftTimeout_DoesNotClearAMuteItNeverApplied(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	muter := newFakeVoiceMuter()
	f.mod.SetVoiceMuter(muter)

	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if len(muter.calls) != 0 {
		t.Fatalf("voice muter calls after Timeout = %v, want none (target not in voice)", muter.calls)
	}
	if err := f.mod.LiftTimeout(ctx, fixtureMod, fixtureMember); err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if len(muter.calls) != 0 {
		t.Fatalf("voice muter calls after LiftTimeout = %v, want none — this timeout never applied a mute", muter.calls)
	}
}

// TestLiftTimeout_DoesNotClearAnotherModeratorsAuthority is P1-4's second
// branch: the timeout DID apply the mute, but the actor calling LiftTimeout
// does not separately pass CanModerateVoice in the target's channel (a
// channel-level deny) — clearing the mute is refused to THIS actor, even
// though the timeout itself is lifted (text/reactions are freed either way).
func TestLiftTimeout_DoesNotClearAnotherModeratorsAuthority(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	if err := f.database.JoinVoiceChannel(ctx, fixtureMember, fixtureChannel); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	muter := newFakeVoiceMuter()
	f.mod.SetVoiceMuter(muter)

	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if len(muter.calls) != 1 || !muter.calls[0] {
		t.Fatalf("voice muter calls after Timeout = %v, want exactly one mute(true)", muter.calls)
	}

	// A channel-level deny on peermod's role now refuses CanModerateVoice
	// there, even though peermod still outranks the target server-wide.
	//nolint:contextcheck // seedChannelOverride always uses context.Background() internally, matching seedRole/seedUser
	seedChannelOverride(t, f.database, 2, fixtureChannel, 0, permissions.MuteMembers)

	if err := f.mod.LiftTimeout(ctx, fixturePeerMod, fixtureMember); err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if len(muter.calls) != 1 {
		t.Fatalf("voice muter calls after LiftTimeout = %v, want still just the original mute(true) — this lifter lacks CanModerateVoice here", muter.calls)
	}
	active, err := f.database.HasActiveTimeout(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if active {
		t.Fatal("the timeout itself must still be lifted regardless of the voice half")
	}
}

// ── Warning ──────────────────────────────────────────────────────────────────

// TestWarning_AckIsOwnRowsOnly: another user's ack attempt finds nothing to
// acknowledge; the target's own ack succeeds and cannot be repeated.
func TestWarning_AckIsOwnRowsOnly(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	id, err := f.mod.Warn(ctx, fixtureMod, fixtureMember, "be nice", nil)
	if err != nil {
		t.Fatalf("Warn: %v", err)
	}

	if err := f.mod.AcknowledgeWarning(ctx, fixtureMember2, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ack by another user: want ErrNotFound, got %v", err)
	}
	notices, err := f.database.ListUnacknowledgedWarnings(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("ListUnacknowledgedWarnings: %v", err)
	}
	if len(notices) != 1 {
		t.Fatalf("notices after a foreign ack attempt = %d, want 1 (unaffected)", len(notices))
	}

	if err := f.mod.AcknowledgeWarning(ctx, fixtureMember, id); err != nil {
		t.Fatalf("ack by the target: %v", err)
	}
	notices, err = f.database.ListUnacknowledgedWarnings(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("ListUnacknowledgedWarnings: %v", err)
	}
	if len(notices) != 0 {
		t.Fatalf("notices after acknowledgement = %d, want 0", len(notices))
	}

	// Repeating the ack finds nothing left to acknowledge.
	if err := f.mod.AcknowledgeWarning(ctx, fixtureMember, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second ack: want ErrNotFound, got %v", err)
	}
}
