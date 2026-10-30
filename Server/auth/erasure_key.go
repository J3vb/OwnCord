package auth

// erasureKeyBytes is the HMAC-SHA256 key length for deletion-marker tokens.
const erasureKeyBytes = 32

// LoadOrGenerateErasureKey returns the 32-byte key under which deletion
// markers name their subject: a marker carries HMAC-SHA256(key, user id), so
// without the key it names no one and with it the server can recognise a
// resurrected account. It checks OWNCORD_ERASURE_KEY (hex, 32 bytes), then
// dataDir/erasure.key, and generates a key only on a confirmed absence (as
// for the TOTP key): replacing it on a read error would orphan every recorded
// marker. Back it up beside totp.key; a database backup does not contain it.
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
