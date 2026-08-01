package storage

import (
	"bytes"
	"testing"
)

// FuzzValidateFileType asserts ValidateFileType never panics on any header
// byte slice (nil, empty, short, or huge) and that it returns an error iff
// the header actually starts with one of the blocked magic prefixes -- no
// false positives, no false negatives.
func FuzzValidateFileType(f *testing.F) {
	seeds := [][]byte{
		nil,
		{},
		{0},
		[]byte("MZ"),
		[]byte("M"),
		[]byte("\x7fELF"),
		[]byte("\x7fEL"),
		[]byte("\xcf\xfa\xed\xfe"),
		[]byte("\xce\xfa\xed\xfe"),
		[]byte("#!"),
		[]byte("#!/bin/sh\nrm -rf /"),
		[]byte("\xca\xfe\xba\xbe"),
		[]byte("\xd0\xcf\x11\xe0"),
		[]byte("\x00asm"),
		{0x4c, 0x00, 0x00, 0x00},
		[]byte("PNG"),
		[]byte("\x89PNG\r\n\x1a\n"),
		bytes.Repeat([]byte{0xff}, 4096),
		[]byte("GIF89a"),
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, header []byte) {
		err := ValidateFileType(header)

		wantBlocked := false
		for _, blocked := range blockedMagic {
			if len(header) >= len(blocked.magic) && bytes.Equal(header[:len(blocked.magic)], blocked.magic) {
				wantBlocked = true
				break
			}
		}

		if wantBlocked && err == nil {
			t.Fatalf("ValidateFileType(%x) = nil, want error (header matches a blocked magic prefix)", header)
		}
		if !wantBlocked && err != nil {
			t.Fatalf("ValidateFileType(%x) = %v, want nil (header matches no blocked magic prefix)", header, err)
		}
	})
}
