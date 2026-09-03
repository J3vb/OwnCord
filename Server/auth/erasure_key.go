package auth

// erasureKeyBytes is the HMAC-SHA256 key length for deletion-marker tokens.
const erasureKeyBytes = 32

// LoadOrGenerateErasureKey returns the 32-byte key under which deletion
// markers name their subject (B4-10, HP-4 decision 3): a marker carries
// HMAC-SHA256(key, user id), so without the key a marker names no one and
// with it the server can recognise a resurrected account. It checks, in
// order, the OWNCORD_ERASURE_KEY environment variable (hex, 32 bytes), then
// dataDir/erasure.key, and generates a key into that file only on a
// confirmed absence — the same fail-closed rule as the TOTP key (OC-0321):
// replacing the key on a read error would orphan every marker recorded so
// far, and a restore could then resurrect what they guard. Back it up beside
// totp.key; a database backup does not contain it.
func LoadOrGenerateErasureKey(dataDir string) ([]byte, error) {
	return loadOrGenerateKeyFile(keyFileSpec{
		env:       "OWNCORD_ERASURE_KEY",
		file:      "erasure.key",
		size:      erasureKeyBytes,
		what:      "erasure marker key",
		orphans:   "every deletion marker",
		generated: "back it up beside totp.key — a restore without it cannot recognise erased accounts",
	}, dataDir)
}
