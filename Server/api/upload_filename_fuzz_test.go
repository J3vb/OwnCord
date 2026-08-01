package api

import (
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// FuzzSanitizeUploadFilename hunts for inputs where sanitizeUploadFilename's
// output violates the safety contract its callers rely on: the returned name
// is later used both as a display string and pre-filled into a native save
// dialog on the downloading client, so it must never smuggle a path
// separator, a control/bidi-override character, or invalid UTF-8 (the byte
// truncation to maxUploadFilenameLength is the prime suspect for splitting a
// multibyte rune in half).
func FuzzSanitizeUploadFilename(f *testing.F) {
	seeds := []string{
		"",
		".",
		"..",
		"...",
		"/",
		"\\",
		"a/b/c",
		"a\\b\\c",
		"/etc/passwd",
		"..\\..\\windows\\system32",
		"C:\\Windows\\System32\\evil.exe",
		"normal.txt",
		" leading-space.txt",
		"trailing-space.txt ",
		"\t\n\r",
		"\x00\x01\x02",
		"file\x00name.txt",
		"\u202Eexe.txt\u202Cgnp.jpg", // RTL override trick
		"\u2066\u2069",
		strings.Repeat("a", 300),
		strings.Repeat("é", 200),       // 2-byte UTF-8 rune repeated, truncation-prone
		strings.Repeat("😀", 100),       // 4-byte rune repeated
		strings.Repeat("a", 254) + "é", // boundary: truncation splits the multibyte rune
		strings.Repeat("a", 253) + "😀",
		strings.Repeat("a", 255) + "x",
		"file/../../etc/passwd",
		"a" + string(rune(0x202E)) + "b",
		"\ufeff.txt", // BOM
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, name string) {
		out := sanitizeUploadFilename(name)

		if strings.ContainsAny(out, "/\\") {
			t.Fatalf("sanitizeUploadFilename(%q) = %q contains a path separator", name, out)
		}
		if out == "" {
			t.Fatalf("sanitizeUploadFilename(%q) = %q is empty", name, out)
		}
		if out == "." || out == ".." {
			t.Fatalf("sanitizeUploadFilename(%q) = %q is a reserved dot-name", name, out)
		}
		if !utf8.ValidString(out) {
			t.Fatalf("sanitizeUploadFilename(%q) = %q is not valid UTF-8 (bytes: %x)", name, out, out)
		}
		if len(out) > maxUploadFilenameLength {
			t.Fatalf("sanitizeUploadFilename(%q) = %q has length %d > max %d", name, out, len(out), maxUploadFilenameLength)
		}
		for _, r := range out {
			if unicode.IsControl(r) {
				t.Fatalf("sanitizeUploadFilename(%q) = %q contains control char %U", name, out, r)
			}
			if unicode.In(r, unicode.Cf) {
				t.Fatalf("sanitizeUploadFilename(%q) = %q contains bidi/format char %U", name, out, r)
			}
		}
	})
}
