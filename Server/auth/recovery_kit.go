package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

// The recovery kit (B4-5, BPR-044): a secret the account holder keeps
// offline, of which the server stores only an argon2id verifier. A kit
// secret is 20 random bytes shown as 32 base32 characters in groups of four,
// "XXXX-XXXX-…", which is what the client formats as a phrase or a file.
const (
	// maxRecoveryKitHashLen bounds the tag length a verifier may ask for.
	maxRecoveryKitHashLen  = 512
	recoveryKitSecretBytes = 20
	recoveryKitSecretLen   = 32
	recoveryKitGroup       = 4

	// argon2id parameters: OWASP's minimum for the memory-constrained
	// profile, chosen because verification takes an admission slot (B4-4)
	// and a burst of recoveries must not exhaust memory. The verifier
	// records them, so they can change without invalidating stored kits.
	recoveryKitArgonTime    = 2
	recoveryKitArgonMemory  = 19 * 1024 // KiB
	recoveryKitArgonThreads = 1
	recoveryKitArgonKeyLen  = 32
	recoveryKitArgonSaltLen = 16
)

var recoveryKitEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// GenerateRecoveryKitSecret returns a fresh kit secret as the user sees it
// (grouped) and its canonical form (the string the verifier is made from).
func GenerateRecoveryKitSecret() (shown, canonical string, err error) {
	raw := make([]byte, recoveryKitSecretBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", "", fmt.Errorf("GenerateRecoveryKitSecret: %w", err)
	}
	canonical = recoveryKitEncoding.EncodeToString(raw)
	var b strings.Builder
	for i := 0; i < len(canonical); i += recoveryKitGroup {
		if i > 0 {
			b.WriteByte('-')
		}
		b.WriteString(canonical[i : i+recoveryKitGroup])
	}
	return b.String(), canonical, nil
}

// NormalizeRecoveryKitSecret turns user input — however it was grouped,
// spaced or cased — into the canonical form, and reports whether it has a
// kit secret's shape at all.
func NormalizeRecoveryKitSecret(input string) (canonical string, ok bool) {
	var b strings.Builder
	for _, r := range strings.ToUpper(input) {
		switch {
		case r >= 'A' && r <= 'Z', r >= '2' && r <= '7':
			b.WriteRune(r)
		case r == '-' || r == ' ' || r == '\t' || r == '\n' || r == '\r':
			// separators
		default:
			return "", false
		}
	}
	canonical = b.String()
	if len(canonical) != recoveryKitSecretLen {
		return "", false
	}
	return canonical, true
}

// HashRecoveryKitSecret returns the argon2id verifier of a canonical secret
// as a PHC string ("$argon2id$v=19$m=…,t=…,p=…$salt$hash"), the only thing
// the server stores.
func HashRecoveryKitSecret(canonical string) (string, error) {
	salt := make([]byte, recoveryKitArgonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("HashRecoveryKitSecret: %w", err)
	}
	key := argon2.IDKey([]byte(canonical), salt, recoveryKitArgonTime, recoveryKitArgonMemory, recoveryKitArgonThreads, recoveryKitArgonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, recoveryKitArgonMemory, recoveryKitArgonTime, recoveryKitArgonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyRecoveryKitSecret reports whether canonical is the secret the PHC
// verifier was made from. The parameters come from the verifier itself, so
// kits issued under earlier parameters keep verifying. A malformed verifier
// is a mismatch, never a panic.
func VerifyRecoveryKitSecret(verifier, canonical string) bool {
	parts := strings.Split(verifier, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return false
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	var memory, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil || memory == 0 || time == 0 || threads == 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 || len(want) > maxRecoveryKitHashLen {
		return false
	}
	got := argon2.IDKey([]byte(canonical), salt, time, memory, threads, uint32(len(want))) //nolint:gosec // G115: bounded by maxRecoveryKitHashLen
	return subtle.ConstantTimeCompare(got, want) == 1
}

var (
	dummyRecoveryKitOnce     sync.Once
	dummyRecoveryKitVerifier string
	errDummyRecoveryKit      = errors.New("dummy recovery kit verifier unavailable")
)

// DummyRecoveryKitVerifier is a verifier of a secret nobody holds, for the
// compare a recovery attempt runs when the account or its kit does not
// exist, so a missing kit costs the same time as a wrong secret.
func DummyRecoveryKitVerifier() (string, error) {
	dummyRecoveryKitOnce.Do(func() {
		if _, canonical, err := GenerateRecoveryKitSecret(); err == nil {
			dummyRecoveryKitVerifier, _ = HashRecoveryKitSecret(canonical)
		}
	})
	if dummyRecoveryKitVerifier == "" {
		return "", errDummyRecoveryKit
	}
	return dummyRecoveryKitVerifier, nil
}
