package auth

import (
	"crypto/ecdh"
	"fmt"
)

// pushVAPIDKeyBytes is the P-256 private scalar length.
const pushVAPIDKeyBytes = 32

// LoadOrGeneratePushVAPIDKey returns the P-256 private key the server signs
// Web Push VAPID JWTs with (B5-4, S7-b). It checks, in order, the
// OWNCORD_PUSH_VAPID_KEY environment variable (hex, 32 bytes), then
// dataDir/push_vapid.key, and generates a key into that file only on a
// confirmed absence — the same fail-closed rule as the TOTP and erasure keys
// (OC-0321): a read error must not silently replace a key every stored
// subscription's vapid_key_id is checked against.
//
// Rotation is an operator action (replace the file or the env var, then
// restart), not an endpoint: every push_subscriptions row records the key id
// it was created under, and a row whose id no longer matches the running key
// is invisible to List and removed by the sweep.
//
// A uniform random 32-byte scalar has a roughly 2^-32 chance of landing
// outside the P-256 curve order, which crypto/ecdh refuses; the generate
// branch loops until the bytes decode, via keyFileSpec.valid, so that
// astronomically rare case never surfaces as a startup failure. A value that
// fails to decode on the env or file path is NOT retried — same fail-closed
// rule as everywhere else here — it is reported as an error.
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
