package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/telemetry"
)

// Group DM icon. The upload itself is the API layer's job; this
// is the membership gate before it and the one-transaction write after it.

// AuthorizeGroupIcon is the gate an icon change starts with, run before any
// bytes are read or stored: the caller is a member (anyone else learns
// nothing: not found), is not timed out, and the channel is a group (a 1:1
// answers 400).
func (s *DMService) AuthorizeGroupIcon(ctx context.Context, userID, channelID int64) error {
	return s.requireGroupActor(ctx, userID, channelID)
}

// SetGroupIcon points a group DM's icon at the attachment iconID (nil clears
// it) on behalf of a member, and writes one group_icon row in the same
// transaction. Clearing a group that has no icon writes no row and returns
// none. A caller who stopped being a member since AuthorizeGroupIcon is a
// not found and nothing is written; the caller then drops the file it stored.
// The last committed change wins: each call replaces whatever icon the group
// has when its transaction runs.
func (s *DMService) SetGroupIcon(ctx context.Context, userID, channelID int64, iconID *string) (*GroupChangeResult, error) {
	ctx, done := traceCall(ctx, "service/dm", "DMService.SetGroupIcon",
		telemetry.Int64("user_id", userID),
		telemetry.Int64("channel_id", channelID),
	)
	defer done()

	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	// Re-checked here: the upload between AuthorizeGroupIcon and this write is
	// long enough for a timeout to land.
	if err := requireNotTimedOut(ctx, s.perms, userID); err != nil {
		return nil, err
	}
	actor, _ := s.st.GetUserByID(ctx, userID) //nolint:errcheck // a failed lookup only changes the fallback text
	change, err := s.st.SetGroupDMIcon(ctx, channelID, userID, iconID, groupIconContent(actor, iconID == nil))
	if err != nil {
		return nil, mapGroupDBError("failed to set group icon", err)
	}
	// Committed: the reads below must not fail because the client hung up.
	ctx = context.WithoutCancel(ctx)
	return &GroupChangeResult{Rows: s.groupRows(ctx, change.Rows), Audience: change.MemberIDs}, nil
}
