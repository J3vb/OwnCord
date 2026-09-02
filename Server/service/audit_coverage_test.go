package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// TestAuditCoverage_ServiceMutations is the B2-6 audit table for the
// service-owned security-sensitive mutations: each row performs one mutation
// against a fake db.AuditStore and asserts the expected action arrives. The
// closing subtest runs the detail denylist over everything the rows recorded
// (plan docs/plans/b2-protocol-trust-compat-2026-08-28.md § B2-6).
func TestAuditCoverage_ServiceMutations(t *testing.T) {
	rows := []struct {
		name   string
		action string
		// run seeds its fixture, installs the recorder, performs the mutation
		// and returns the recorder plus every secret value the fixture used.
		run func(t *testing.T) (*audittest.Recorder, []string)
	}{
		{"invite create", "invite_create", func(t *testing.T) (*audittest.Recorder, []string) {
			_, database := newTestModerationService(t)
			rec := audittest.Install(t, database)
			inv, err := NewInviteService(database).CreateInvite(context.Background(), 1, 5, 24)
			if err != nil {
				t.Fatalf("CreateInvite: %v", err)
			}
			return rec, []string{inv.Code}
		}},
		{"invite revoke", "invite_revoke", func(t *testing.T) (*audittest.Recorder, []string) {
			_, database := newTestModerationService(t)
			svc := NewInviteService(database)
			inv, err := svc.CreateInvite(context.Background(), 1, 5, 24)
			if err != nil {
				t.Fatalf("CreateInvite: %v", err)
			}
			rec := audittest.Install(t, database)
			if err := svc.RevokeInvite(context.Background(), 1, inv.Code); err != nil {
				t.Fatalf("RevokeInvite: %v", err)
			}
			return rec, []string{inv.Code}
		}},
		{"ban", "user_ban", func(t *testing.T) (*audittest.Recorder, []string) {
			svc, database := newTestModerationService(t)
			rec := audittest.Install(t, database)
			if err := svc.BanUser(context.Background(), 1, 4, "spam", nil); err != nil {
				t.Fatalf("BanUser: %v", err)
			}
			return rec, nil
		}},
		{"unban", "user_unban", func(t *testing.T) (*audittest.Recorder, []string) {
			svc, database := newTestModerationService(t)
			if err := svc.BanUser(context.Background(), 1, 4, "spam", nil); err != nil {
				t.Fatalf("BanUser: %v", err)
			}
			rec := audittest.Install(t, database)
			if err := svc.UnbanUser(context.Background(), 1, 4); err != nil {
				t.Fatalf("UnbanUser: %v", err)
			}
			return rec, nil
		}},
		{"kick (force logout)", "force_logout", func(t *testing.T) (*audittest.Recorder, []string) {
			svc, database := newTestModerationService(t)
			rec := audittest.Install(t, database)
			if err := svc.ForceLogout(context.Background(), 1, 4); err != nil {
				t.Fatalf("ForceLogout: %v", err)
			}
			return rec, nil
		}},
		{"role assignment", "role_change", func(t *testing.T) (*audittest.Recorder, []string) {
			svc, database := newTestRoleService(t)
			rec := audittest.Install(t, database)
			if _, err := svc.ChangeUserRole(context.Background(), 1, 4, 3); err != nil {
				t.Fatalf("ChangeUserRole: %v", err)
			}
			return rec, nil
		}},
		{"password change", "password_change", func(t *testing.T) (*audittest.Recorder, []string) {
			_, database := newTestModerationService(t)
			hash, _ := auth.HashPassword("NewPassw0rd!")
			rec := audittest.Install(t, database)
			if _, err := NewUserService(database).ChangePassword(context.Background(), 4, hash, 0); err != nil {
				t.Fatalf("ChangePassword: %v", err)
			}
			return rec, []string{"NewPassw0rd!", hash}
		}},
		{"session revoke", "session_revoke", func(t *testing.T) (*audittest.Recorder, []string) {
			_, database := newTestModerationService(t)
			raw, _ := auth.GenerateToken()
			hash := auth.HashToken(raw)
			sid, err := database.CreateSession(context.Background(), 4, hash, "test", "127.0.0.1")
			if err != nil {
				t.Fatalf("CreateSession: %v", err)
			}
			rec := audittest.Install(t, database)
			if err := NewUserService(database).RevokeSession(context.Background(), 4, sid); err != nil {
				t.Fatalf("RevokeSession: %v", err)
			}
			return rec, []string{raw, hash}
		}},
		{"recovery credential issued", "recovery_assist_issued", func(t *testing.T) (*audittest.Recorder, []string) {
			svc, owner, user, database := newAssistFixture(t, false)
			rec := audittest.Install(t, database)
			issue, err := svc.IssueRecoveryAssist(context.Background(), owner.ID, user.ID, "in_person")
			if err != nil {
				t.Fatalf("IssueRecoveryAssist: %v", err)
			}
			stored, _ := database.GetRecoveryAssist(context.Background(), user.ID)
			return rec, []string{issue.Credential, stored.Verifier}
		}},
		{"recovery kit issued", "recovery_kit_issued", func(t *testing.T) (*audittest.Recorder, []string) {
			svc, user, _ := newKitService(t, false)
			rec := audittest.Install(t, svc.st.(*db.DB))
			issue, err := svc.EnrolRecoveryKit(context.Background(), Principal{User: user}, kitPassword, "")
			if err != nil {
				t.Fatalf("EnrolRecoveryKit: %v", err)
			}
			kit, _ := svc.st.GetRecoveryKit(context.Background(), user.ID)
			return rec, []string{issue.Secret, kit.Verifier, kitPassword}
		}},
		{"recovery kit locked", "recovery_kit_locked", func(t *testing.T) (*audittest.Recorder, []string) {
			svc, user, _ := newKitService(t, false)
			issue, err := svc.EnrolRecoveryKit(context.Background(), Principal{User: user}, kitPassword, "")
			if err != nil {
				t.Fatalf("EnrolRecoveryKit: %v", err)
			}
			rec := audittest.Install(t, svc.st.(*db.DB))
			wrong, _, _ := auth.GenerateRecoveryKitSecret()
			for i := range recoveryKitFailureThreshold {
				_, _ = recoverWith(svc, "kitholder", wrong, fmt.Sprintf("203.0.113.%d", 70+i))
			}
			return rec, []string{issue.Secret, wrong, kitPassword}
		}},
		{"registration approve", "registration_approve", func(t *testing.T) (*audittest.Recorder, []string) {
			_, database := newTestModerationService(t)
			uid, err := database.CreatePendingUser(context.Background(), "applicant-a", "hash", 4, 100)
			if err != nil {
				t.Fatalf("CreatePendingUser: %v", err)
			}
			rec := audittest.Install(t, database)
			if err := NewUserService(database).ApproveRegistration(context.Background(), 1, uid); err != nil {
				t.Fatalf("ApproveRegistration: %v", err)
			}
			return rec, []string{"hash"}
		}},
		{"registration deny", "registration_deny", func(t *testing.T) (*audittest.Recorder, []string) {
			_, database := newTestModerationService(t)
			uid, err := database.CreatePendingUser(context.Background(), "applicant-d", "hash", 4, 100)
			if err != nil {
				t.Fatalf("CreatePendingUser: %v", err)
			}
			rec := audittest.Install(t, database)
			if err := NewUserService(database).DenyRegistration(context.Background(), 1, uid); err != nil {
				t.Fatalf("DenyRegistration: %v", err)
			}
			return rec, []string{"hash"}
		}},
		{"session revoke all", "session_revoke_all", func(t *testing.T) (*audittest.Recorder, []string) {
			_, database := newTestModerationService(t)
			raw, _ := auth.GenerateToken()
			hash := auth.HashToken(raw)
			if _, err := database.CreateSession(context.Background(), 4, hash, "test", "127.0.0.1"); err != nil {
				t.Fatalf("CreateSession: %v", err)
			}
			rec := audittest.Install(t, database)
			if _, err := NewUserService(database).RevokeAllSessions(context.Background(), 4); err != nil {
				t.Fatalf("RevokeAllSessions: %v", err)
			}
			return rec, []string{raw, hash}
		}},
		{"message delete", "message_delete", func(t *testing.T) (*audittest.Recorder, []string) {
			svc, database := newTestMessageService(t)
			const body = "secret message body 4d0d1405"
			res, err := svc.SendMessage(context.Background(), SendMessageParams{ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: body})
			if err != nil {
				t.Fatalf("SendMessage: %v", err)
			}
			rec := audittest.Install(t, database)
			if _, err := svc.DeleteMessage(context.Background(), 1, res.MessageID); err != nil {
				t.Fatalf("DeleteMessage: %v", err)
			}
			return rec, []string{body}
		}},
		{"message purge", "message_purge", func(t *testing.T) (*audittest.Recorder, []string) {
			svc, database := newTestMessageService(t)
			seedRole(t, database, &db.Role{ID: permissions.MemberRoleID, Name: "member",
				Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.ManageMessages, Position: 1})
			const body = "purged message body 4d0d1405"
			if _, err := svc.SendMessage(context.Background(), SendMessageParams{ChannelID: 10, UserID: 1, Username: "alice", RoleName: "member", Content: body}); err != nil {
				t.Fatalf("SendMessage: %v", err)
			}
			rec := audittest.Install(t, database)
			if _, err := svc.PurgeMessages(context.Background(), 1, 10, 10, 0); err != nil {
				t.Fatalf("PurgeMessages: %v", err)
			}
			return rec, []string{body}
		}},
	}

	var corpus []db.AuditEntry
	var secrets []string
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			rec, s := row.run(t)
			rec.Wait(t, row.action)
			corpus = append(corpus, rec.Entries()...)
			secrets = append(secrets, s...)
		})
	}
	t.Run("detail denylist", func(t *testing.T) {
		if len(corpus) == 0 {
			t.Fatal("no audit entries recorded")
		}
		audittest.AssertSafeDetails(t, corpus, secrets...)
	})
}

