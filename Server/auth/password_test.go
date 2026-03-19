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
		"12345678",        // exactly 8 chars
		"abcdefghij",     // 10 chars
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
		"",         // empty
		"1234567",  // 7 chars
		"abc",      // 3 chars
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
