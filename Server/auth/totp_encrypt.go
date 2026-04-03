package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

const (
	// totpKeyBytes is the required length for the AES-256 encryption key.
	totpKeyBytes = 32

	// minEncryptedHexLen is the minimum hex-encoded length of a valid
	// nonce+ciphertext (12-byte nonce + at least 16-byte GCM tag = 28 bytes
	// = 56 hex chars).
	minEncryptedHexLen = 56
)

// LoadOrGenerateTOTPKey returns a 32-byte AES-256 key for TOTP secret
// encryption. It checks (in order):
//  1. OWNCORD_TOTP_KEY environment variable (hex-encoded 32 bytes)
//  2. dataDir/totp.key file
//  3. Auto-generates a random key, writes it to dataDir/totp.key, and logs a warning
func LoadOrGenerateTOTPKey(dataDir string) ([]byte, error) {
	// 1. Check environment variable.
	if envKey := os.Getenv("OWNCORD_TOTP_KEY"); envKey != "" {
		key, err := hex.DecodeString(envKey)
		if err != nil {
			return nil, fmt.Errorf("OWNCORD_TOTP_KEY is not valid hex: %w", err)
		}
		if len(key) != totpKeyBytes {
			return nil, fmt.Errorf("OWNCORD_TOTP_KEY must be exactly %d bytes (got %d)", totpKeyBytes, len(key))
		}
		slog.Info("loaded TOTP encryption key from OWNCORD_TOTP_KEY environment variable")
		return key, nil
	}

	// 2. Check key file on disk.
	keyPath := filepath.Join(dataDir, "totp.key")
	if data, err := os.ReadFile(keyPath); err == nil {
		key, decErr := hex.DecodeString(string(data))
		if decErr != nil {
			return nil, fmt.Errorf("totp.key contains invalid hex: %w", decErr)
		}
		if len(key) != totpKeyBytes {
			return nil, fmt.Errorf("totp.key must contain exactly %d bytes (got %d)", totpKeyBytes, len(key))
		}
		slog.Info("loaded TOTP encryption key from file", "path", keyPath)
		return key, nil
	}

	// 3. Auto-generate a new key.
	key := make([]byte, totpKeyBytes)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generating TOTP encryption key: %w", err)
	}

	// Ensure the data directory exists.
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("creating data directory for totp.key: %w", err)
	}

	if err := os.WriteFile(keyPath, []byte(hex.EncodeToString(key)), 0o600); err != nil {
		return nil, fmt.Errorf("writing totp.key: %w", err)
	}

	slog.Warn("auto-generated TOTP encryption key and saved to disk; "+
		"set OWNCORD_TOTP_KEY env var for production deployments",
		"path", keyPath)
	return key, nil
}

// EncryptTOTPSecret encrypts a plaintext TOTP secret using AES-256-GCM.
// Returns a hex-encoded string of nonce+ciphertext.
func EncryptTOTPSecret(key []byte, plaintext string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("creating AES cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("creating GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generating nonce: %w", err)
	}

	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return hex.EncodeToString(ciphertext), nil
}

// DecryptTOTPSecret decrypts a hex-encoded AES-256-GCM ciphertext back to the
// plaintext TOTP secret. For backwards compatibility, if the value does not
// look like valid encrypted data (not valid hex, or too short for
// nonce+tag), it is returned as-is so that existing unencrypted secrets
// continue to work.
func DecryptTOTPSecret(key []byte, ciphertext string) (string, error) {
	// Backwards compatibility: if it doesn't look encrypted, return as-is.
	if len(ciphertext) < minEncryptedHexLen {
		return ciphertext, nil
	}

	data, err := hex.DecodeString(ciphertext)
	if err != nil {
		// Not valid hex -- treat as unencrypted plaintext (backwards compat).
		return ciphertext, nil //nolint:nilerr
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("creating AES cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("creating GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize+gcm.Overhead() {
		// Too short to be valid encrypted data -- return as plaintext.
		return ciphertext, nil
	}

	nonce, sealed := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		// Decryption failed -- likely an unencrypted legacy secret.
		// Return as-is for backwards compatibility.
		return ciphertext, nil //nolint:nilerr
	}

	return string(plaintext), nil
}
