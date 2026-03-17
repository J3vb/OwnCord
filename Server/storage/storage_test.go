package storage_test

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/owncord/server/storage"
)

// newTestStorage creates a Storage instance backed by a temporary directory
// that is removed when the test ends.
func newTestStorage(t *testing.T) *storage.Storage {
	t.Helper()
	dir := t.TempDir()
	s, err := storage.New(dir, 10)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	return s
}

// ─── sanitizeFilename / path validation (tested indirectly via Save/Delete/Open) ─

// TestSave_ValidUUID verifies that a normal UUID-style filename is accepted.
func TestSave_ValidUUID(t *testing.T) {
	s := newTestStorage(t)
	err := s.Save("550e8400-e29b-41d4-a716-446655440000", strings.NewReader("hello"))
	if err != nil {
		t.Errorf("Save valid uuid: unexpected error: %v", err)
	}
}

// TestSave_PathTraversalDotDot rejects filenames containing "..".
func TestSave_PathTraversalDotDot(t *testing.T) {
	s := newTestStorage(t)
	err := s.Save("../../etc/passwd", strings.NewReader("evil"))
	if err == nil {
		t.Error("Save('../../etc/passwd') returned nil error, want path traversal error")
	}
}

// TestSave_DotDotFilename rejects the literal string "..".
func TestSave_DotDotFilename(t *testing.T) {
	s := newTestStorage(t)
	err := s.Save("..", strings.NewReader("evil"))
	if err == nil {
		t.Error("Save('..') returned nil error, want error")
	}
}

// TestSave_SingleDotFilename rejects the literal string ".".
func TestSave_SingleDotFilename(t *testing.T) {
	s := newTestStorage(t)
	err := s.Save(".", strings.NewReader("evil"))
	if err == nil {
		t.Error("Save('.') returned nil error, want error")
	}
}

// TestSave_EmptyFilename rejects an empty string.
func TestSave_EmptyFilename(t *testing.T) {
	s := newTestStorage(t)
	err := s.Save("", strings.NewReader("data"))
	if err == nil {
		t.Error("Save('') returned nil error, want error")
	}
}

// TestSave_DotPrefixFilename rejects filenames starting with ".".
func TestSave_DotPrefixFilename(t *testing.T) {
	s := newTestStorage(t)
	err := s.Save(".hidden", strings.NewReader("data"))
	if err == nil {
		t.Error("Save('.hidden') returned nil error, want error")
	}
}

// TestSave_ForwardSlashRejected rejects filenames containing a forward slash.
func TestSave_ForwardSlashRejected(t *testing.T) {
	s := newTestStorage(t)
	err := s.Save("sub/file", strings.NewReader("data"))
	if err == nil {
		t.Error("Save('sub/file') returned nil error, want path separator error")
	}
}

// TestSave_BackslashRejected rejects filenames containing a backslash.
func TestSave_BackslashRejected(t *testing.T) {
	s := newTestStorage(t)
	err := s.Save(`sub\file`, strings.NewReader("data"))
	if err == nil {
		t.Error(`Save('sub\file') returned nil error, want path separator error`)
	}
}

// TestSave_ResolvedPathStaysInDir verifies the stored file is actually inside
// the storage directory (defence-in-depth after sanitisation).
func TestSave_ResolvedPathStaysInDir(t *testing.T) {
	dir := t.TempDir()
	s, _ := storage.New(dir, 10)

	filename := "valid-file.dat"
	if err := s.Save(filename, strings.NewReader("content")); err != nil {
		t.Fatalf("Save: %v", err)
	}

	expectedPath := filepath.Join(dir, filename)
	if _, err := os.Stat(expectedPath); errors.Is(err, os.ErrNotExist) {
		t.Errorf("expected file at %s but it was not found", expectedPath)
	}
}

// TestDelete_ValidUUID verifies that a saved file can be deleted by its UUID.
func TestDelete_ValidUUID(t *testing.T) {
	s := newTestStorage(t)
	if err := s.Save("abc123", strings.NewReader("data")); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := s.Delete("abc123"); err != nil {
		t.Errorf("Delete valid uuid: unexpected error: %v", err)
	}
}

// TestDelete_PathTraversal rejects path-traversal filenames.
func TestDelete_PathTraversal(t *testing.T) {
	s := newTestStorage(t)
	err := s.Delete("../../sensitive")
	if err == nil {
		t.Error("Delete('../../sensitive') returned nil error, want path traversal error")
	}
}

