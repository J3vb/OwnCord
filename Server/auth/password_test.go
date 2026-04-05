package auth_test

import (
	"strings"
	"testing"

	"github.com/owncord/server/auth"
)

func TestHashPassword_DiffersFromPlaintext(t *testing.T) {
	hash, err := auth.HashPassword("mypassword")
	if err != nil {
		t.Fatalf("HashPassword() error = %v", err)
	}
	if hash == "mypassword" {
		t.Error("HashPassword() hash equals plaintext")
	}
}

func TestHashPassword_BcryptPrefix(t *testing.T) {
	hash, err := auth.HashPassword("mypassword")
	if err != nil {
		t.Fatalf("HashPassword() error = %v", err)
	}
	if !strings.HasPrefix(hash, "$2") {
		t.Errorf("HashPassword() = %q, want bcrypt prefix $2*", hash)
	}
}

func TestCheckPassword_CorrectPassword(t *testing.T) {
	hash, err := auth.HashPassword("correctpassword")
	if err != nil {
		t.Fatalf("HashPassword() error = %v", err)
	}
	if !auth.CheckPassword(hash, "correctpassword") {
		t.Error("CheckPassword() returned false for correct password")
	}
}

func TestCheckPassword_WrongPassword(t *testing.T) {
	hash, err := auth.HashPassword("correctpassword")
	if err != nil {
		t.Fatalf("HashPassword() error = %v", err)
	}
	if auth.CheckPassword(hash, "wrongpassword") {
		t.Error("CheckPassword() returned true for wrong password")
	}
}

func TestCheckPassword_EmptyPassword(t *testing.T) {
	hash, err := auth.HashPassword("somepassword")
	if err != nil {
		t.Fatalf("HashPassword() error = %v", err)
	}
	if auth.CheckPassword(hash, "") {
		t.Error("CheckPassword() returned true for empty password")
	}
}

func TestCheckPassword_EmptyHash(t *testing.T) {
	if auth.CheckPassword("", "somepassword") {
		t.Error("CheckPassword() returned true with empty hash")
	}
}

func TestValidatePasswordStrength_Valid(t *testing.T) {
	cases := []string{
		"12345678",              // exactly 8 chars
		"abcdefghij",            // 10 chars
		strings.Repeat("a", 72), // exactly 72 chars (bcrypt max)
	}
	for _, pw := range cases {
		if err := auth.ValidatePasswordStrength(pw); err != nil {
			t.Errorf("ValidatePasswordStrength(%q) error = %v, want nil", pw, err)
		}
	}
}

func TestValidatePasswordStrength_TooShort(t *testing.T) {
	cases := []string{
		"",        // empty
		"1234567", // 7 chars
		"abc",     // 3 chars
	}
	for _, pw := range cases {
		if err := auth.ValidatePasswordStrength(pw); err == nil {
			t.Errorf("ValidatePasswordStrength(%q) error = nil, want error", pw)
		}
	}
}

func TestValidatePasswordStrength_TooLong(t *testing.T) {
	pw := strings.Repeat("a", 73) // 73 chars — over bcrypt 72 byte limit
	if err := auth.ValidatePasswordStrength(pw); err == nil {
		t.Errorf("ValidatePasswordStrength(%q) error = nil, want error for >72 chars", pw)
	}
}

func TestHashPassword_TwoCallsDifferentHashes(t *testing.T) {
	// bcrypt includes a random salt
	h1, _ := auth.HashPassword("password")
	h2, _ := auth.HashPassword("password")
	if h1 == h2 {
		t.Error("HashPassword() produced identical hashes for the same password (salt missing?)")
	}
}

func TestCheckPassword_EmptyHashTimingResistance(t *testing.T) {
	// Calling CheckPassword with an empty hash should not be significantly
	// faster than with a real hash (dummy comparison is performed).
	// We just verify it returns false and doesn't panic.
	result := auth.CheckPassword("", "anypassword")
	if result {
		t.Error("CheckPassword(\"\", ...) = true, want false")
	}
}

func TestCheckPassword_MalformedHash(t *testing.T) {
	// A malformed hash string (not bcrypt) should return false without panic.
	result := auth.CheckPassword("not-a-bcrypt-hash", "password")
	if result {
		t.Error("CheckPassword(malformed, ...) = true, want false")
	}
}

func TestHashPassword_UnicodePassword(t *testing.T) {
	// Unicode passwords should hash and verify correctly.
	pw := "Pässwörd™日本語"
	hash, err := auth.HashPassword(pw)
	if err != nil {
		t.Fatalf("HashPassword(unicode) error: %v", err)
	}
	if !auth.CheckPassword(hash, pw) {
		t.Error("CheckPassword() = false for correct unicode password")
	}
	if auth.CheckPassword(hash, "Pässwörd™日本") {
		t.Error("CheckPassword() = true for slightly different unicode password")
	}
}

func TestValidatePasswordStrength_UnicodeMultibyte(t *testing.T) {
	// A password of 8 multi-byte runes may exceed 8 bytes but len() counts bytes.
	// "日本語日本語日本" is 8 runes but 24 bytes — should pass the min check.
	pw := "日本語日本語日本"
	if err := auth.ValidatePasswordStrength(pw); err != nil {
		t.Errorf("ValidatePasswordStrength(8-rune unicode) = %v, want nil", err)
	}
}

func TestValidatePasswordStrength_ExactBoundaries(t *testing.T) {
	// Exactly 8 bytes — valid.
	if err := auth.ValidatePasswordStrength("12345678"); err != nil {
		t.Errorf("exactly 8 chars: %v", err)
	}
	// Exactly 72 bytes — valid.
	if err := auth.ValidatePasswordStrength(strings.Repeat("x", 72)); err != nil {
		t.Errorf("exactly 72 chars: %v", err)
	}
	// 7 bytes — too short.
	if err := auth.ValidatePasswordStrength("1234567"); err == nil {
		t.Error("7 chars should be too short")
	}
	// 73 bytes — too long.
	if err := auth.ValidatePasswordStrength(strings.Repeat("x", 73)); err == nil {
		t.Error("73 chars should be too long")
	}
}
