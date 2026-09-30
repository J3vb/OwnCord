package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// The upload route refuses a file by its name under the owner's file-type
// policy, with the existing blocked-file-type refusal, before any byte lands.

func fileTypeHarness(t *testing.T, policy storage.FileTypePolicy) *quotaHarness {
	t.Helper()
	h := newQuotaHarness(t, nil)
	h.uploads.SetStorageLimits(service.StorageLimits{Dir: h.dir, MaxUploadBytes: 10 << 20, FileTypes: policy})
	return h
}

func assertBlocked(t *testing.T, h *quotaHarness, filename string, content []byte, detail string) {
	t.Helper()
	rr := doUpload(t, h.router, h.token, "file", filename, content)
	assertErrorCode(t, rr, http.StatusBadRequest, "BAD_REQUEST")
	if want := "upload rejected: blocked file type: " + detail; !strings.Contains(rr.Body.String(), want) {
		t.Fatalf("upload %q: body = %s, want %q", filename, rr.Body.String(), want)
	}
	if n := h.filesOnDisk(t); n != 0 {
		t.Fatalf("upload %q: %d file(s) on disk after a refusal", filename, n)
	}
}

func TestUpload_BlockedExtensionRefused(t *testing.T) {
	h := fileTypeHarness(t, storage.FileTypePolicy{Blocked: storage.DefaultBlockedExtensions})
	assertBlocked(t, h, "cleanup.BAT", []byte("@echo off\r\n"), ".bat")
	assertBlocked(t, h, "report.pdf.ps1", []byte("Get-ChildItem\n"), ".ps1")
	assertBlocked(t, h, "photo.jpg.hta", []byte("<html></html>"), ".hta")

	for _, name := range []string{"notes.txt", "www.amazon.com.txt", "notes.hta.txt"} {
		if rr := doUpload(t, h.router, h.token, "file", name, []byte("hello")); rr.Code != http.StatusCreated {
			t.Fatalf("%s: status %d, body %s", name, rr.Code, rr.Body.String())
		}
	}
}

func TestUpload_AllowOnlyMode(t *testing.T) {
	h := fileTypeHarness(t, storage.FileTypePolicy{Allowed: []string{"txt", "exe"}})
	assertBlocked(t, h, "photo.png", []byte("not really a png"), ".png")
	assertBlocked(t, h, "README", []byte("hello"), "no file extension")
	if rr := doUpload(t, h.router, h.token, "file", "notes.TXT", []byte("hello")); rr.Code != http.StatusCreated {
		t.Fatalf("notes.TXT: status %d, body %s", rr.Code, rr.Body.String())
	}
}

// An owner who allows an extension never unlocks the content blocks: a PE
// executable is refused whatever it is called.
func TestUpload_MagicBlocksApplyToAnAllowedExtension(t *testing.T) {
	h := fileTypeHarness(t, storage.FileTypePolicy{Allowed: []string{"exe", "txt"}})
	assertBlocked(t, h, "tool.exe", []byte("MZ\x90\x00\x03\x00\x00\x00"), "PE executable")
	assertBlocked(t, h, "notes.txt", []byte("#!/bin/sh\necho hi\n"), "shell script")
}

func TestUpload_SavedPolicyReplacesConfig(t *testing.T) {
	h := fileTypeHarness(t, storage.FileTypePolicy{Blocked: storage.DefaultBlockedExtensions})
	if _, err := service.NewSettingsService(h.database).Patch(context.Background(), h.userID, map[string]string{
		service.UploadBlockedExtensionsKey: "txt",
	}); err != nil {
		t.Fatalf("Patch: %v", err)
	}
	assertBlocked(t, h, "notes.txt", []byte("hello"), ".txt")
	if rr := doUpload(t, h.router, h.token, "file", "build.bat", []byte("@echo off\r\n")); rr.Code != http.StatusCreated {
		t.Fatalf("build.bat after the owner unblocked it: status %d, body %s", rr.Code, rr.Body.String())
	}
}
