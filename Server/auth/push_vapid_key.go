package auth

import (
	"crypto/ecdh"
	"fmt"
)

// pushVAPIDKeyBytes is the P-256 private scalar length.
const pushVAPIDKeyBytes = 32

// LoadOrGeneratePushVAPIDKey returns the P-256 key the server signs Web Push
// VAPID JWTs with. It checks OWNCORD_PUSH_VAPID_KEY (hex), then
// dataDir/push_vapid.key, and generates only on a confirmed absence: a read
// error must not replace a key every subscription is checked against.
//
// Rotation is an operator action: a subscription whose key id no longer matches
// is invisible to List and removed by the sweep. Generation loops until the
// bytes decode; an env or file value that fails to decode is an error.
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
