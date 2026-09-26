package service

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

// pushRecordSize is the aes128gcm "rs" (record size) header field. RFC 8291
// SS4 mandates a single record per push message; 4096 is both the RFC's own
// worked example value and the largest payload a push service is required
// to accept (RFC 8030 SS7.2) — declaring it costs nothing even though every
// payload dispatch sends (decision 9's fixed {"t":"activity"}) is far
// smaller.
const pushRecordSize = 4096

// pushPaddingDelimiter is RFC 8291 SS4's required delimiter octet: appended
// to the plaintext before encryption, with no further padding — dispatch
// never pads beyond the delimiter because the payload's fixed, tiny size is
// itself the anti-fingerprinting property (decision 9), not length hiding.
const pushPaddingDelimiter = 0x02

// errPushInvalidReceiverKey wraps a p256dh that does not decode to a valid
// point on P-256 — crypto/ecdh validates this (SEC1 SS2.3.4: on-curve,
// uncompressed, not the point at infinity) before any secret is derived.
var errPushInvalidReceiverKey = errors.New("push: invalid receiver public key")

// encryptWebPush implements RFC 8291's aes128gcm content-coding for a single
// record: an ECDH shared secret between ephemeral and the subscriber's
// p256dh (receiverPub), combined with the subscriber's auth secret
// (RFC 8291 SS3.3) into an IKM, a content-encryption key and nonce derived
// from that IKM per RFC 8188, and AEAD_AES_128_GCM applied to the plaintext
// plus its padding delimiter. The result is the aes128gcm header (salt, rs,
// idlen, the ephemeral public key) followed by the ciphertext — exactly the
// bytes a push service's request body carries.
//
// ephemeral and salt are parameters rather than generated here so
// TestPushCrypto_RFC8291KnownAnswer can reproduce RFC 8291 SS5's worked
// example exactly, byte for byte. Production calls always go through
// encryptWebPushMessage below, which generates both fresh: reusing a salt
// against the same receiver key reuses the derived AES-GCM key and nonce,
// which breaks AEAD confidentiality outright (the property
// TestPushCrypto_SaltAndEphemeralKeyAreFresh pins).
func encryptWebPush(plaintext, receiverPub, authSecret []byte, ephemeral *ecdh.PrivateKey, salt [16]byte) ([]byte, error) {
	receiverKey, err := ecdh.P256().NewPublicKey(receiverPub)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errPushInvalidReceiverKey, err)
	}
	ecdhSecret, err := ephemeral.ECDH(receiverKey)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errPushInvalidReceiverKey, err)
	}
	ephemeralPub := ephemeral.PublicKey().Bytes()

	// RFC 8291 SS3.3: HKDF-Extract(salt=auth_secret, IKM=ecdh_secret), then
	// HKDF-Expand(PRK_key, key_info, 32) where key_info names both public
	// keys in receiver-then-sender order.
	keyInfo := "WebPush: info\x00" + string(receiverPub) + string(ephemeralPub)
	ikm, err := hkdf.Key(sha256.New, ecdhSecret, authSecret, keyInfo, sha256.Size)
	if err != nil {
		return nil, fmt.Errorf("push: combining secrets: %w", err)
	}

	// RFC 8188's own derivation: HKDF-Extract(salt, IKM) then
	// HKDF-Expand(PRK, ..., L) for the CEK and the nonce, each with its own
	// info string and length.
	cek, err := hkdf.Key(sha256.New, ikm, salt[:], "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, fmt.Errorf("push: deriving content encryption key: %w", err)
	}
	nonce, err := hkdf.Key(sha256.New, ikm, salt[:], "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, fmt.Errorf("push: deriving nonce: %w", err)
	}

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, fmt.Errorf("push: aes cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("push: gcm: %w", err)
	}
	padded := append(append([]byte(nil), plaintext...), pushPaddingDelimiter)
	ciphertext := gcm.Seal(nil, nonce, padded, nil)

	header := make([]byte, 0, 16+4+1+len(ephemeralPub))
	header = append(header, salt[:]...)
	header = binary.BigEndian.AppendUint32(header, pushRecordSize)
	header = append(header, byte(len(ephemeralPub))) //nolint:gosec // G115: ephemeralPub is always a 65-byte P-256 uncompressed point
	header = append(header, ephemeralPub...)

	return append(header, ciphertext...), nil
}

// encryptWebPushMessage is encryptWebPush for production dispatch: a fresh
// ephemeral P-256 key pair and a fresh random salt for every call, from
// crypto/rand, never reused across messages or subscribers.
func encryptWebPushMessage(plaintext, receiverPub, authSecret []byte) ([]byte, error) {
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("push: generating ephemeral key: %w", err)
	}
	var salt [16]byte
	if _, err := rand.Read(salt[:]); err != nil {
		return nil, fmt.Errorf("push: generating salt: %w", err)
	}
	return encryptWebPush(plaintext, receiverPub, authSecret, ephemeral, salt)
}
