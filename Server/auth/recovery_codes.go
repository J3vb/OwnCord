package auth

import (
	"crypto/rand"
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// Emergency recovery codes (BPR-046, B4-3): a second factor of last resort
// for an account whose authenticator is gone. Ten codes are issued when 2FA
// is enrolled (and on every regeneration), each usable once in place of a
// TOTP code at the verify step. The server stores bcrypt hashes only; the
// plaintext exists in the enrolment response and nowhere else.
const (
	recoveryCodeCount = 10
	// recoveryCodeLen is the number of alphabet symbols per code: ten symbols
	// from a 32-symbol alphabet is 50 bits, and the bcrypt work factor below
	// is what makes a database dump useless against them offline.
	recoveryCodeLen = 10
	// recoveryCodeAlphabet omits 0/O and 1/I/L so a code read back from paper
	// cannot be mistyped by shape; digits and letters mix freely.
	recoveryCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	// recoveryCodeBcryptCost is lower than the password cost: a set is ten
	// hashes at enrolment and up to ten compares at verify, and the codes
	// carry more entropy than a typical password. Tests lower bcryptCost via
	// SetCostForTesting, and the min below follows them down.
	recoveryCodeBcryptCost = 10
)

// GenerateRecoveryCodes returns a fresh set as the user sees it (grouped
// "XXXXX-XXXXX") and the bcrypt hashes to store, index-aligned.
func GenerateRecoveryCodes() (codes []string, hashes []string, err error) {
	cost := min(recoveryCodeBcryptCost, bcryptCost)
	codes = make([]string, 0, recoveryCodeCount)
	hashes = make([]string, 0, recoveryCodeCount)
	for range recoveryCodeCount {
		raw := make([]byte, recoveryCodeLen)
		if _, err := rand.Read(raw); err != nil {
			return nil, nil, fmt.Errorf("GenerateRecoveryCodes: %w", err)
		}
		var b strings.Builder
		for i, r := range raw {
			if i == recoveryCodeLen/2 {
				b.WriteByte('-')
			}
			b.WriteByte(recoveryCodeAlphabet[int(r)%len(recoveryCodeAlphabet)])
		}
		code := b.String()
		canonical, _ := NormalizeRecoveryCode(code)
		h, err := bcrypt.GenerateFromPassword([]byte(canonical), cost)
		if err != nil {
			return nil, nil, fmt.Errorf("GenerateRecoveryCodes: %w", err)
		}
		codes = append(codes, code)
		hashes = append(hashes, string(h))
	}
	return codes, hashes, nil
}

// NormalizeRecoveryCode turns user input into the canonical form the hashes
// were made from — upper-case, no separators — and reports whether it has a
// recovery code's shape at all. A six-digit TOTP code is not one, so the
// verify step can route on the answer.
func NormalizeRecoveryCode(input string) (canonical string, ok bool) {
	var b strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(input)) {
		switch r {
		case '-', ' ':
			continue
		}
		if !strings.ContainsRune(recoveryCodeAlphabet, r) {
			return "", false
		}
		b.WriteRune(r)
	}
	canonical = b.String()
	if len(canonical) != recoveryCodeLen {
		return "", false
	}
	return canonical, true
}

// MatchRecoveryCode returns the index of the hash the canonical code
// matches, or -1. Every hash is compared, so the cost does not reveal which
// position matched.
func MatchRecoveryCode(canonical string, hashes []string) int {
	match := -1
	for i, h := range hashes {
		if bcrypt.CompareHashAndPassword([]byte(h), []byte(canonical)) == nil && match < 0 {
			match = i
		}
	}
	return match
}
