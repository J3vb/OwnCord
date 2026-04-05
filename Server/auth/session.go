package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
)

// GenerateToken returns a cryptographically random 256-bit token encoded as a
// 64-character lowercase hex string.
func GenerateToken() (string, error) {
	raw := make([]byte, sessionTokenBytes) // 256 bits
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// HashToken returns the SHA-256 hex digest of token. Store this hash in the
// database; never store the plaintext token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
