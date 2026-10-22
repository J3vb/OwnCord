package service

// thread_patch.go - the validation steps of ThreadService.Update.

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// cleanThreadPatch validates the name and period of an update and builds the
// patch from them; the tag step needs the thread and is postTagsPatch.
func cleanThreadPatch(p UpdateThreadParams) (db.ThreadPatch, error) {
	patch := db.ThreadPatch{Archived: p.Archived, Locked: p.Locked}
	if p.Name != nil {
		name, err := cleanThreadName(*p.Name)
		if err != nil {
			return patch, err
		}
		patch.Name = &name
	}
	if p.AutoArchiveMinutes != nil {
		minutes, err := validAutoArchive(*p.AutoArchiveMinutes)
		if err != nil || *p.AutoArchiveMinutes == 0 {
			return patch, fmt.Errorf("%w: auto_archive_minutes must be one of %v", ErrBadRequest, db.ThreadAutoArchiveMinutes)
		}
		patch.AutoArchiveMinutes = &minutes
	}
	return patch, nil
}

// postTagsPatch is the tag step of an update: nil when the update carries no
// tags, else the validated set.
func (s *ThreadService) postTagsPatch(ctx context.Context, cur *db.ThreadInfo, in *[]int64) (*[]int64, error) {
	if in == nil {
		return nil, nil
	}
	ids, err := s.postTags(ctx, cur, *in)
	if err != nil {
		return nil, err
	}
	return &ids, nil
}
