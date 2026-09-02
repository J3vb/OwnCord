package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

func newRegistrationService(t *testing.T, mode RegistrationMode) *AuthService {
	t.Helper()
	database := newTestDB(t)
	if err := database.SetSetting(context.Background(), registrationModeKey, string(mode)); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	return NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
}

func registerFrom(svc *AuthService, username, ip string) error {
	_, err := svc.Register(context.Background(), RegisterInput{
		Username: username, Password: "securePass1", Device: "test", IP: ip,
	})
	return err
}

// Per-mode abuse limits (owner decision 1): the invite-free modes budget
// registrations per address; invite mode spends invites instead.
func TestRegister_InviteFreeModesAreBudgetedPerAddress(t *testing.T) {
	svc := newRegistrationService(t, RegistrationOpen)
	for i := range inviteFreeRegistrationsPerIPPerDay {
		if err := registerFrom(svc, fmt.Sprintf("open%d", i), "203.0.113.7"); err != nil {
			t.Fatalf("registration %d: %v", i, err)
		}
	}
	err := registerFrom(svc, "open-extra", "203.0.113.7")
	if !errors.Is(err, ErrRateLimited) || !strings.Contains(err.Error(), "too many registrations from this address") {
		t.Fatalf("over-budget registration: err = %v, want the per-address refusal", err)
	}
	if err := registerFrom(svc, "elsewhere", "203.0.113.8"); err != nil {
		t.Fatalf("another address: %v", err)
	}

	// The same address is not budgeted in invite mode: the invite is.
	if err := svc.st.SetSetting(context.Background(), registrationModeKey, string(RegistrationInvite)); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	owner, err := svc.st.CreateUser(context.Background(), "owner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	code, err := svc.st.CreateInvite(context.Background(), owner, 1, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if _, err := svc.Register(context.Background(), RegisterInput{
		Username: "invited", Password: "securePass1", InviteCode: code, Device: "test", IP: "203.0.113.7",
	}); err != nil {
		t.Fatalf("invite-mode registration from the budgeted address: %v", err)
	}
}

func TestRegister_ApprovalQueueIsCapped(t *testing.T) {
	svc := newRegistrationService(t, RegistrationApproval)
	for i := range maxPendingRegistrations {
		if _, err := svc.st.CreatePendingUser(context.Background(), fmt.Sprintf("queued%d", i), "hash", 4, 100); err != nil {
			t.Fatalf("CreatePendingUser %d: %v", i, err)
		}
	}
	err := registerFrom(svc, "one-too-many", "203.0.113.9")
	if !errors.Is(err, ErrRateLimited) || !strings.Contains(err.Error(), "registration queue is full") {
		t.Fatalf("err = %v, want the queue-full refusal", err)
	}
	if u, _ := svc.st.GetUserByUsername(context.Background(), "one-too-many"); u != nil {
		t.Fatal("an application was recorded past the cap")
	}
}

func TestRegister_InviteModeRefusesAnEmptyCodeBeforeHashing(t *testing.T) {
	svc := newRegistrationService(t, RegistrationInvite)
	err := registerFrom(svc, "codeless", "203.0.113.10")
	if !errors.Is(err, ErrBadRequest) || !strings.Contains(err.Error(), "invalid invite or credentials") {
		t.Fatalf("err = %v, want the uniform invite refusal", err)
	}
	if u, _ := svc.st.GetUserByUsername(context.Background(), "codeless"); u != nil {
		t.Fatal("an account was created without an invite in invite mode")
	}
}
