package service

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/storage"
)

// The upload file-type policy: config.yaml supplies both lists, and a list the
// owner saved in the admin panel replaces the config one.

func TestUploadFileTypePolicy_ConfigUntilSaved(t *testing.T) {
	uploads, database := newUploadFixture(t)
	ctx := context.Background()
	uploads.SetStorageLimits(StorageLimits{FileTypes: storage.FileTypePolicy{Blocked: []string{"bat"}, Allowed: []string{}}})

	got, err := uploads.FileTypePolicy(ctx)
	if err != nil {
		t.Fatalf("FileTypePolicy: %v", err)
	}
	if !slices.Equal(got.Blocked, []string{"bat"}) || len(got.Allowed) != 0 {
		t.Fatalf("policy = %+v, want the config lists", got)
	}

	settings := NewSettingsService(database)
	if _, err := settings.Patch(ctx, 1, map[string]string{
		UploadBlockedExtensionsKey: "",
		UploadAllowedExtensionsKey: ".PNG, pdf",
	}); err != nil {
		t.Fatalf("Patch: %v", err)
	}
	got, err = uploads.FileTypePolicy(ctx)
	if err != nil {
		t.Fatalf("FileTypePolicy: %v", err)
	}
	if len(got.Blocked) != 0 || !slices.Equal(got.Allowed, []string{"png", "pdf"}) {
		t.Fatalf("policy = %+v, want the saved lists (an empty saved list included)", got)
	}
}

func TestSettings_UploadExtensionListsNormalized(t *testing.T) {
	svc, _ := newSettingsService(t)
	all, err := svc.Patch(context.Background(), 1, map[string]string{UploadBlockedExtensionsKey: " .BAT cmd,,bat "})
	if err != nil {
		t.Fatalf("Patch: %v", err)
	}
	if got := all[UploadBlockedExtensionsKey]; got != "bat,cmd" {
		t.Errorf("stored %q, want %q", got, "bat,cmd")
	}
	_, err = svc.Patch(context.Background(), 1, map[string]string{UploadAllowedExtensionsKey: "tar.gz"})
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("Patch(tar.gz) = %v, want ErrBadRequest", err)
	}
}

func TestSettings_UploadExtensionListsAreOwnerOnly(t *testing.T) {
	for _, key := range []string{UploadBlockedExtensionsKey, UploadAllowedExtensionsKey} {
		if !IsOwnerOnlySettingKey(key) {
			t.Errorf("IsOwnerOnlySettingKey(%q) = false, want true", key)
		}
	}
}
