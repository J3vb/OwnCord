package auth

import (
	"errors"
	"sync"

	"golang.org/x/crypto/bcrypt"
)

const (
	bcryptCost = 12
	minPassLen = 8
	maxPassLen = 72 // bcrypt silently truncates beyond 72 bytes
)

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

// dummyHash is a lazily-computed bcrypt hash used to prevent timing
// side-channels when the user does not exist. Comparing against this dummy
// ensures that CheckPassword takes roughly constant time regardless of
// whether a valid hash was supplied.
var (
	dummyHash     []byte
	dummyHashOnce sync.Once
)

// getDummyHash returns the pre-computed dummy bcrypt hash, initialising it
// on first call via sync.Once.
func getDummyHash() []byte {
	dummyHashOnce.Do(func() {
		h, err := bcrypt.GenerateFromPassword([]byte("dummy-timing-pad"), bcryptCost)
		if err != nil {
			// crypto/rand is required for the server to function; panic is
			// appropriate here as there is no recovery path.
			panic("auth: failed to generate dummy bcrypt hash: " + err.Error())
		}
		dummyHash = h
	})
	return dummyHash
}

// CheckPassword reports whether password matches hash. Returns false on any
// error, including an empty or malformed hash. When hash is empty (user does
// not exist), a dummy bcrypt comparison is performed to prevent timing-based
// username enumeration.
func CheckPassword(hash, password string) bool {
	if hash == "" {
		// Perform a dummy comparison so the response time is indistinguishable
		// from a real check, preventing timing-based username enumeration.
		// The error is intentionally discarded: we always return false here.
		// The comparison is performed only to consume time and prevent
		// timing-based username enumeration.
		_ = bcrypt.CompareHashAndPassword(getDummyHash(), []byte(password))
		return false
	}
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// ValidatePasswordStrength returns an error if password fails strength
// requirements: minimum 8 characters, maximum 72 characters.
func ValidatePasswordStrength(password string) error {
	if len(password) < minPassLen {
		return ErrPasswordTooShort
	}
	if len(password) > maxPassLen {
		return ErrPasswordTooLong
	}
	return nil
}
