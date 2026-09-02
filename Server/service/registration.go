package service

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// RegistrationMode is the registration_mode setting (B4-1, BPR-041): who may
// create an account, and how.
type RegistrationMode string

const (
	// RegistrationClosed refuses every registration.
	RegistrationClosed RegistrationMode = "closed"
	// RegistrationInvite admits an applicant who redeems a valid invite — the
	// fresh-install default, and what an upgraded server's former
	// registration_open = 1 maps to.
	RegistrationInvite RegistrationMode = "invite"
	// RegistrationApproval creates the account locked; an admin approves it in
	// the admin panel before it can sign in (owner decision 1).
	RegistrationApproval RegistrationMode = "approval"
	// RegistrationOpen admits anyone, no invite needed.
	RegistrationOpen RegistrationMode = "open"
)

// DefaultRegistrationMode is what a missing registration_mode row reads as.
const DefaultRegistrationMode = RegistrationInvite

const registrationModeKey = "registration_mode"

// ParseRegistrationMode reads a setting value; ok is false for anything but
// the four modes.
func ParseRegistrationMode(v string) (RegistrationMode, bool) {
	switch m := RegistrationMode(strings.ToLower(strings.TrimSpace(v))); m {
	case RegistrationClosed, RegistrationInvite, RegistrationApproval, RegistrationOpen:
		return m, true
	}
	return "", false
}

// registrationModeSetting reads the live mode. A missing row is the default;
// an unparseable value fails closed and is logged, since it can only come
// from a hand-edited database.
func registrationModeSetting(ctx context.Context, st Store) (RegistrationMode, error) {
	v, err := st.GetSetting(ctx, registrationModeKey)
	if errors.Is(err, db.ErrNotFound) {
		return DefaultRegistrationMode, nil
	}
	if err != nil {
		return "", err
	}
	mode, ok := ParseRegistrationMode(v)
	if !ok {
		slog.Error("registration_mode holds an unknown value; treating registration as closed", "value", v)
		return RegistrationClosed, nil
	}
	return mode, nil
}