// TestDelete_DotDot rejects "..".
func TestDelete_DotDot(t *testing.T) {
	s := newTestStorage(t)
	if err := s.Delete(".."); err == nil {
		t.Error("Delete('..') returned nil error, want error")
	}
}

// TestDelete_EmptyFilename rejects an empty string.
func TestDelete_EmptyFilename(t *testing.T) {
	s := newTestStorage(t)
	if err := s.Delete(""); err == nil {
		t.Error("Delete('') returned nil error, want error")
	}
}

// TestDelete_DotPrefixFilename rejects filenames starting with ".".
func TestDelete_DotPrefixFilename(t *testing.T) {
	s := newTestStorage(t)
	if err := s.Delete(".hidden"); err == nil {
		t.Error("Delete('.hidden') returned nil error, want error")
	}
}

// TestOpen_ValidUUID verifies that a saved file can be opened and read back.
func TestOpen_ValidUUID(t *testing.T) {
	s := newTestStorage(t)
	content := "hello storage"
	if err := s.Save("myfile", strings.NewReader(content)); err != nil {
		t.Fatalf("Save: %v", err)
	}

	f, err := s.Open("myfile")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer f.Close() //nolint:errcheck

	got, err := io.ReadAll(f)
	if err != nil {
		t.Fatalf("reading opened file: %v", err)
	}
	if string(got) != content {
		t.Errorf("content = %q, want %q", got, content)
	}
}

// TestOpen_PathTraversal rejects path-traversal filenames.
func TestOpen_PathTraversal(t *testing.T) {
	s := newTestStorage(t)
	_, err := s.Open("../../etc/passwd")
	if err == nil {
		t.Error("Open('../../etc/passwd') returned nil error, want path traversal error")
	}
}

// TestOpen_DotDot rejects "..".
func TestOpen_DotDot(t *testing.T) {
	s := newTestStorage(t)
	if _, err := s.Open(".."); err == nil {
		t.Error("Open('..') returned nil error, want error")
	}
}

// TestOpen_EmptyFilename rejects an empty string.
func TestOpen_EmptyFilename(t *testing.T) {
	s := newTestStorage(t)
	if _, err := s.Open(""); err == nil {
		t.Error("Open('') returned nil error, want error")
	}
}

// TestOpen_DotPrefixFilename rejects filenames starting with ".".
func TestOpen_DotPrefixFilename(t *testing.T) {
	s := newTestStorage(t)
	if _, err := s.Open(".env"); err == nil {
		t.Error("Open('.env') returned nil error, want error")
	}
}

// TestOpen_ForwardSlashRejected rejects filenames containing a forward slash.
func TestOpen_ForwardSlashRejected(t *testing.T) {
	s := newTestStorage(t)
	if _, err := s.Open("dir/file"); err == nil {
		t.Error("Open('dir/file') returned nil error, want path separator error")
	}
}

// TestSave_RoundTrip confirms data integrity through Save then Open.
func TestSave_RoundTrip(t *testing.T) {
	s := newTestStorage(t)
	payload := bytes.Repeat([]byte("abcdef"), 1000) // 6 KB
	if err := s.Save("roundtrip", bytes.NewReader(payload)); err != nil {
		t.Fatalf("Save: %v", err)
	}

	f, err := s.Open("roundtrip")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer f.Close() //nolint:errcheck

	got, _ := io.ReadAll(f)
	if !bytes.Equal(got, payload) {
		t.Errorf("round-trip data mismatch: got %d bytes, want %d", len(got), len(payload))
	}
}

// ─── 4.2: Magic byte validation ───────────────────────────────────────────────

// TestValidateFileType_AllowsNormalContent verifies that plain file content passes.
func TestValidateFileType_AllowsNormalContent(t *testing.T) {
	cases := []struct {
		name   string
		header []byte
	}{
		{"PNG", []byte("\x89PNG\r\n\x1a\n")},
		{"JPEG", []byte("\xff\xd8\xff\xe0")},
		{"GIF87", []byte("GIF87a")},
		{"GIF89", []byte("GIF89a")},
		{"PDF", []byte("%PDF-1.4")},
		{"ZIP", []byte("PK\x03\x04")},
		{"plaintext", []byte("Hello world")},
		{"empty", []byte{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := storage.ValidateFileType(tc.header)
			if err != nil {
				t.Errorf("ValidateFileType(%q) = %v, want nil", tc.name, err)
			}
		})
	}
}

