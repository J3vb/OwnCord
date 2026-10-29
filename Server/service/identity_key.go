package service

import (
	"encoding/base64"
	"fmt"
)

// MaxIdentityKeyLen is the longest identity public key accepted, in characters.
const MaxIdentityKeyLen = 128

// ValidateIdentityKey checks that key is non-empty, at most MaxIdentityKeyLen
// characters and valid standard-alphabet base64 (padded or unpadded) -- the
// same posture as the WS voice_e2ee_announce public_key validation. It is the
// one validator for the key PATCH /users/me publishes and the key a WebSocket
// auth frame carries.
func ValidateIdentityKey(key string) error {
	if key == "" {
		return fmt.Errorf("identity_public_key must not be empty")
	}
	if len(key) > MaxIdentityKeyLen {
		return fmt.Errorf("identity_public_key too large (max %d characters)", MaxIdentityKeyLen)
	}
	if _, err := base64.StdEncoding.DecodeString(key); err == nil {
		return nil
	}
	if _, err := base64.RawStdEncoding.DecodeString(key); err != nil {
		return fmt.Errorf("identity_public_key is not valid base64")
	}
	return nil
}
