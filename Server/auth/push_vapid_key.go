package auth

import (
	"crypto/ecdh"
	"fmt"
)

// pushVAPIDKeyBytes is the P-256 private scalar length.
const pushVAPIDKeyBytes = 32

// LoadOrGeneratePushVAPIDKey returns the P-256 private key the server signs
// Web Push VAPID JWTs with. It checks the OWNCORD_PUSH_VAPID_KEY environment
// variable (hex, 32 bytes), then dataDir/push_vapid.key, and generates a key
// into that file only on a confirmed absence: a read error must not silently
// replace a key every subscription's vapid_key_id is checked against.
//
// Rotation is an operator action (replace the file or env var, then restart):
// a push_subscriptions row whose key id no longer matches the running key is
// invisible to List and removed by the sweep.
//
// The generate branch loops until the bytes decode (keyFileSpec.valid), since
// crypto/ecdh refuses the ~2^-32 of scalars outside the curve order. A value
// from the env or file that fails to decode is not retried; it is an error.
func LoadOrGeneratePushVAPIDKey(dataDir string) (*ecdh.PrivateKey, error) {
	raw, err := loadOrGenerateKeyFile(keyFileSpec{
		env:       "OWNCORD_PUSH_VAPID_KEY",
		file:      "push_vapid.key",
		size:      pushVAPIDKeyBytes,
		what:      "Web Push VAPID key",
		orphans:   "every stored Web Push subscription (each device would need to re-subscribe)",
		generated: "back it up beside totp.key — rotating it invalidates every stored subscription",
		valid: func(b []byte) bool {
			_, err := ecdh.P256().NewPrivateKey(b)
			return err == nil
		},
	}, dataDir)
	if err != nil {
		return nil, err
	}
	priv, err := ecdh.P256().NewPrivateKey(raw)
	if err != nil {
		return nil, fmt.Errorf("push VAPID key is not a valid P-256 scalar: %w", err)
	}
	return priv, nil
}
