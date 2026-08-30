package api

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/storage"
)

// BenchmarkUploadAdmission runs the two upload validators in the order
// uploadHandler runs them, over one fixed fixture: sanitizeUploadFilename
// (basename, backslash strip, the control/Cf rune scan, the byte cap) and then
// storage.ValidateFileType over the sniff header. The fixture is a hostile
// filename and an accepted PDF header — accept is the worst case for
// ValidateFileType, which returns on the first blocked signature it matches and
// only walks the whole blockedMagic table when nothing matches.
func BenchmarkUploadAdmission(b *testing.B) {
	// U+202E is a bidi override: the invisible rune class sanitizeUploadFilename
	// strips, so a name cannot render one extension while carrying another.
	const name = "../../etc\\pa\u202egnp.exe\x00 quarterly report.pdf"
	header := []byte("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>")

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if got := sanitizeUploadFilename(name); got == "" {
			b.Fatal("sanitizeUploadFilename returned an empty name")
		}
		if err := storage.ValidateFileType(header); err != nil {
			b.Fatalf("ValidateFileType rejected the fixture: %v", err)
		}
	}
}
