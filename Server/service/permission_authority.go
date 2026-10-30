package service

import (
	"context"
	"fmt"
)

// overrideKey returns the channel id whose overrides govern channelID: a
// thread's parent, the channel itself otherwise. The per-user override
// map is keyed by parent channels only, so a thread id must be resolved here
// before it is looked up; an unresolved thread id would find no entry and get
// the role's base bits, which is wrong whenever the parent narrows them.
//
// A channel's parent never changes after insert (the migration 074 trigger)
// and channel ids are AUTOINCREMENT, never reused, so a resolved answer is
// cached for the life of the process. Only found channels are cached: an id
// that does not exist yet may become a thread later. Channel 0 (the
// channel-less Subject of requireNotTimedOut) is its own key without a read.
func (s *PermissionService) overrideKey(ctx context.Context, channelID int64) (int64, error) {
	if channelID == 0 {
		return 0, nil
	}
	if v, ok := s.parents.Load(channelID); ok {
		if key, isKey := v.(int64); isKey {
			return key, nil
		}
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil {
		return 0, fmt.Errorf("resolve override authority: %w", err)
	}
	if ch == nil {
		return channelID, nil
	}
	key := ch.AuthorityID()
	s.parents.Store(channelID, key)
	return key, nil
}
