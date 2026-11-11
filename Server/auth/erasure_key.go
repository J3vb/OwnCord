package auth

// erasureKeyBytes is the HMAC-SHA256 key length for deletion-marker tokens.
const erasureKeyBytes = 32

// LoadOrGenerateErasureKey returns the 32-byte key behind deletion markers
// (HMAC-SHA256(key, user id)), so the server can recognise a resurrected
// account. It checks OWNCORD_ERASURE_KEY (hex), then dataDir/erasure.key, and
// generates only on a confirmed absence: replacing it on a read error would
// orphan every marker. Back it up beside totp.key; a database backup lacks it.
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
