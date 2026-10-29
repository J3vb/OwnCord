package ws

import "context"

// readyNoticePayload is one row of ready's notices slot: an
// unacknowledged warning. Never the actor, never the report link.
type readyNoticePayload struct {
	ID        int64  `json:"id"`
	Kind      string `json:"kind"`
	Reason    string `json:"reason"`
	CreatedAt string `json:"created_at"`
}

// readyNotices resolves the connecting user's unacknowledged warnings for
// ready's notices slot, always as a non-nil (possibly empty) slice so the
// wire payload never carries a bare `null`.
func readyNotices(ctx context.Context, database ReadySnapshotReader, userID int64) ([]readyNoticePayload, error) {
	rows, err := database.ListUnacknowledgedWarnings(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]readyNoticePayload, 0, len(rows))
	for _, r := range rows {
		out = append(out, readyNoticePayload{ID: r.ID, Kind: r.Kind, Reason: r.Reason, CreatedAt: r.CreatedAt})
	}
	return out, nil
}
