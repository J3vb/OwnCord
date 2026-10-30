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

// pushRecordSize is the aes128gcm "rs" header field. RFC 8291 SS4 mandates a single
// record per push message; 4096 is the RFC's worked example and the largest payload
// a push service must accept (RFC 8030 SS7.2). Declaring it costs nothing though
// dispatch's fixed payload is far smaller.
const pushRecordSize = 4096

// pushPaddingDelimiter is RFC 8291 SS4's delimiter octet, appended before
// encryption with no further padding: the payload's fixed, tiny size is itself the
// anti-fingerprinting property, not length hiding.
const pushPaddingDelimiter = 0x02

// errPushInvalidReceiverKey wraps a p256dh that is not a valid P-256 point;
// crypto/ecdh validates this (on-curve, uncompressed, not infinity) before any
// secret is derived.
var errPushInvalidReceiverKey = errors.New("push: invalid receiver public key")

// encryptWebPush implements RFC 8291's aes128gcm content-coding for a single
// record: an ECDH secret between ephemeral and the subscriber's p256dh, combined
// with the auth secret (RFC 8291 SS3.3) into an IKM, a content-encryption key and
// nonce derived per RFC 8188, and AEAD_AES_128_GCM over the plaintext plus its
// delimiter. The result is the aes128gcm header (salt, rs, idlen, ephemeral public
// key) followed by the ciphertext, the push request body.
// ephemeral and salt are parameters so TestPushCrypto_RFC8291KnownAnswer can
// reproduce RFC 8291 SS5's worked example byte for byte. Production goes through
// encryptWebPushMessage, which generates both fresh: reusing a salt against the
// same receiver key reuses the AES-GCM key and nonce, which breaks AEAD
// confidentiality (pinned by TestPushCrypto_SaltAndEphemeralKeyAreFresh).
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
	// HKDF-Expand(PRK_key, key_info, 32), key_info naming both public keys receiver
	// first.
	keyInfo := "WebPush: info\x00" + string(receiverPub) + string(ephemeralPub)
	ikm, err := hkdf.Key(sha256.New, ecdhSecret, authSecret, keyInfo, sha256.Size)
	if err != nil {
		return nil, fmt.Errorf("push: combining secrets: %w", err)
	}

	// RFC 8188: HKDF-Extract(salt, IKM), then HKDF-Expand for the CEK and the nonce,
	// each with its own info string and length.
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
