package service

import (
	"context"
	"fmt"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
)

// cleanThreadPatch validates the name and period of an update and builds the patch; the tag step needs the
// thread and is postTagsPatch.
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

// postTagsPatch is the tag step of an update: nil when the update carries no tags, else the validated set.
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

// threadPatchIsNoop reports whether applying patch to cur would change nothing. Tags compare as sets.
func threadPatchIsNoop(cur *db.ThreadInfo, patch db.ThreadPatch) bool {
	switch {
	case patch.Name != nil && *patch.Name != cur.Name,
		patch.Archived != nil && *patch.Archived != cur.Archived,
		patch.Locked != nil && *patch.Locked != cur.Locked,
		patch.AutoArchiveMinutes != nil && *patch.AutoArchiveMinutes != cur.AutoArchiveMinutes:
		return false
	}
	if patch.TagIDs == nil {
		return true
	}
	if cur.Post == nil {
		return false
	}
	have := slices.Clone(cur.Post.TagIDs)
	want := slices.Clone(*patch.TagIDs)
	slices.Sort(have)
	slices.Sort(want)
	return slices.Equal(slices.Compact(have), slices.Compact(want))
}
