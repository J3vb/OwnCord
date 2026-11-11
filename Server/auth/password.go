package auth

import (
	"errors"
	"fmt"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const (
	minPassLen = 8
	maxPassLen = 72 // bcrypt silently truncates beyond 72 bytes
)

// bcryptCost is a var so SetCostForTesting can lower it; production never mutates it.
var bcryptCost = 12

// SetCostForTesting lowers the bcrypt cost and resets the dummy timing pad so
// it is regenerated at the new cost. Call it from TestMain.
func SetCostForTesting(cost int) {
	bcryptCost = cost
	dummyHashOnce = sync.Once{}
	dummyHash = nil
}

// ErrPasswordTooShort is returned when the password is below the minimum length.
var ErrPasswordTooShort = errors.New("password must be at least 8 characters")

// ErrPasswordTooLong is returned when the password exceeds bcrypt's 72-byte limit.
var ErrPasswordTooLong = errors.New("password must not exceed 72 characters")

// HashPassword returns a bcrypt hash of password using cost 12.
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// dummyHash is a lazily computed bcrypt hash so CheckPassword takes roughly
// constant time whether or not a user exists.
var (
	dummyHash     []byte
	dummyHashOnce sync.Once
)

// getDummyHash returns the dummy bcrypt hash, initialising it on first call.
func getDummyHash() []byte {
	dummyHashOnce.Do(func() {
		h, err := bcrypt.GenerateFromPassword([]byte("dummy-timing-pad"), bcryptCost)
		if err != nil {
			// crypto/rand is required for the server to function; no recovery path.
			panic("auth: failed to generate dummy bcrypt hash: " + err.Error())
		}
		dummyHash = h
	})
	return dummyHash
}

// CheckPassword reports whether password matches hash; any error, including an
// empty or malformed hash, is false. An empty hash (no such user) still runs a
// dummy comparison to prevent timing-based username enumeration.
func CheckPassword(hash, password string) bool {
	if hash == "" {
		// The error is discarded: this branch always returns false.
		_ = bcrypt.CompareHashAndPassword(getDummyHash(), []byte(password))
		return false
	}
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// ValidatePasswordStrength requires 8 to 72 bytes (bcrypt's limit).
func ValidatePasswordStrength(password string) error {
	if len(password) < minPassLen {
		return ErrPasswordTooShort
	}
	if len(password) > maxPassLen {
		return ErrPasswordTooLong
	}
	return nil
}

// MaxChannelPasswordLen bounds a voice channel password, in characters.
const MaxChannelPasswordLen = 64

// ErrChannelPasswordInvalid is wrapped by ValidateChannelPassword; safe to show the admin.
var ErrChannelPasswordInvalid = errors.New("invalid channel password")

// ValidateChannelPassword checks a voice channel password: 1 to
// MaxChannelPasswordLen characters, no control characters, within bcrypt's 72
// bytes. It has no minimum strength, being a shared room key.
func ValidateChannelPassword(password string) error {
	n := utf8.RuneCountInString(password)
	switch {
	case n < 1:
		return fmt.Errorf("password must not be empty%.0w", ErrChannelPasswordInvalid)
	case n > MaxChannelPasswordLen:
		return fmt.Errorf("password must be at most %d characters%.0w", MaxChannelPasswordLen, ErrChannelPasswordInvalid)
	case len(password) > maxPassLen:
		return fmt.Errorf("password must be at most %d bytes%.0w", maxPassLen, ErrChannelPasswordInvalid)
	}
	for _, r := range password {
		if unicode.IsControl(r) {
			return fmt.Errorf("password must not contain control characters%.0w", ErrChannelPasswordInvalid)
		}
	}
	return nil
}