// TestAuditCoverage_InviteRevokeFailureEmitsNothing pins S-02's failure half:
// a revoke that finds no invite is NotFound and writes no audit row.
func TestAuditCoverage_InviteRevokeFailureEmitsNothing(t *testing.T) {
	_, database := newTestModerationService(t)
	rec := audittest.Install(t, database)
	err := NewInviteService(database).RevokeInvite(context.Background(), 1, "no-such-code")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("RevokeInvite unknown code: want ErrNotFound, got %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	if got := rec.Entries(); len(got) != 0 {
		t.Fatalf("failed revoke must not audit; got %v", got)
	}
}

// cancelAfterCreateStore cancels the request context the moment the insert
// has committed, modelling a client that drops the connection mid-request.
type cancelAfterCreateStore struct {
	*db.DB
	cancel context.CancelFunc
}

func (s *cancelAfterCreateStore) CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresAt *time.Time) (string, error) {
	code, err := s.DB.CreateInvite(ctx, createdBy, maxUses, expiresAt)
	s.cancel()
	return code, err
}

// TestCreateInvite_AuditSurvivesCanceledLookup pins Codex's P2 on #1441: once
// the invite row is committed, a canceled request context must neither turn
// the creation into an error nor skip its audit row.
func TestCreateInvite_AuditSurvivesCanceledLookup(t *testing.T) {
	_, database := newTestModerationService(t)
	rec := audittest.Install(t, database)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inv, err := NewInviteService(&cancelAfterCreateStore{DB: database, cancel: cancel}).CreateInvite(ctx, 1, 5, 24)
	if err != nil {
		t.Fatalf("committed invite must not fail on a canceled lookup: %v", err)
	}
	if e := rec.Wait(t, "invite_create"); e.TargetID != inv.ID {
		t.Fatalf("invite_create target = %d, want %d", e.TargetID, inv.ID)
	}
}
