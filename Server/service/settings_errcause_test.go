package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// failCountTOTPStore fails the enrolment count that gates require_2fa, the way
// a locked or unreachable database would.
type failCountTOTPStore struct {
	*db.DB
	err error
}

func (f *failCountTOTPStore) CountUsersWithoutTOTP(context.Context) (int, error) {
	return 0, f.err
}

// A database fault while validating require_2fa is the server's, not the
// caller's: it must surface as ErrInternal (HTTP 500) with the cause still on
// the chain, never as the 400 an operator reads as "your request was wrong".
func TestSettings_Patch2FAEnrollmentCountFailureIsInternalWithCause(t *testing.T) {
	cause := errors.New("database is locked")
	svc := NewSettingsService(&failCountTOTPStore{DB: newTestDB(t), err: cause})

	_, err := svc.Patch(context.Background(), 1, map[string]string{
		"require_2fa":       "1",
		"registration_mode": "closed",
	})
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("err = %v, want ErrInternal", err)
	}
	if errors.Is(err, ErrBadRequest) {
		t.Fatalf("err = %v must not classify as ErrBadRequest", err)
	}
	if !errors.Is(err, cause) {
		t.Fatalf("err = %v, want the store error on the chain", err)
	}
}

// failGetSettingStore fails reads of one settings key.
type failGetSettingStore struct {
	*db.DB
	key string
	err error
}

func (f *failGetSettingStore) GetSetting(ctx context.Context, key string) (string, error) {
	if key == f.key {
		return "", f.err
	}
	return f.DB.GetSetting(ctx, key)
}

// Turning require_2fa on without naming a registration mode reads the live
// mode; a database fault there is the same server-side failure, not a 400
// whose body would carry the raw driver text.
func TestSettings_PatchRegistrationModeReadFailureIsInternalWithCause(t *testing.T) {
	cause := errors.New("database is locked")
	svc := NewSettingsService(&failGetSettingStore{DB: newTestDB(t), key: registrationModeKey, err: cause})

	_, err := svc.Patch(context.Background(), 1, map[string]string{"require_2fa": "1"})
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("err = %v, want ErrInternal", err)
	}
	if errors.Is(err, ErrBadRequest) {
		t.Fatalf("err = %v must not classify as ErrBadRequest", err)
	}
	if !errors.Is(err, cause) {
		t.Fatalf("err = %v, want the store error on the chain", err)
	}
}
