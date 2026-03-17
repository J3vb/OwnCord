package auth_test

import (
	"testing"

	"github.com/owncord/server/auth"
)

func TestGenerateToken_Length(t *testing.T) {
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken() error = %v", err)
	}
	if len(token) != 64 {
		t.Errorf("GenerateToken() len = %d, want 64", len(token))
	}
}

func TestGenerateToken_HexCharacters(t *testing.T) {
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken() error = %v", err)
	}
	for i, c := range token {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			t.Errorf("GenerateToken() char[%d] = %q, not lowercase hex", i, c)
		}
	}
}

func TestGenerateToken_Uniqueness(t *testing.T) {
	const n = 1000
	seen := make(map[string]struct{}, n)
	for i := range n {
		tok, err := auth.GenerateToken()
		if err != nil {
			t.Fatalf("GenerateToken() iteration %d error = %v", i, err)
		}
		if _, dup := seen[tok]; dup {
			t.Fatalf("GenerateToken() produced duplicate token at iteration %d", i)
		}
		seen[tok] = struct{}{}
	}
}

func TestHashToken_Deterministic(t *testing.T) {
	token := "abc123"
	h1 := auth.HashToken(token)
	h2 := auth.HashToken(token)
	if h1 != h2 {
		t.Errorf("HashToken() not deterministic: %q != %q", h1, h2)
	}
}

func TestHashToken_DiffersFromPlaintext(t *testing.T) {
	token := "abc123"
	hash := auth.HashToken(token)
	if hash == token {
		t.Errorf("HashToken() hash equals plaintext token")
	}
}

func TestHashToken_Length(t *testing.T) {
	// SHA-256 hex = 64 chars
	hash := auth.HashToken("any-token")
	if len(hash) != 64 {
		t.Errorf("HashToken() len = %d, want 64", len(hash))
	}
}

func TestHashToken_DifferentInputsDifferentHashes(t *testing.T) {
	h1 := auth.HashToken("token-one")
	h2 := auth.HashToken("token-two")
	if h1 == h2 {
		t.Errorf("HashToken() same hash for different inputs")
	}
}
