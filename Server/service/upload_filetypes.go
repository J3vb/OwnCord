package service

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/storage"
)

// The settings rows the admin panel saves the upload file-type lists under,
// comma-separated. A row replaces the matching config.yaml list; until one is
// saved, config.yaml's list applies.
const (
	UploadBlockedExtensionsKey = "upload_blocked_extensions"
	UploadAllowedExtensionsKey = "upload_allowed_extensions"
)

// FileTypePolicy returns the upload file-type policy in force: each list from
// its settings row when the owner has saved one, else from config.yaml
// (StorageLimits.FileTypes).
func (s *UploadService) FileTypePolicy(ctx context.Context) (storage.FileTypePolicy, error) {
	s.quota.mu.Lock()
	p := storage.FileTypePolicy{
		Blocked: slices.Clone(s.quota.limits.FileTypes.Blocked),
		Allowed: slices.Clone(s.quota.limits.FileTypes.Allowed),
	}
	s.quota.mu.Unlock()
	for key, list := range map[string]*[]string{UploadBlockedExtensionsKey: &p.Blocked, UploadAllowedExtensionsKey: &p.Allowed} {
		value, err := s.st.GetSetting(ctx, key)
		if errors.Is(err, db.ErrNotFound) {
			continue
		}
		if err != nil {
			return storage.FileTypePolicy{}, fmt.Errorf("FileTypePolicy: %s: %w", key, err)
		}
		if *list, err = storage.ParseExtensionList(value); err != nil {
			return storage.FileTypePolicy{}, fmt.Errorf("FileTypePolicy: %s: %w", key, err)
		}
	}
	return p, nil
}