// TestValidateFileType_BlocksPEExecutable verifies Windows .exe files are rejected.
func TestValidateFileType_BlocksPEExecutable(t *testing.T) {
	header := []byte("MZP\x00\x02\x00\x00\x00") // PE magic "MZ"
	err := storage.ValidateFileType(header)
	if err == nil {
		t.Error("ValidateFileType(PE header) = nil, want error")
	}
}

// TestValidateFileType_BlocksELFBinary verifies Linux ELF binaries are rejected.
func TestValidateFileType_BlocksELFBinary(t *testing.T) {
	header := []byte("\x7fELF\x02\x01\x01\x00")
	err := storage.ValidateFileType(header)
	if err == nil {
		t.Error("ValidateFileType(ELF header) = nil, want error")
	}
}

// TestValidateFileType_BlocksMachO64 verifies macOS 64-bit Mach-O binaries are rejected.
func TestValidateFileType_BlocksMachO64(t *testing.T) {
	header := []byte("\xcf\xfa\xed\xfe\x07\x00\x00\x01")
	err := storage.ValidateFileType(header)
	if err == nil {
		t.Error("ValidateFileType(Mach-O 64 header) = nil, want error")
	}
}

// TestValidateFileType_BlocksMachO32 verifies macOS 32-bit Mach-O binaries are rejected.
func TestValidateFileType_BlocksMachO32(t *testing.T) {
	header := []byte("\xce\xfa\xed\xfe\x07\x00\x00\x01")
	err := storage.ValidateFileType(header)
	if err == nil {
		t.Error("ValidateFileType(Mach-O 32 header) = nil, want error")
	}
}

// TestValidateFileType_BlocksShellScript verifies shebang scripts are rejected.
func TestValidateFileType_BlocksShellScript(t *testing.T) {
	cases := []struct {
		name   string
		header []byte
	}{
		{"bash", []byte("#!/bin/bash\necho hi")},
		{"sh", []byte("#!/bin/sh\necho hi")},
		{"python", []byte("#!/usr/bin/env python3\nprint('x')")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := storage.ValidateFileType(tc.header)
			if err == nil {
				t.Errorf("ValidateFileType(script %q) = nil, want error", tc.name)
			}
		})
	}
}

// TestValidateFileType_ErrorMessageContainsFormat verifies the error names the blocked type.
func TestValidateFileType_ErrorMessageContainsFormat(t *testing.T) {
	header := []byte("MZ\x90\x00") // PE executable
	err := storage.ValidateFileType(header)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "PE executable") {
		t.Errorf("error message %q does not mention 'PE executable'", err.Error())
	}
}

// TestSave_BlocksExecutable verifies Save rejects PE executable content.
func TestSave_BlocksExecutable(t *testing.T) {
	s := newTestStorage(t)
	// Construct content with PE magic followed by padding.
	content := append([]byte("MZ"), bytes.Repeat([]byte{0x00}, 100)...)
	err := s.Save("malware.exe", bytes.NewReader(content))
	if err == nil {
		t.Error("Save(PE executable) = nil, want error")
	}
}

// TestSave_BlocksELF verifies Save rejects ELF binary content.
func TestSave_BlocksELF(t *testing.T) {
	s := newTestStorage(t)
	content := append([]byte("\x7fELF"), bytes.Repeat([]byte{0x00}, 100)...)
	err := s.Save("linux-binary", bytes.NewReader(content))
	if err == nil {
		t.Error("Save(ELF binary) = nil, want error")
	}
}

// TestSave_BlocksShellScript verifies Save rejects script content.
func TestSave_BlocksShellScript(t *testing.T) {
	s := newTestStorage(t)
	content := []byte("#!/bin/bash\nrm -rf /\n")
	err := s.Save("nasty.sh", bytes.NewReader(content))
	if err == nil {
		t.Error("Save(shell script) = nil, want error")
	}
}

// TestSave_AllowsPNG verifies Save still accepts legitimate image content after magic check.
func TestSave_AllowsPNG(t *testing.T) {
	s := newTestStorage(t)
	content := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x00}, 100)...)
	err := s.Save("image.png", bytes.NewReader(content))
	if err != nil {
		t.Errorf("Save(PNG) = %v, want nil", err)
	}
}

// TestSave_EmptyFileAllowed verifies that an empty file (no content) is accepted.
func TestSave_EmptyFileAllowed(t *testing.T) {
	s := newTestStorage(t)
	err := s.Save("empty-file", bytes.NewReader([]byte{}))
	if err != nil {
		t.Errorf("Save(empty) = %v, want nil", err)
	}
}
